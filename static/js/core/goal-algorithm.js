import { matchesCategory } from './domain.js';
import { diffMonths, fmtINR, monthKeyLabel } from './format.js';

// Adds `n` whole months to a "YYYY-MM" key, correctly handling year
// rollover in either direction. Replaces the old inline math, which
// incremented the year before correcting a `m === 0` underflow — the
// wrong order, and it silently broke for negative `n`.
function addMonthsToKey(key, n) {
  const [y, m] = key.split('-').map(Number);
  const zeroBased = (m - 1) + n;
  const newY = y + Math.floor(zeroBased / 12);
  const newM = ((zeroBased % 12) + 12) % 12 + 1;
  return `${newY}-${String(newM).padStart(2, '0')}`;
}

function classifyCategory(cat) {
  if (cat.classification) return cat.classification;
  const name = (cat.name || '').toLowerCase();
  if (name === 'sip' || name === 'investment') return 'investment';
  return cat.essential === false ? 'discretionary' : 'essential';
}

// Best-effort "room to save" for THIS month when there's no closed
// month of history yet: income logged so far, minus essential-category
// spend and committed auto-spend (EMI/SIP/investment/recurring).
// Returns null when no income is logged at all — we shouldn't guess
// feasibility from nothing.
function estimateCurrentMonthCapacity(entries, budgetData) {
  if (!entries || !entries.length) return null;

  const essentialCatNames = [];
  (budgetData || []).forEach(group => {
    (group.categories || []).forEach(cat => {
      if (classifyCategory(cat) === 'essential') essentialCatNames.push(cat.name);
    });
  });

  let income = 0, essentialSpent = 0, autoSpent = 0;
  entries.forEach(e => {
    const amt = Number(e.amount) || 0;
    if (e.type === 'income') { income += amt; return; }
    if (e.type === 'payback' || e.type === 'goal_funding') return;

    const eType = (e.type || '').toLowerCase();
    if (eType === 'emi' || eType === 'sip' || eType === 'investment' || eType === 'recurring') {
      autoSpent += amt;
      return;
    }
    if (essentialCatNames.some(name => matchesCategory(e, name, false, null))) {
      essentialSpent += amt;
    }
  });

  if (income === 0) return null;
  return Math.max(0, income - essentialSpent - autoSpent);
}

// Per-category slack (budget - spent) for one already-closed month.
// Returns [] for zero-income months — same "not a real budgeting
// month" exclusion the old code applied before aggregating.
function categorySlackForMonth(entries, budgetData) {
  const income = entries.reduce((sum, e) => e.type === 'income' ? sum + (Number(e.amount) || 0) : sum, 0);
  if (income === 0) return [];

  const rows = [];
  (budgetData || []).forEach(group => {
    (group.categories || []).forEach(cat => {
      let spent = 0;
      entries.forEach(e => {
        if (e.type === 'income' || e.type === 'payback' || e.type === 'goal_funding') return;
        if (matchesCategory(e, cat.name, false, null)) spent += (Number(e.amount) || 0);
      });
      const budget = Number(cat.budget) || 0;
      rows.push({ name: cat.name, tier: classifyCategory(cat), budget, spent, slack: Math.max(0, budget - spent) });
    });
  });
  return rows;
}

function getMedian(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Builds the unfeasible-goal alert. `sustainableRate` is null when we
// don't have enough data to judge feasibility at all — in that case we
// say nothing rather than guess.
function buildAlert(goal, remaining, mathRequired, sustainableRate, currentKey) {
  if (sustainableRate == null || sustainableRate >= mathRequired) return null;

  const newMonths = sustainableRate > 0 ? Math.ceil(remaining / sustainableRate) : null;
  const suggestedMonth = newMonths ? addMonthsToKey(currentKey, newMonths) : null;

  const message = suggestedMonth
    ? `Goal amount may be too high for ${monthKeyLabel(goal.expectedMonth)}. Consider shifting target month to ${monthKeyLabel(suggestedMonth)}.`
    : `Goal amount may be too high for ${monthKeyLabel(goal.expectedMonth)} based on your current spending capacity.`;

  return { message, suggestedMonth };
}

export function computeGoalRecommendation(goal, { monthsIndex, budgetDataByMonth, entriesByMonth, currentMonthBudgetData, currentMonthEntries }) {
  const currentKey = new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0');
  const past6 = [...monthsIndex].filter(m => m < currentKey).sort().slice(-6);

  const downpayment = goal.hasDownpayment ? (Number(goal.downpaymentAmount) || 0) : 0;
  const totalFunded = downpayment + (goal.fundingHistory || []).reduce((s, h) => s + (Number(h.amount) || 0), 0);
  const remaining = Math.max(0, goal.targetAmount - totalFunded);

  const targetGap = diffMonths(currentKey, goal.expectedMonth);
  const monthsRemaining = Math.max(1, targetGap);
  const mathRequired = remaining / monthsRemaining;

  if (remaining <= 0) {
    return {
      suggestedMonthlyContribution: 0, breakdown: [], projectedCompletionMonth: goal.expectedMonth,
      status: 'completed', gapMonths: targetGap, tier: 'completed',
      explanation: 'Target fully funded — no further monthly contribution is needed.', alert: null
    };
  }

  // Closed-month history, per category, zero-income months dropped —
  // shared source data for both the single-month and multi-month tiers.
  const monthlyCategoryData = past6
    .map(mk => categorySlackForMonth(entriesByMonth[mk] || [], budgetDataByMonth[mk] || []))
    .filter(rows => rows.length > 0);

  let suggested = 0, explanation = '', status = 'on-track', breakdown = [], sustainableRate = null, tier;

  if (monthlyCategoryData.length === 0) {
    // --- Tier 1: no history — plain timeline division, feasibility
    // judged off this month's logged income/essential/auto spend. ---
    tier = 'no-history';
    suggested = mathRequired;
    sustainableRate = estimateCurrentMonthCapacity(currentMonthEntries, currentMonthBudgetData);
    explanation = `We don't have any closed months of budgeting history yet, so this is pure timeline math: `
      + `${fmtINR(remaining)} remaining ÷ ${monthsRemaining} month${monthsRemaining === 1 ? '' : 's'} left `
      + `(target: ${goal.expectedMonth}) = ${fmtINR(mathRequired)}/month needed to stay on schedule.`;

  } else if (monthlyCategoryData.length === 1) {
    // --- Tier 2: one closed month — divert a percentage of THAT
    // month's actual per-category slack. Essentials stay protected;
    // Discretionary is tapped before Investment (optionals >=
    // investments), and only a capped Essential slice is a last resort. ---
    tier = 'single-month';
    const rows = monthlyCategoryData[0];
    const DISC_CAP = 0.7, INVEST_CAP = 0.5, ESSENTIAL_CAP = 0.5;

    let need = mathRequired;
    const allocate = (tierName, cap, label) => {
      rows.filter(r => r.tier === tierName && r.slack > 0)
        .sort((a, b) => b.slack - a.slack)
        .forEach(cat => {
          if (need <= 0) return;
          const take = Math.min(cat.slack * cap, need);
          if (take <= 0.5) return;
          const pct = Math.round((take / cat.slack) * 100);
          breakdown.push({ source: `${cat.name} (${label}) — ${pct}% of slack`, amount: take, pct });
          suggested += take;
          need -= take;
        });
    };
    allocate('discretionary', DISC_CAP, 'Optional');
    allocate('investment', INVEST_CAP, 'Investment');

    if (need > 0) {
      const essentialSlack = rows.filter(r => r.tier === 'essential').reduce((s, r) => s + r.slack, 0);
      const take = Math.min(essentialSlack * ESSENTIAL_CAP, need);
      if (take > 0.5) {
        breakdown.push({ source: 'Essential Slack (Capped 50%)', amount: take });
        suggested += take;
        need -= take;
      }
    }

    sustainableRate = suggested;
    const monthsLabel = 'your 1 logged month';
    if (suggested < mathRequired) {
      status = 'needs-more-funding';
      explanation = breakdown.length
        ? `Based on ${monthsLabel}, diverting a portion of ${breakdown.map(b => b.source.split(' —')[0]).join(', ')} sustainably supports ${fmtINR(suggested)}/month — short of the ${fmtINR(mathRequired)}/month needed. This is a preliminary estimate and will sharpen as more months are logged.`
        : `Based on ${monthsLabel}, there isn't enough spare slack in your Optional or Investment categories yet to meaningfully contribute.`;
    } else {
      explanation = `Based on ${monthsLabel}, diverting the percentages above sustainably covers the ${fmtINR(mathRequired)}/month your timeline needs. This is a preliminary estimate from a single month — it'll get more reliable as you log more.`;
    }

  } else {
    // --- Tier 3: 2–6 closed months — median slack per tier, same
    // Discretionary → Investment → capped-Essential priority order. ---
    tier = 'multi-month';
    const slackHistory = { investment: [], discretionary: [], necessary: [] };
    monthlyCategoryData.forEach(rows => rows.forEach(r => {
      const key = r.tier === 'investment' ? 'investment' : (r.tier === 'discretionary' ? 'discretionary' : 'necessary');
      slackHistory[key].push(r.slack);
    }));

    const medDisc = getMedian(slackHistory.discretionary);
    const medInvest = getMedian(slackHistory.investment);
    const cappedNec = getMedian(slackHistory.necessary) * 0.5;

    let need = mathRequired;
    const useDisc = Math.min(medDisc, need); need -= useDisc;
    const useInvest = Math.min(medInvest, need); need -= useInvest;
    const useNec = Math.min(cappedNec, need); need -= useNec;

    suggested = useDisc + useInvest + useNec;
    sustainableRate = suggested;

    breakdown = [
      { source: 'Discretionary Slack', amount: useDisc },
      { source: 'Investment Budgets', amount: useInvest },
      { source: 'Essential Slack (Capped 50%)', amount: useNec }
    ].filter(b => b.amount > 0);

    const parts = breakdown.map(b => `${fmtINR(b.amount)} from ${b.source}`);
    const sourceText = parts.length ? parts.join(', then ') : 'no historical slack';
    const monthsLabel = `your last ${monthlyCategoryData.length} logged month${monthlyCategoryData.length === 1 ? '' : 's'}`;

    if (suggested < mathRequired) {
      status = 'needs-more-funding';
      explanation = `Based on ${monthsLabel}, pulling ${sourceText} — in that priority order — sustainably supports `
        + `${fmtINR(suggested)}/month, short of the ${fmtINR(mathRequired)}/month your ${monthsRemaining}-month timeline actually needs.`;
    } else if (suggested >= mathRequired * 1.2) {
      status = 'ahead';
      explanation = `Based on ${monthsLabel}, pulling ${sourceText} — in that priority order — supports `
        + `${fmtINR(suggested)}/month, comfortably above the ${fmtINR(mathRequired)}/month required, so you're on pace to finish ahead of schedule.`;
    } else {
      explanation = `Based on ${monthsLabel}, pulling ${sourceText} — in that priority order — sustainably covers the ${fmtINR(mathRequired)}/month your timeline needs.`;
    }
  }

  const alert = buildAlert(goal, remaining, mathRequired, sustainableRate, currentKey);
  if (alert) status = 'unfeasible';

  let projectedCompletionMonth = goal.expectedMonth;
  if (suggested > 0) {
    const monthsToFinish = Math.ceil(remaining / suggested);
    projectedCompletionMonth = addMonthsToKey(currentKey, monthsToFinish);
  }

  return {
    suggestedMonthlyContribution: suggested > 0 ? suggested : 0,
    breakdown, projectedCompletionMonth, status, gapMonths: targetGap, tier, explanation, alert
  };
}
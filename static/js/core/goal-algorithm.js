import { matchesCategory } from './domain.js';
import { diffMonths, fmtINR } from './format.js';

export function computeGoalRecommendation(goal, { monthsIndex, budgetDataByMonth, entriesByMonth }) {
  const currentKey = new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0');
  const past6 = [...monthsIndex].filter(m => m < currentKey).sort().slice(-6);
  
  const slackHistory = { investment: [], discretionary: [], necessary: [] };
  
  for (const mk of past6) {
    const entries = entriesByMonth[mk] || [];
    const budgetData = budgetDataByMonth[mk] || [];
    
    const income = entries.reduce((sum, e) => e.type === 'income' ? sum + (Number(e.amount) || 0) : sum, 0);
    if (income === 0) continue; // Exclude zero-income months
    
    budgetData.forEach(group => {
      (group.categories || []).forEach(cat => {
        let spent = 0;
        entries.forEach(e => {
          if (e.type === 'income' || e.type === 'payback' || e.type === 'goal_funding') return;
          if (matchesCategory(e, cat.name, false, null)) {
            spent += (Number(e.amount) || 0);
          }
        });
        
        const budget = Number(cat.budget) || 0;
        const slack = Math.max(0, budget - spent);
        
        const classification = cat.classification
          || (cat.name.toLowerCase() === 'sip' || cat.name.toLowerCase() === 'investment' ? 'investment'
              : (cat.essential === false ? 'discretionary' : 'essential'));

        const tier = classification === 'investment' ? 'investment' : (classification === 'discretionary' ? 'discretionary' : 'necessary');
        slackHistory[tier].push(slack);
      });
    });
  }
  
  const getMedian = (arr) => {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  
  const medInvest = getMedian(slackHistory.investment);
  const medDisc = getMedian(slackHistory.discretionary);
  const medNec = getMedian(slackHistory.necessary);
  
  // Necessary slack capped at 50% of median to remain conservative
  const cappedNec = medNec * 0.5;
  
  const sustainableSlack = medInvest + medDisc + cappedNec;
  
  const downpayment = goal.hasDownpayment ? (Number(goal.downpaymentAmount) || 0) : 0;
  const totalFunded = downpayment + (goal.fundingHistory || []).reduce((s, h) => s + (Number(h.amount) || 0), 0);
  const remaining = Math.max(0, goal.targetAmount - totalFunded);
  
  const targetGap = diffMonths(currentKey, goal.expectedMonth);
  const monthsRemaining = Math.max(1, targetGap);
  const mathRequired = remaining / monthsRemaining;
  
  let suggested = 0;
  let explanation = '';
  let status = 'on-track';
  let useInvest = 0, useDisc = 0, useNec = 0;
  
  if (remaining <= 0) {
    status = 'completed';
    suggested = 0;
    explanation = 'Target fully funded — no further monthly contribution is needed.';
  } else if (past6.length === 0) {
    // Not enough logged history to look at spending slack yet, so fall
    // back to a plain division of what's left by the months remaining.
    suggested = mathRequired;
    explanation = `We don't have 6 months of budgeting history yet, so this is pure timeline math: `
      + `${fmtINR(remaining)} remaining ÷ ${monthsRemaining} month${monthsRemaining === 1 ? '' : 's'} left `
      + `(target: ${goal.expectedMonth}) = ${fmtINR(mathRequired)}/month needed to stay on schedule.`;
  } else {
    // Strict priority hierarchy: pull from Investment slack first,
    // Discretionary slack second, and only reach into the capped
    // Essential slack when the first two tiers can't cover the need.
    let remainingNeed = mathRequired;
    useInvest = Math.min(medInvest, remainingNeed);
    remainingNeed -= useInvest;
    useDisc = Math.min(medDisc, remainingNeed);
    remainingNeed -= useDisc;
    useNec = Math.min(cappedNec, remainingNeed);
    remainingNeed -= useNec;

    suggested = useInvest + useDisc + useNec;

    const parts = [];
    if (useInvest > 0) parts.push(`${fmtINR(useInvest)} from Investment slack`);
    if (useDisc > 0) parts.push(`${fmtINR(useDisc)} from Discretionary slack`);
    if (useNec > 0) parts.push(`${fmtINR(useNec)} from Essential slack (capped at 50% of its median to stay safe)`);
    const sourceText = parts.length ? parts.join(', then ') : 'no historical slack';
    const monthsLabel = `your last ${past6.length} logged month${past6.length === 1 ? '' : 's'}`;

    if (suggested < mathRequired) {
      status = 'needs-more-funding';
      explanation = `Based on ${monthsLabel}, pulling ${sourceText} — in that priority order — sustainably supports `
        + `${fmtINR(suggested)}/month, short of the ${fmtINR(mathRequired)}/month your ${monthsRemaining}-month timeline `
        + `actually needs. Consider pushing out the target date or trimming essential spend.`;
    } else if (suggested >= mathRequired * 1.2) {
      status = 'ahead';
      explanation = `Based on ${monthsLabel}, pulling ${sourceText} — in that priority order — supports `
        + `${fmtINR(suggested)}/month, comfortably above the ${fmtINR(mathRequired)}/month required, so you're on pace `
        + `to finish ahead of schedule.`;
    } else {
      explanation = `Based on ${monthsLabel}, pulling ${sourceText} — in that priority order — sustainably covers the `
        + `${fmtINR(mathRequired)}/month your timeline needs.`;
    }
  }
  
  const breakdown = [
    { source: 'Investment Budgets', amount: useInvest },
    { source: 'Discretionary Slack', amount: useDisc },
    { source: 'Essential Slack (Capped 50%)', amount: useNec }
  ].filter(b => b.amount > 0);
  
  let projectedCompletionMonth = goal.expectedMonth;
  if (suggested > 0) {
    const monthsToFinish = Math.ceil(remaining / suggested);
    // Simple projection via diffMonths reverse logic is complex, just estimate:
    let [y, m] = currentKey.split('-').map(Number);
    m += monthsToFinish;
    y += Math.floor(m / 12);
    m = m % 12;
    if (m === 0) { m = 12; y -= 1; }
    projectedCompletionMonth = `${y}-${String(m).padStart(2, '0')}`;
  }
  
  return {
    suggestedMonthlyContribution: suggested > 0 ? suggested : 0,
    breakdown,
    projectedCompletionMonth,
    status,
    gapMonths: targetGap,
    explanation
  };
}
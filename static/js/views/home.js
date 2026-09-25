/* ---------- /home ----------
   Only fetches cards/EMI/SIP/months-index/existing-investments — never
   touches split groups or price-tracker items. Domain data is fetched once
   per page load and cached in `cache`; a range-toggle click only re-slices
   the already-computed daily balance series and re-renders from memory —
   it never re-hits the network. */
import { Store } from '../core/store.js';
import { fmtINR, currentMonthKey, monthKeyLabel, todayStr, addMonths, diffMonths } from '../core/format.js';
import { authReady } from '../core/auth.js';
import { computeGlobalStats, computeMonthTotals, monthCashOutflow, emiRowsForMonth, sipRowsForMonth, recurringRowsForMonth, loadMonth, computeDailyBalanceSeries, windowSeries, migrateBudgetData, creditCardCycleLedger, creditCardCurrentStatementMonthKey } from '../core/domain.js';
import { renderDashboardKpis } from '../components/dashboard-kpis.js';
import { analyzeDashboardBudget } from '../core/budget-insights.js';
import { renderMoneyInbox, renderUpcomingSpends } from '../components/dashboard-attention.js';
import { renderDashboardBudget } from '../components/dashboard-budget.js';
import { renderDashboardCards } from '../components/dashboard-cards.js';
import {
  renderDashboardGoals,
  renderDashboardPeopleBalances,
  renderDashboardSharedExpenses,
  renderDashboardPrices,
  renderDashboardSipInvestments,
} from '../components/dashboard-secondary.js';
import { renderDashboardCashflowChart, renderMonthEndProjection } from '../components/dashboard-finance-overview.js';
import { dailyBalanceChart, wireChartTooltips } from '../components/charts/line-chart.js';
import { setupTableScrollIndicators } from '../components/scroll-wrapper.js';
import { appendPageChrome } from '../components/page-chrome.js';
import { markRendered } from '../components/render-guard.js';
import {
  SPLIT_YOU,
  loadAllSplitGroups,
  computeGroupSettlementView,
} from '../core/split-domain.js';

const root = document.getElementById('home-root');
root.classList.add('home-view');
let balanceChartRange = 1;
let dashboardChartMode = 'balance';
let cache = null; // Domain data + dashboard snapshots for KPIs, obligations, budgets, cards, goals, splits, prices and charts

async function loadDomain() {
  const budgetKey = `budget-data:${currentMonthKey()}`;

  const [cards, emiSeries, sipSeries, monthsIndex, splitsIndex, existingInvestments, recurringSeries, storedBudgetData, legacyBudgetData, goals, priceItems] = await Promise.all([
    Store.get('creditcards', []),
    Store.get('emiseries', []),
    Store.get('sipseries', []),
    Store.get('months-index', []),
    Store.get('splits-index', []),
    Store.get('existinginvestments', 0),
    Store.get('recurringseries', []),
    Store.get(budgetKey, null),
    Store.get('budget-data', null),
    Store.get('goals', []),
    Store.get('price-items', []),
  ]);

  // PRE-WARM CACHE: Perform a single bulk fetch to grab all historical months and splits.
  // This completely eliminates the N+1 API queries when domain functions later call Store.get().
  const keysToBulkFetch = [];
  if (monthsIndex && monthsIndex.length > 0) {
    keysToBulkFetch.push(...monthsIndex.map(k => 'month:' + k));
  }
  if (splitsIndex && splitsIndex.length > 0) {
    keysToBulkFetch.push(...splitsIndex.map(id => 'split:' + id));
  }
  if (keysToBulkFetch.length > 0 && typeof Store.bulkGet === 'function') {
    await Store.bulkGet(keysToBulkFetch);
  }

  const budgetData = migrateBudgetData(storedBudgetData !== null ? storedBudgetData : (legacyBudgetData || []));

  return { cards, emiSeries, sipSeries, monthsIndex, splitsIndex, existingInvestments, recurringSeries, budgetData, goals, priceItems };
}

function emptyDashboardMonth() {
  return { startingBalanceMode: 'auto', startingBalance: 0, entries: [], deletedEmi: [], deletedSip: [], deletedRecurring: [], sipOverrides: {}, recurringOverrides: {} };
}

async function dashboardMonthData(domain, monthKey) {
  return domain.monthsIndex.includes(monthKey) ? await loadMonth(monthKey) : emptyDashboardMonth();
}

function dashboardDateFromMonthDay(monthKey, rawDay) {
  const [year, month] = monthKey.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const day = Math.min(Math.max(Number(rawDay) || 1, 1), daysInMonth);
  return `${monthKey}-${String(day).padStart(2, '0')}`;
}

function addDashboardDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00`);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dashboardDaysBetween(fromDate, toDate) {
  const start = new Date(`${fromDate}T00:00:00`);
  const end = new Date(`${toDate}T00:00:00`);
  return Math.round((end - start) / 86400000);
}

function dashboardDaysLeftInMonth(monthKey, asOfDate = todayStr()) {
  const [year, month] = monthKey.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();

  if (asOfDate.slice(0, 7) !== monthKey) return null;

  return Math.max(
    0,
    daysInMonth - Number(asOfDate.slice(8, 10))
  );
}

function nextDashboardDueDate(rawDueDay, asOfDate = todayStr()) {
  let monthKey = asOfDate.slice(0, 7);
  let candidate = dashboardDateFromMonthDay(monthKey, rawDueDay);

  if (candidate < asOfDate) {
    monthKey = addMonths(monthKey, 1);
    candidate = dashboardDateFromMonthDay(monthKey, rawDueDay);
  }

  return candidate;
}

async function buildCurrentMonthDashboardMetrics(domain, stats) {
  const key = currentMonthKey();
  const today = todayStr();
  const hasCurrentMonth = domain.monthsIndex.includes(key);

  const data = await dashboardMonthData(domain, key);

  const emiRows = emiRowsForMonth(domain.emiSeries, key, data.deletedEmi);
  const sipRows = sipRowsForMonth(domain.sipSeries, key, data.deletedSip, data.sipOverrides);
  const recurringRows = recurringRowsForMonth(domain.recurringSeries, key, data.deletedRecurring, data.recurringOverrides);
  const scheduledRows = [...emiRows, ...sipRows, ...recurringRows];

  const postedManualRows = hasCurrentMonth ? (data.entries || []).filter(row => !row.date || row.date <= today) : [];
  const postedScheduledRows = hasCurrentMonth ? scheduledRows.filter(row => !row.date || row.date <= today) : [];
  const remainingScheduledRows = scheduledRows.filter(row => row.date && row.date > today);

  const postedTotals = computeMonthTotals([...postedManualRows, ...postedScheduledRows]);
  const remainingTotals = computeMonthTotals(remainingScheduledRows);

  const pendingCashBreakdown = remainingScheduledRows.reduce((breakdown, row) => {
    const amount = Number(row.amount) || 0;

    if (row.type === 'emi') breakdown.emi += amount;
    if (row.type === 'sip') breakdown.sip += amount;
    if (row.type === 'recurring' && row.paymentMode !== 'card') breakdown.recurring += amount;

    return breakdown;
  }, { emi: 0, sip: 0, recurring: 0 });

  const previousBreakdown = stats.breakdown
    .filter(row => row.monthKey < key)
    .sort((a, b) => a.monthKey.localeCompare(b.monthKey))
    .at(-1);

  const startingBalance =
    data.startingBalanceMode === 'auto' && previousBreakdown
      ? Number(previousBreakdown.ending) || 0
      : Number(data.startingBalance) || 0;

  const availableBalance =
    startingBalance +
    postedTotals.income -
    monthCashOutflow(postedTotals);
  const pendingCashCommitments = monthCashOutflow(remainingTotals);
  const monthEndProjection = availableBalance - pendingCashCommitments;
  const asOfLabel = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

  return {
    monthKey: key,
    hasCurrentMonth,
    entryCount: postedManualRows.length + postedScheduledRows.length,

    income: postedTotals.income,
    spentThisMonth: postedTotals.totalConsumption,
    investmentsThisMonth: postedTotals.invest + postedTotals.sip,
    availableBalance,
    pendingCashCommitments,
    pendingCashBreakdown,
    monthEndProjection,
    asOfLabel,
  };
}

async function buildDashboardSharedExpenses(domain) {
  const groups = await loadAllSplitGroups(domain.splitsIndex || []);
  const activity = [];

  const owedToYouByPerson = new Map();
  const owedByYouByPerson = new Map();

  let owedByYou = 0;
  let owedToYou = 0;
  let lentCount = 0;

  const addPersonAmount = (bucket, person, amount) => {
    const safeAmount = Number(amount) || 0;
    if (safeAmount <= 0) return;

    const label = String(person || 'Unknown').trim() || 'Unknown';
    const key = label.toLocaleLowerCase('en-IN');

    const existing = bucket.get(key) || {
      person: label,
      amount: 0,
    };

    existing.amount += safeAmount;
    bucket.set(key, existing);
  };

  /* ---------- Split Money outstanding settlement shares ---------- */

  for (const group of groups) {
    const settlementView = computeGroupSettlementView(group);

    for (const card of (settlementView.cards || [])) {
      if (card.settled) continue;

      const amount = Number(card.amount) || 0;

      if (card.from === SPLIT_YOU) {
        owedByYou += amount;
        addPersonAmount(owedByYouByPerson, card.to, amount);
      }

      if (card.to === SPLIT_YOU) {
        owedToYou += amount;
        addPersonAmount(owedToYouByPerson, card.from, amount);
      }
    }

    for (const spend of (group.spends || [])) {
      const amount = Number(spend.amount) || 0;
      const yourShare = Number(spend.shares?.[SPLIT_YOU]) || 0;

      activity.push({
        id: `split-${spend.id}`,
        source: 'split',
        groupId: group.id,
        groupName: group.description || 'Shared expense',
        description: spend.description || 'Shared spend',
        date: spend.date || group.createdAt || '',
        amount,
        yourShare,
        paidByYou: spend.payee === SPLIT_YOU,
        payee: spend.payee || '',
      });
    }
  }

  /* ---------- Month-ledger lending ---------- */

  for (const monthKey of (domain.monthsIndex || [])) {
    const data = await loadMonth(monthKey);

    for (const entry of (data.entries || [])) {
      const entryType = String(entry.type || '').toLowerCase();

      /*
       * Standalone "Add lent" entries use type === 'owed'.
       * `description` contains the person's name.
       */
      if (entryType === 'owed') {
        const amount = Number(entry.amount) || 0;
        if (amount <= 0) continue;

        const settled = entry.settled === true;
        const person = entry.description || 'Unknown';

        lentCount += 1;

        if (!settled) {
          owedToYou += amount;
          addPersonAmount(owedToYouByPerson, person, amount);
        }

        activity.push({
          id: `owed-${monthKey}-${entry.id}`,
          source: 'owed',
          monthKey,
          entryId: entry.id,
          description: entry.meta?.purpose || 'Money lent',
          date: entry.date || `${monthKey}-01`,
          amount,
          person,
          settled,
          entryType,
        });

        continue;
      }

      /*
       * Expense/card/cash entries may contain one or more `lent` chips.
       */
      if (!['spend', 'cardcharge', 'cashpayment'].includes(entryType)) continue;
      if (!Array.isArray(entry.lent) || !entry.lent.length) continue;

      for (const lent of entry.lent) {
        const amount = Number(lent.amount) || 0;
        if (amount <= 0) continue;

        const settled = lent.settled === true;
        const person = lent.person || 'Unknown';

        lentCount += 1;

        if (!settled) {
          owedToYou += amount;
          addPersonAmount(owedToYouByPerson, person, amount);
        }

        activity.push({
          id: `lent-${monthKey}-${entry.id}-${lent.id || lent.person || lentCount}`,
          source: 'lent',
          monthKey,
          entryId: entry.id,
          description: entry.description || 'Shared purchase',
          date: entry.date || `${monthKey}-01`,
          amount,
          person,
          settled,
          entryType,
        });
      }
    }
  }

  activity.sort(
    (a, b) =>
      String(b.date).localeCompare(String(a.date)) ||
      String(b.id).localeCompare(String(a.id)),
  );

  const sortPersonBalances = bucket =>
    [...bucket.values()].sort(
      (a, b) =>
        b.amount - a.amount ||
        a.person.localeCompare(b.person),
    );

  return {
    activity,
    groupCount: groups.length,
    lentCount,

    owedByYou,
    owedToYou,

    owedByYouByPerson: sortPersonBalances(owedByYouByPerson),
    owedToYouByPerson: sortPersonBalances(owedToYouByPerson),

    netPosition: owedToYou - owedByYou,
  };
}

function buildDashboardPrices(domain) {
  const items = (domain.priceItems || []).map(item => {
    const history = [...(item.history || [])].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    const latest = history.at(-1) || null;
    const previous = history.length > 1 ? history.at(-2) : null;

    const latestPrice = Number(latest?.price) || 0;
    const previousPrice = Number(previous?.price) || 0;
    const changeAmount = latest && previous ? latestPrice - previousPrice : 0;
    const changePct = latest && previous && previousPrice !== 0 ? (changeAmount / previousPrice) * 100 : null;

    return {
      id: item.id,
      name: item.name || 'Tracked item',
      category: item.category || 'Other',
      meta: item.meta || null,
      latestPrice,
      latestDate: latest?.date || null,
      previousPrice,
      changeAmount,
      changePct,
      historyCount: history.length,
    };
  }).filter(item => item.historyCount > 0);

  items.sort((a, b) => {
    const aHasMove = a.changePct !== null;
    const bHasMove = b.changePct !== null;

    if (aHasMove !== bHasMove) return aHasMove ? -1 : 1;

    if (aHasMove && bHasMove) {
      const movementDiff = Math.abs(b.changePct) - Math.abs(a.changePct);
      if (movementDiff !== 0) return movementDiff;
    }

    return String(b.latestDate || '').localeCompare(String(a.latestDate || ''));
  });

  return {
    items,
    trackedCount: (domain.priceItems || []).length,
    movedCount: items.filter(item => item.changePct !== null && item.changePct !== 0).length,
  };
}

/* Runs once per page load: every network round trip and every O(months)
   computation lives here. Nothing below this function touches Store.get(). */
async function buildUpcomingCommitments(domain, horizonDays = 20) {
  const today = todayStr();
  const horizonEnd = addDashboardDays(today, horizonDays);
  const endMonthKey = horizonEnd.slice(0, 7);
  const monthKeys = [];

  let monthKey = currentMonthKey();
  while (monthKey <= endMonthKey) {
    monthKeys.push(monthKey);
    monthKey = addMonths(monthKey, 1);
  }

  const events = [];

  for (const key of monthKeys) {
    const data = await dashboardMonthData(domain, key);
    const emiRows = emiRowsForMonth(domain.emiSeries, key, data.deletedEmi);
    const sipRows = sipRowsForMonth(domain.sipSeries, key, data.deletedSip, data.sipOverrides);
    const recurringRows = recurringRowsForMonth(domain.recurringSeries, key, data.deletedRecurring, data.recurringOverrides);

    for (const row of [...emiRows, ...sipRows, ...recurringRows]) {
      if (!row.date || row.date <= today || row.date > horizonEnd) continue;

      if (row.type === 'emi') {
        events.push({ id: row.id, kind: 'emi', title: row.description || 'EMI payment', amount: Number(row.amount) || 0, date: row.date, meta: row.installment && row.totalMonths ? `Installment ${row.installment} of ${row.totalMonths}` : 'Scheduled EMI', href: `/month/${row.date.slice(0, 7)}` });
      }

      if (row.type === 'sip') {
        events.push({ id: row.id, kind: 'sip', title: row.description || 'SIP investment', amount: Number(row.amount) || 0, date: row.date, meta: row.category || 'Scheduled investment', href: '/sips' });
      }

      if (row.type === 'recurring') {
        const paymentLabel = row.paymentMode === 'card' ? 'Credit card recurring payment' : 'Bank recurring payment';
        events.push({ id: row.id, kind: 'recurring', title: row.description || 'Recurring payment', amount: Number(row.amount) || 0, date: row.date, meta: paymentLabel, href: '/subscriptions' });
      }
    }
  }

  return events.filter(event => event.amount > 0).sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

async function buildDashboardBudget(domain) {
  const monthKey = currentMonthKey();
  const today = todayStr();
  const data = await dashboardMonthData(domain, monthKey);

  const emiRows = emiRowsForMonth(domain.emiSeries, monthKey, data.deletedEmi);
  const sipRows = sipRowsForMonth(domain.sipSeries, monthKey, data.deletedSip, data.sipOverrides);
  const recurringRows = recurringRowsForMonth(domain.recurringSeries, monthKey, data.deletedRecurring, data.recurringOverrides);
  const scheduledGeneratedRows = [...emiRows, ...sipRows, ...recurringRows];

  const postedManualRows = (data.entries || []).filter(entry => !entry.date || entry.date <= today);
  const postedGeneratedRows = scheduledGeneratedRows.filter(row => !row.date || row.date <= today);

  const postedEntries = [...postedManualRows, ...postedGeneratedRows];
  const scheduledEntries = [...(data.entries || []), ...scheduledGeneratedRows];

  return analyzeDashboardBudget({ budgetData: domain.budgetData, postedEntries, scheduledEntries, monthKey });
}

async function buildDashboardCards(domain, stats) {
  const today = todayStr();
  const globalDueByCard = new Map();

  for (const item of (stats.cardDues?.list || [])) {
    const key = item.cardId || item.name;
    globalDueByCard.set(key, Math.max(0, Number(item.dues) || 0));
  }

  const cards = await Promise.all((domain.cards || []).map(async card => {
    const currentStatementMonth = creditCardCurrentStatementMonthKey(card, today);
    const previousStatementMonth = addMonths(currentStatementMonth, -1);

    const [currentLedger, previousLedger] = await Promise.all([
      creditCardCycleLedger(card, domain.recurringSeries, currentStatementMonth, today),
      creditCardCycleLedger(card, domain.recurringSeries, previousStatementMonth, today),
    ]);

    const outstanding = globalDueByCard.get(card.id) ?? globalDueByCard.get(card.name) ?? 0;
    const currentCycleAmount = Number(currentLedger?.grossAmount) || 0;
    const lastStatementAmount = Number(previousLedger?.grossAmount) || 0;

    const previousCycleRemainder = Math.max(
      0,
      outstanding - currentCycleAmount
    );

    /*
     * The Card page's settlement switch is authoritative for the
     * previous statement. Keep its gross spend for history, but never
     * surface it as payable once it has been marked fully settled.
     */
    const statementDueAmount = previousLedger?.fullySettled
      ? 0
      : Math.min(
          Number(previousLedger?.dueAmount) || lastStatementAmount,
          previousCycleRemainder
        );

    const statementDueDate = previousLedger?.dueDate || null;
    const configuredDueDate = nextDashboardDueDate(card.dueDay, today);

    const dueDate = statementDueAmount > 0
      ? statementDueDate
      : (currentLedger?.dueDate || configuredDueDate);

    const daysUntilDue = dueDate
      ? dashboardDaysBetween(today, dueDate)
      : null;

    let urgency = 'normal';

    /*
     * Money Inbox urgency is about an actually payable statement,
     * not merely card activity in the active billing cycle.
     */
    if (statementDueAmount > 0 && daysUntilDue !== null && daysUntilDue < 0) {
      urgency = 'overdue';
    } else if (statementDueAmount > 0 && daysUntilDue === 0) {
      urgency = 'critical';
    } else if (statementDueAmount > 0 && daysUntilDue !== null && daysUntilDue <= 2) {
      urgency = 'critical';
    } else if (statementDueAmount > 0 && daysUntilDue !== null && daysUntilDue <= 7) {
      urgency = 'warning';
    }

    return {
      id: card.id,
      name: card.name,
      billingDay: Number(card.billingDay) || 1,
      dueDay: Number(card.dueDay) || 1,
      outstanding,
      lastStatementAmount,
      statementDueAmount,
      currentCycleAmount,
      dueDate,
      daysUntilDue,
      urgency,
      cycleStart: currentLedger?.cycleStart || null,
      cycleEnd: currentLedger?.cycleEnd || null,
    };
  }));

  const urgencyRank = { overdue: 0, critical: 1, warning: 2, normal: 3 };

  cards.sort((a, b) => {
    const urgencyDiff = (urgencyRank[a.urgency] ?? 9) - (urgencyRank[b.urgency] ?? 9);
    if (urgencyDiff !== 0) return urgencyDiff;

    const dueCompare = String(a.dueDate || '9999-12-31').localeCompare(String(b.dueDate || '9999-12-31'));
    if (dueCompare !== 0) return dueCompare;

    return b.outstanding - a.outstanding;
  });

  return {
    cards,
    totalOutstanding: cards.reduce((sum, card) => sum + card.outstanding, 0),
    urgentCount: cards.filter(card => ['overdue', 'critical', 'warning'].includes(card.urgency)).length,
  };
}

async function buildMoneyInbox(domain, stats, dashboardKpis, upcomingCommitments, budgetSnapshot, cardSnapshot) {
  const today = todayStr();
  const items = [];

  if (dashboardKpis.availableBalance < 0) {
    items.push({ id: 'negative-balance', severity: 'critical', kind: 'balance', title: 'Available balance is below zero', detail: `${monthKeyLabel(dashboardKpis.monthKey)} needs attention`, amount: Math.abs(dashboardKpis.availableBalance), href: `/month/${dashboardKpis.monthKey}` });
  } else if (dashboardKpis.monthEndProjection < 0) {
    items.push({ id: 'negative-projection', severity: 'warning', kind: 'projection', title: 'Month-end balance is projected below zero', detail: 'Known scheduled cash commitments exceed the available balance', amount: Math.abs(dashboardKpis.monthEndProjection), href: `/month/${dashboardKpis.monthKey}` });
  }

  for (const card of (cardSnapshot?.cards || [])) {
    /*
     * Inbox alerts represent statement payments that actually require
     * action. Active-cycle spending is still visible in Card Dues, but
     * it is not a payment-due alert yet.
     */
    if (card.statementDueAmount <= 0) continue;
    if (!['overdue', 'critical', 'warning'].includes(card.urgency)) continue;

    let title = 'Credit card payment due soon';

    if (card.urgency === 'overdue') title = 'Credit card statement is overdue';
    else if (card.daysUntilDue === 0) title = 'Credit card payment is due today';
    else if (card.daysUntilDue === 1) title = 'Credit card payment is due tomorrow';
    else if (card.daysUntilDue > 1) title = `Credit card payment is due in ${card.daysUntilDue} days`;

    items.push({
      id: `card-${card.id}`,
      severity:
        card.urgency === 'overdue' || card.urgency === 'critical'
          ? 'critical'
          : 'warning',
      kind: 'card',
      title,
      detail: `${card.name} · previous statement still has an unpaid balance`,
      amount: card.statementDueAmount,
      date: card.dueDate,
      href: `/cards?card=${encodeURIComponent(card.id)}&cycle=last`,
    });
  }

  if (domain.monthsIndex.includes(dashboardKpis.monthKey)) {
    const data = await loadMonth(dashboardKpis.monthKey);
    const uncategorized = (data.entries || []).filter(entry => {
      const type = String(entry.type || '').toLowerCase();
      const isSpend = ['spend', 'cardcharge', 'cashpayment'].includes(type);
      const isPosted = !entry.date || entry.date <= today;
      const hasNoTag = !String(entry.tag || '').trim();
      return isSpend && isPosted && hasNoTag && (Number(entry.amount) || 0) > 0;
    });

    if (uncategorized.length) {
      const total = uncategorized.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
      items.push({ id: 'uncategorized', severity: 'info', kind: 'review', title: `${uncategorized.length} uncategorized transaction${uncategorized.length === 1 ? '' : 's'} need review`, detail: 'Add tags to keep budgets and insights accurate', amount: total, href: `/month/${dashboardKpis.monthKey}?focus=uncategorized` });
    }
  }

  const budgetRisks = (budgetSnapshot?.categories || []).filter(category => category.overAmount > 0 || category.projectedOverAmount > 0).slice(0, 2);

  budgetRisks.forEach(category => {
    if (category.overAmount > 0) {
      items.push({
        id: `budget-over-${category.id}`,
        severity: 'warning',
        kind: 'budget',
        title: `${category.name} is over budget`,
        detail: `${category.groupName} · ${fmtINR(category.used)} used of ${fmtINR(category.budget)}`,
        amount: category.overAmount,
        href: `/budget?focus=category&id=${encodeURIComponent(category.id)}`,
      });
      return;
    }

    items.push({
      id: `budget-forecast-${category.id}`,
      severity: 'warning',
      kind: 'budget',
      title: `${category.name} is projected to exceed budget`,
      detail: `${category.groupName} · projected ${fmtINR(category.projected)} against ${fmtINR(category.budget)}`,
      amount: category.projectedOverAmount,
      href: `/budget?focus=category&id=${encodeURIComponent(category.id)}`,
    });
  });

  if (budgetSnapshot?.hasBudget && budgetSnapshot.unbudgeted?.total > 0) {
    items.push({
      id: 'budget-unbudgeted',
      severity: 'info',
      kind: 'budget',
      title: `${budgetSnapshot.unbudgeted.items.length} spending categor${budgetSnapshot.unbudgeted.items.length === 1 ? 'y is' : 'ies are'} outside your budget`,
      detail: 'Review the budget or assign those spends to an existing category',
      amount: budgetSnapshot.unbudgeted.total,
      href: '/budget',
    });
  }

  upcomingCommitments.filter(event => dashboardDaysBetween(today, event.date) <= 2).slice(0, 2).forEach(event => {
    const daysUntil = dashboardDaysBetween(today, event.date);
    const timing = daysUntil === 1 ? 'tomorrow' : `in ${daysUntil} days`;
    items.push({ id: `upcoming-${event.id}`, severity: 'info', kind: event.kind, title: `${event.title} ${timing}`, detail: event.meta, amount: event.amount, date: event.date, href: event.href });
  });

  const severityRank = { critical: 0, warning: 1, info: 2 };
  items.sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9) || String(a.date || '9999-12-31').localeCompare(String(b.date || '9999-12-31')));

  return { totalCount: items.length, items };
}

function buildDashboardCashflowSeries(stats, dashboardKpis) {
  return (stats.breakdown || [])
    .filter(row => row.monthKey <= dashboardKpis.monthKey)
    .map(row => {
      if (row.monthKey === dashboardKpis.monthKey) {
        return {
          monthKey: row.monthKey,
          income: dashboardKpis.income,
          spending: dashboardKpis.spentThisMonth,
          investments: dashboardKpis.investmentsThisMonth,
        };
      }

      const totals = row.totals || {};

      return {
        monthKey: row.monthKey,
        income: Number(row.income) || Number(totals.income) || 0,
        spending: Number(totals.totalConsumption) || 0,
        investments: (Number(totals.invest) || 0) + (Number(totals.sip) || 0),
      };
    });
}

async function buildDashboardSipInvestments(domain) {
  const today = todayStr();
  const currentKey = currentMonthKey();
  const basePortfolio = Number(domain.existingInvestments) || 0;

  /*
   * Previous month-end portfolio:
   * base portfolio + every SIP from months before the current month.
   */
  const previousMonthKeys = [
    ...new Set(
      (domain.monthsIndex || []).filter(key => key < currentKey)
    ),
  ].sort();

  let previousSipInvested = 0;

  for (const monthKey of previousMonthKeys) {
    const data = await dashboardMonthData(domain, monthKey);

    const rows = sipRowsForMonth(
      domain.sipSeries,
      monthKey,
      data.deletedSip,
      data.sipOverrides
    );

    for (const row of rows) {
      previousSipInvested += Number(row.amount) || 0;
    }
  }

  const previousMonthEndPortfolio =
    basePortfolio + previousSipInvested;

  /*
   * Current-month SIPs only count once their configured due date
   * has arrived.
   */
  const currentData = await dashboardMonthData(domain, currentKey);

  const currentRows = sipRowsForMonth(
    domain.sipSeries,
    currentKey,
    currentData.deletedSip,
    currentData.sipOverrides
  );

  const currentMonthScheduled = currentRows.reduce(
    (sum, row) => sum + (Number(row.amount) || 0),
    0
  );

  const currentMonthInvested = currentRows
    .filter(row => !row.date || row.date <= today)
    .reduce(
      (sum, row) => sum + (Number(row.amount) || 0),
      0
    );

  const currentMonthRemaining = currentRows
    .filter(row => row.date && row.date > today)
    .reduce(
      (sum, row) => sum + (Number(row.amount) || 0),
      0
    );

  const currentPortfolio =
    previousMonthEndPortfolio + currentMonthInvested;

  return {
    basePortfolio,
    previousSipInvested,
    previousMonthEndPortfolio,

    currentMonthScheduled,
    currentMonthInvested,
    currentMonthRemaining,

    currentPortfolio,
  };
}


function buildDashboardGoals(domain) {
  const currentKey = currentMonthKey();

  const goals = (domain.goals || [])
    .filter(goal => goal && goal.active !== false)
    .map(goal => {
      const targetAmount = Number(goal.targetAmount) || 0;
      const earlierFunding = goal.hasDownpayment ? (Number(goal.downpaymentAmount) || 0) : 0;
      const historyFunding = (goal.fundingHistory || []).reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
      const thisMonthFunded = (goal.fundingHistory || []).filter(item => item.monthKey === currentKey).reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
      const funded = earlierFunding + historyFunding;
      const remaining = Math.max(0, targetAmount - funded);
      const progressPct = targetAmount > 0 ? Math.min(100, Math.max(0, (funded / targetAmount) * 100)) : 0;
      const monthsLeft = goal.expectedMonth ? Math.max(0, diffMonths(currentKey, goal.expectedMonth)) : null;

      return {
        id: goal.id,
        name: goal.name || 'Goal',
        targetAmount,
        funded,
        remaining,
        thisMonthFunded,
        progressPct,
        expectedMonth: goal.expectedMonth || null,
        monthsLeft,
        completed: targetAmount > 0 && funded >= targetAmount,
      };
    });

  goals.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (a.expectedMonth && b.expectedMonth && a.expectedMonth !== b.expectedMonth) return a.expectedMonth.localeCompare(b.expectedMonth);
    return b.progressPct - a.progressPct;
  });

  return {
    goals,
    activeCount: goals.filter(goal => !goal.completed).length,
    totalRemaining: goals.reduce((sum, goal) => sum + goal.remaining, 0),
  };
}

function applyBudgetForecastProjection(dashboardKpis, budgetSnapshot) {
  const available = Number(dashboardKpis.availableBalance) || 0;

  const postedBudgeted = Number(budgetSnapshot?.totalUsed) || 0;
  const postedUnbudgeted = Number(budgetSnapshot?.unbudgeted?.total) || 0;
  const projectedTotal = Number(budgetSnapshot?.totalProjected) || 0;

  /*
   * Budget forecast is a full-month total, so remove spending that has
   * already happened before applying the remaining forecast to today's
   * available balance.
   */
  const remainingForecast = Math.max(
    0,
    projectedTotal - postedBudgeted - postedUnbudgeted
  );

  const forecastDeductions = (budgetSnapshot?.categories || [])
    .filter(category =>
      category.systemType !== 'auto-spends' &&
      category.systemType !== 'credit-card-dues'
    )
    .reduce((sum, category) => {
      const remaining = Math.max(
        0,
        (Number(category.projected) || 0) -
        (Number(category.used) || 0)
      );

      return sum + remaining;
    }, 0);

  const forecastRows = forecastDeductions > 0
    ? [{
        label: 'Budget forecast deductions',
        amount: forecastDeductions,
      }]
    : [];

  dashboardKpis.budgetForecastTotal = projectedTotal;
  dashboardKpis.remainingBudgetForecast = remainingForecast;
  dashboardKpis.forecastRows = forecastRows;

  dashboardKpis.monthEndProjection =
    available - remainingForecast;

  /*
   * This is now the Budget-page month-end forecast adjusted against
   * the balance actually available today.
   */
  dashboardKpis.monthEndProjection =
    available - remainingForecast;

  return dashboardKpis;
}


/* Runs once per page load: every network round trip and every O(months)
   computation lives here. Nothing below this function touches Store.get(). */
async function buildCache() {
  const domain = await loadDomain();

  const stats = await computeGlobalStats({
    cards: domain.cards, emiSeries: domain.emiSeries, sipSeries: domain.sipSeries, recurringSeries: domain.recurringSeries,
    monthsIndex: domain.monthsIndex, existingInvestments: domain.existingInvestments,
    isShared: false, sharedSplitId: null, splitsIndex: domain.splitsIndex,
  });

  const dashboardKpis = await buildCurrentMonthDashboardMetrics(domain, stats);
  const upcomingCommitments = await buildUpcomingCommitments(domain);
  const budgetSnapshot = await buildDashboardBudget(domain);

  applyBudgetForecastProjection(
    dashboardKpis,
    budgetSnapshot
  );

  const cardSnapshot = await buildDashboardCards(domain, stats);
  const sipInvestmentSnapshot = await buildDashboardSipInvestments(domain);
  const goalSnapshot = buildDashboardGoals(domain);
  const sharedSnapshot = await buildDashboardSharedExpenses(domain);
  const priceSnapshot = buildDashboardPrices(domain);
  const moneyInbox = await buildMoneyInbox(domain, stats, dashboardKpis, upcomingCommitments, budgetSnapshot, cardSnapshot);
  const dailySeries = await computeDailyBalanceSeries(domain.monthsIndex, domain.emiSeries, domain.sipSeries, domain.recurringSeries);
  const cashflowSeries = buildDashboardCashflowSeries(stats, dashboardKpis);

  return {
    ...domain,
    stats,
    dashboardKpis,
    upcomingCommitments,
    budgetSnapshot,
    cardSnapshot,
    sipInvestmentSnapshot,
    goalSnapshot,
    sharedSnapshot,
    priceSnapshot,
    moneyInbox,
    dailySeries,
    cashflowSeries,
  };
}

/* Cheap: only re-slices dailySeries for the chosen range and rebuilds markup
   from data already sitting in memory. Safe to call on every click. */
function renderFromCache() {
  const windowedSeries = windowSeries(cache.dailySeries, balanceChartRange);
  const dashboardChartHtml = dashboardChartMode === 'cashflow'
    ? renderDashboardCashflowChart(cache.cashflowSeries, balanceChartRange, cache.dashboardKpis.monthKey)
    : dailyBalanceChart(windowedSeries, balanceChartRange);

  const tb = document.getElementById('global-topbar');
  if (tb) tb.style.display = '';

  markRendered(root);
  root.removeAttribute('data-loading');

  root.innerHTML = `
    <section class="dashboard-heading">
      <div class="dashboard-heading-copy">
        <div class="dashboard-eyebrow">${monthKeyLabel(cache.dashboardKpis.monthKey)}</div>
        <h1>Your money, at a glance</h1>
        <p>Track today's liquid position, this month's activity and where your known commitments leave you by month-end.</p>
      </div>
    </section>

    <section class="dashboard-current-month">
      <a
        class="current-month-card"
        href="/month/${cache.dashboardKpis.monthKey}"
        aria-label="Open ${monthKeyLabel(cache.dashboardKpis.monthKey)} transactions"
      >
        <div class="cm-left">
          <div class="cm-eyebrow">
            <span>This month : </span>
            ${
              dashboardDaysLeftInMonth(cache.dashboardKpis.monthKey) !== null
                ? `<span class="cm-days-left">${dashboardDaysLeftInMonth(cache.dashboardKpis.monthKey)} days left</span>`
                : ''
            }
          </div>

          <h3>${monthKeyLabel(cache.dashboardKpis.monthKey)}</h3>

          <div class="cm-sub">
            ${
              cache.dashboardKpis.entryCount > 0
                ? `${cache.dashboardKpis.entryCount} ${cache.dashboardKpis.entryCount === 1 ? 'entry' : 'entries'} logged so far`
                : 'No entries logged yet'
            }
            <span class="cm-sub-separator" aria-hidden="true">·</span>
            Tap to open
          </div>
        </div>

        <span class="cm-open" aria-hidden="true">
          <span>Transactions</span>
          <strong>→</strong>
        </span>
      </a>
    </section>

    <section class="dashboard-kpi-section">
      <div class="dashboard-section-heading">
        <div>
          <div class="dashboard-section-kicker">Overview</div>
          <h2>Financial position</h2>
        </div>
        <span class="dashboard-section-hint">Posted through ${cache.dashboardKpis.asOfLabel} · projection uses known scheduled cash commitments</span>
      </div>
      ${renderDashboardKpis(cache.dashboardKpis)}
    </section>

    <section class="dashboard-grid">
      <article class="dashboard-panel dashboard-panel-money-inbox dashboard-span-4" data-dashboard-slot="money-inbox">
        <div class="dashboard-panel-header">
          <div>
            <div class="dashboard-panel-kicker">Action centre</div>
            <h3>Money Inbox</h3>
          </div>
          <span class="dashboard-inbox-count ${cache.moneyInbox.totalCount ? 'has-items' : ''}">${cache.moneyInbox.totalCount}</span>
        </div>
        ${renderMoneyInbox(cache.moneyInbox)}
      </article>

      <div class="dashboard-chart-stack dashboard-span-5" data-dashboard-slot="balance-stack">

        <article
          class="dashboard-panel dashboard-panel-chart"
          data-dashboard-slot="balance-chart"
        >
          <div class="dashboard-panel-header dashboard-panel-header-chart">
            <div>
              <div class="dashboard-panel-kicker">Financial movement</div>
              <h3>${dashboardChartMode === 'balance' ? 'Balance over time' : 'Monthly cash flow'}</h3>
            </div>

            <div class="dashboard-chart-controls">
              <div class="dashboard-chart-mode" role="group" aria-label="Chart type">
                <button
                  class="${dashboardChartMode === 'balance' ? 'active' : ''}"
                  data-dashboard-chart-mode="balance"
                  type="button"
                >Balance</button>

                <button
                  class="${dashboardChartMode === 'cashflow' ? 'active' : ''}"
                  data-dashboard-chart-mode="cashflow"
                  type="button"
                >Cash Flow</button>
              </div>

              <div class="range-toggle" role="group" aria-label="Chart range">
                <button class="range-btn ${balanceChartRange === 1 ? 'active' : ''}" data-range="1" type="button">1M</button>
                <button class="range-btn ${balanceChartRange === 3 ? 'active' : ''}" data-range="3" type="button">3M</button>
                <button class="range-btn ${balanceChartRange === 6 ? 'active' : ''}" data-range="6" type="button">6M</button>
              </div>
            </div>
          </div>

          <div class="dashboard-chart-body">
            ${dashboardChartHtml}
          </div>
        </article>

        <article
          class="dashboard-panel dashboard-panel-sip-investment"
          data-dashboard-slot="sip-investments"
        >
          <div class="dashboard-panel-header">
            <div>
              <div class="dashboard-panel-kicker">Investments</div>
              <h3>SIP Portfolio</h3>
            </div>

            <a class="dashboard-panel-link" href="/sips">
              View <span aria-hidden="true">→</span>
            </a>
          </div>

          ${renderDashboardSipInvestments(cache.sipInvestmentSnapshot)}
        </article>

      </div>

      <article class="dashboard-panel dashboard-panel-budget dashboard-span-3" data-dashboard-slot="budget">
        <div class="dashboard-panel-header">
          <div>
            <div class="dashboard-panel-kicker">Plan</div>
            <h3>Budget Status</h3>
          </div>
          <a class="dashboard-panel-link" href="/budget">View <span aria-hidden="true">→</span></a>
        </div>
        ${renderDashboardBudget(cache.budgetSnapshot)}
      </article>

      <article class="dashboard-panel dashboard-panel-card-dues dashboard-span-4" data-dashboard-slot="card-dues">
        <div class="dashboard-panel-header">
          <div>
            <div class="dashboard-panel-kicker">Credit</div>
            <h3>Card Dues</h3>
          </div>
          <a class="dashboard-panel-link" href="/cards">View <span aria-hidden="true">→</span></a>
        </div>
        ${renderDashboardCards(cache.cardSnapshot)}
      </article>

      <article class="dashboard-panel dashboard-panel-upcoming dashboard-span-4" data-dashboard-slot="upcoming">
        <div class="dashboard-panel-header">
          <div>
            <div class="dashboard-panel-kicker">Next 20 days</div>
            <h3>Upcoming Spends</h3>
          </div>
          <span class="dashboard-stage-badge">${cache.upcomingCommitments.length}</span>
        </div>
        ${renderUpcomingSpends(cache.upcomingCommitments)}
      </article>

      <div
        class="dashboard-secondary-stack dashboard-span-4"
        data-dashboard-slot="secondary-stack"
      >
        <article
          class="dashboard-panel dashboard-panel-goals dashboard-panel-compact"
          data-dashboard-slot="goals"
        >
          <div class="dashboard-panel-header">
            <div>
              <div class="dashboard-panel-kicker">Progress</div>
              <h3>Goal Progress</h3>
            </div>

            <a class="dashboard-panel-link" href="/budget">
              View <span aria-hidden="true">→</span>
            </a>
          </div>

          ${renderDashboardGoals(cache.goalSnapshot)}
        </article>

        <article
          class="dashboard-panel dashboard-panel-people dashboard-panel-compact"
          data-dashboard-slot="people-balances"
        >
          <div class="dashboard-panel-header">
            <div>
              <div class="dashboard-panel-kicker">People</div>
              <h3>People balances</h3>
            </div>
          </div>

          ${renderDashboardPeopleBalances(cache.sharedSnapshot)}
        </article>
      </div>

      <article class="dashboard-panel dashboard-panel-shared dashboard-span-4" data-dashboard-slot="shared">
        <div class="dashboard-panel-header">
          <div>
            <div class="dashboard-panel-kicker">Shared</div>
            <h3>Latest Shared Expenses</h3>
          </div>
          <a class="dashboard-panel-link" href="/split">View <span aria-hidden="true">→</span></a>
        </div>
        ${renderDashboardSharedExpenses(cache.sharedSnapshot)}
      </article>

      <article class="dashboard-panel dashboard-panel-prices dashboard-span-4" data-dashboard-slot="prices">
        <div class="dashboard-panel-header">
          <div>
            <div class="dashboard-panel-kicker">Prices</div>
            <h3>Price Tracking</h3>
          </div>
          <a class="dashboard-panel-link" href="/pricetrack">View <span aria-hidden="true">→</span></a>
        </div>
        ${renderDashboardPrices(cache.priceSnapshot)}
      </article>

      <article class="dashboard-panel dashboard-panel-projection dashboard-span-4" data-dashboard-slot="projection">
        <div class="dashboard-panel-header">
          <div>
            <div class="dashboard-panel-kicker">Projection</div>
            <h3>Month-End Outlook</h3>
          </div>
          <a class="dashboard-panel-link" href="/month/${cache.dashboardKpis.monthKey}">View month <span aria-hidden="true">→</span></a>
        </div>
        ${renderMonthEndProjection(cache.dashboardKpis)}
      </article>
    </section>
  `;

  appendPageChrome(root, { showFabHome: false });
  setupTableScrollIndicators(root);
}

async function renderHome() {
  if (!cache) cache = await buildCache();
  renderFromCache();
}

function setDashboardPagerPage(pager, requestedIndex) {
  const pages = [
    ...pager.querySelectorAll('[data-dashboard-pager-page]'),
  ];

  if (!pages.length) return;

  const nextIndex = Math.max(
    0,
    Math.min(
      pages.length - 1,
      Number(requestedIndex) || 0,
    ),
  );

  pager.dataset.dashboardPagerIndex = String(nextIndex);

  pager.style.setProperty(
    '--dashboard-page-offset',
    `${nextIndex * -100}%`,
  );

  pages.forEach((page, index) => {
    const isActive = index === nextIndex;

    page.setAttribute(
      'aria-hidden',
      isActive ? 'false' : 'true',
    );

    page.inert = !isActive;
  });

  pager
    .querySelectorAll('[data-dashboard-page-target]')
    .forEach(dot => {
      const isActive =
        Number(dot.dataset.dashboardPageTarget) === nextIndex;

      dot.classList.toggle('is-active', isActive);

      if (isActive) {
        dot.setAttribute('aria-current', 'true');
      } else {
        dot.removeAttribute('aria-current');
      }
    });

  const previous = pager.querySelector(
    '[data-dashboard-page-dir="-1"]',
  );

  const next = pager.querySelector(
    '[data-dashboard-page-dir="1"]',
  );

  if (previous) {
    previous.disabled = nextIndex === 0;
  }

  if (next) {
    next.disabled = nextIndex === pages.length - 1;
  }
}

root.addEventListener('click', (ev) => {
  const pagerControl = ev.target.closest(
    '[data-dashboard-page-dir], [data-dashboard-page-target]',
  );

  if (pagerControl) {
    const pager = pagerControl.closest('[data-dashboard-pager]');
    if (!pager) return;

    const currentIndex =
      Number(pager.dataset.dashboardPagerIndex) || 0;

    const requestedIndex =
      pagerControl.hasAttribute('data-dashboard-page-target')
        ? Number(pagerControl.dataset.dashboardPageTarget)
        : currentIndex +
          Number(pagerControl.dataset.dashboardPageDir || 0);

    setDashboardPagerPage(pager, requestedIndex);
    return;
  }

  const chartModeBtn = ev.target.closest('[data-dashboard-chart-mode]');
  if (chartModeBtn) {
    dashboardChartMode = chartModeBtn.dataset.dashboardChartMode === 'cashflow' ? 'cashflow' : 'balance';
    renderFromCache();
    return;
  }

  const rangeBtn = ev.target.closest('[data-range]');
  if (rangeBtn) {
    balanceChartRange = Number(rangeBtn.dataset.range);
    renderFromCache();
  }
});

window.addEventListener('auth:signed-in', () => {
  cache = null;
  renderHome();
});

/*
 * Chart geometry differs above/below the dashboard tablet
 * breakpoint. Re-render only when that breakpoint is crossed.
 */
const dashboardChartViewport =
  window.matchMedia('(max-width: 1023px)');

dashboardChartViewport.addEventListener('change', () => {
  if (cache) renderFromCache();
});

authReady.then(renderHome);
wireChartTooltips(root);
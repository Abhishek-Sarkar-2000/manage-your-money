/* ---------- Month + cross-month domain logic ----------
   Ported verbatim from the monolith's month/EMI/SIP/global-stat functions.
   Each view calls only the pieces it needs — nothing here is invoked at
   boot for every page the way the old loadCore() was. */
import { Store } from './store.js';
import { currentMonthKey, diffMonths, todayStr, addMonths } from './format.js';
import { computeSplitPageData } from './split-domain.js';

/* In-memory per-page-load cache. Fresh on every navigation (a real page
   load now), so there's no cross-route staleness to manage. */
const monthCache = {};

export function migrateBudgetData(raw) {
  if (!raw || !Array.isArray(raw) || raw.length === 0) return [];
  const isLegacy = raw.some(item => !('categories' in item));
  if (!isLegacy) return raw;

  const totalBudget = raw.reduce((sum, cat) => sum + (Number(cat.budget) || 0), 0);
  return [{
    id: 'group-general-migrated',
    name: 'General',
    budget: totalBudget,
    expanded: true,
    categories: raw
  }];
}

export function validateGroupBudget(group, newBudget) {
  const sumCats = (group.categories || []).reduce((s, cat) => s + (Number(cat.budget) || 0), 0);
  return newBudget >= sumCats;
}

export function validateCategoryBudget(category, newBudget) {
  const sumSubs = (category.subcategories || []).reduce((s, sub) => s + (Number(sub.budget) || 0), 0);
  return newBudget >= sumSubs;
}

export function validateCategoryMove(destGroup, categoryToMove, excludeCategoryId = null) {
  const currentSum = (destGroup.categories || []).reduce((s, cat) => s + (cat.id === excludeCategoryId ? 0 : (Number(cat.budget) || 0)), 0);
  return destGroup.budget >= currentSum + (Number(categoryToMove.budget) || 0);
}

export function findCategoryByTag(budgetData, tagName) {
  if (!tagName) return null;
  const target = tagName.toLowerCase().trim();
  for (const group of budgetData) {
    for (const category of (group.categories || [])) {
      if (category.name.toLowerCase().trim() === target) {
        return { group, category };
      }
    }
  }
  return null;
}

export function ensureCategoryForTag(budgetData, tagName) {
  const found = findCategoryByTag(budgetData, tagName);
  if (found) return found;

  let fallbackGroup = budgetData.find(g => g.name === 'Unsorted');
  if (!fallbackGroup) {
    fallbackGroup = { id: 'group-unsorted-' + Date.now(), name: 'Unsorted', budget: 0, expanded: true, categories: [] };
    budgetData.push(fallbackGroup);
  }

  const newCategory = { id: 'cat-auto-' + Date.now(), name: tagName, budget: 0, expanded: true, subcategories: [] };
  fallbackGroup.categories.push(newCategory);
  return { group: fallbackGroup, category: newCategory };
}

export function matchesCategory(entry, targetName, isSub, parentTargetName) {
  const target = (targetName || '').toLowerCase().trim();
  const pTarget = parentTargetName ? parentTargetName.toLowerCase().trim() : null;

  const eType = (entry.type || '').toLowerCase();
  const eTag = (entry.tag || '').toLowerCase();
  const eSub = (entry.subCategory || '').toLowerCase();
  const eCat = (entry.category || '').toLowerCase();
  const eDesc = (entry.description || '').toLowerCase();

  // Budget investment buckets intentionally use concise labels that differ
  // from the source labels on Month/SIPs. Keep the source data unchanged and
  // normalize only for budget matching/forecasting.
  if (!isSub && (eType === 'investment' || eType === 'sip')) {
    const investmentBucket = eType === 'investment'
      ? ({ 'lump-sum mf': 'fund', stock: 'stock', 'fixed deposit': 'fd', bond: 'bond' }[eCat] || null)
      : ({ 'mutual fund': 'mf', etf: 'etf', stock: 'stock' }[eCat] || null);
    if (investmentBucket) return investmentBucket === target;
  }

  if (isSub) {
    if (pTarget === 'sip') {
      return (eType === 'sip' || eTag === 'sip') && (eSub === target || eCat === target || eDesc === target);
    } else if (pTarget === 'recurring') {
      return (eType === 'recurring' || eTag === 'recurring') && (eSub === target || eDesc === target);
    } else if (pTarget === 'emi') {
      return (eType === 'emi' || eTag === 'emi') && (eSub === target || eDesc === target || eTag === target);
    } else {
      return (eTag === pTarget && eSub === target);
    }
  } else {
    if (target === 'sip') {
      return (eType === 'sip' || eTag === 'sip' || eCat === 'sip');
    } else if (target === 'recurring') {
      return (eType === 'recurring' || eTag === 'recurring');
    } else if (target === 'emi') {
      return (eType === 'emi' || eTag === 'emi');
    } else {
      return (eTag === target);
    }
  }
}

export async function loadMonth(key) {
  if (monthCache[key]) return monthCache[key];
  const data = await Store.get('month:' + key, {
    startingBalanceMode: 'manual', startingBalance: 0, entries: [], deletedEmi: [], deletedSip: [], deletedRecurring: [], sipOverrides: {},
  });
  if (!data.startingBalanceMode) data.startingBalanceMode = 'manual';
  if (!data.deletedSip) data.deletedSip = [];
  if (!data.deletedRecurring) data.deletedRecurring = [];
  if (
    !data.recurringOverrides ||
    typeof data.recurringOverrides !== 'object' ||
    Array.isArray(data.recurringOverrides)
  ) {
    data.recurringOverrides = {};
  }
  if (!data.sipOverrides || typeof data.sipOverrides !== 'object' || Array.isArray(data.sipOverrides)) data.sipOverrides = {};
  monthCache[key] = data;
  return data;
}

export async function saveMonth(key) {
  await Store.set('month:' + key, monthCache[key]);
}

export async function ensureMonthIndexed(key, monthsIndex) {
  if (!monthsIndex.includes(key)) {
    monthsIndex.push(key);
    monthsIndex.sort();
    await Store.set('months-index', monthsIndex);
  }
}

export function cardById(cards, id) {
  return cards.find(c => c.id === id);
}

export function emiRowsForMonth(emiSeries, monthKey, deletedEmi) {
  const rows = [];
  const [y, m] = monthKey.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  
  for (const series of emiSeries) {
    const inst = diffMonths(series.startMonth, monthKey) + 1;
    if (inst >= 1 && inst <= series.totalMonths) {
      if ((deletedEmi || []).includes(series.id)) continue;
      
      const targetDay = Math.min(Math.max(Number(series.dayOfMonth) || 1, 1), 31);
      const day = Math.min(targetDay, daysInMonth);
      const dateStr = monthKey + '-' + String(day).padStart(2, '0');
      
      rows.push({
        id: 'emi-' + series.id + '-' + monthKey, type: 'emi', date: dateStr,
        description: series.description, amount: series.monthlyAmount,
        seriesId: series.id, installment: inst, totalMonths: series.totalMonths,
        dayOfMonth: targetDay, tag: series.tag || 'EMI'
      });
    }
  }
  return rows;
}

export function sipRowsForMonth(sipSeries, monthKey, deletedSip, sipOverrides = {}) {
  const rows = [];
  const [y, m] = monthKey.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  for (const series of sipSeries) {
    if (series.startMonth > monthKey) continue;
    
    // 1. Permanently stopped
    if (series.endMonth && monthKey > series.endMonth) continue;
    
    // 2. Skipped specific month
    if (series.skipMonths && series.skipMonths.includes(monthKey)) continue;

    // 3. Paused indefinitely (preserves history prior to the paused month)
    if (series.status === 'paused' && (!series.pausedMonth || monthKey >= series.pausedMonth)) continue;
    
    if ((deletedSip || []).includes(series.id)) continue;

    const targetDay = Math.min(Math.max(Number(series.dayOfMonth) || 1, 1), 31);
    const day = Math.min(targetDay, daysInMonth);
    const dateStr = monthKey + '-' + String(day).padStart(2, '0');

    const overrideAmount = Number(sipOverrides?.[series.id]);
    const amount = Number.isFinite(overrideAmount) && overrideAmount > 0
      ? overrideAmount
      : series.amount;

    rows.push({
      id: 'sip-' + series.id + '-' + monthKey, type: 'sip', date: dateStr,
      description: series.description, amount, seriesId: series.id,
      category: series.category || 'Mutual Fund',
    });
  }
  return rows;
}

/* Maps a recurring series' "date of deduction" (1-31) onto a real date for
   the given monthKey, clamping to the month's last valid day when the
   chosen date doesn't exist that month (e.g. the 31st in February). */
export function recurringRowsForMonth(recurringSeries, monthKey, deletedRecurring, recurringOverrides = {}) {
  const rows = [];
  const [y, m] = monthKey.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();

  for (const series of recurringSeries) {
    if (series.startMonth && series.startMonth > monthKey) continue;
    if (series.endMonth && monthKey > series.endMonth) continue;

    if (series.skipMonths && series.skipMonths.includes(monthKey)) continue;

    if (
      series.status === 'paused' &&
      (!series.pausedMonth || monthKey >= series.pausedMonth)
    ) continue;

    if ((deletedRecurring || []).includes(series.id)) continue;

    const targetDay = Math.min(Math.max(Number(series.dayOfMonth) || 1, 1), 31);
    const day = Math.min(targetDay, daysInMonth);
    const dateStr = monthKey + '-' + String(day).padStart(2, '0');

    const overrideAmount = Number(recurringOverrides?.[series.id]);
    const amount = Number.isFinite(overrideAmount) && overrideAmount > 0
      ? overrideAmount
      : series.amount;

    rows.push({
      id: 'recurring-' + series.id + '-' + monthKey, type: 'recurring', date: dateStr,
      description: series.description, amount, seriesId: series.id,
      paymentMode: series.paymentMode || 'bank', cardId: series.cardId || null,
    });
  }
  return rows;
}

function dateForMonthDay(monthKey, rawDay) {
  const [year, month] = monthKey.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const day = Math.min(Math.max(Number(rawDay) || 1, 1), daysInMonth);
  return `${monthKey}-${String(day).padStart(2, '0')}`;
}

function dayAfter(dateStr) {
  const date = new Date(`${dateStr}T00:00:00`);
  date.setDate(date.getDate() + 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dayBefore(dateStr) {
  const date = new Date(`${dateStr}T00:00:00`);
  date.setDate(date.getDate() - 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function creditCardDueDate(cycleEndDate, rawDueDay) {
  const cycleEndMonthKey = cycleEndDate.slice(0, 7);
  const cycleEndDay = Number(cycleEndDate.slice(8, 10)) || 1;
  const dueDay = Math.min(Math.max(Number(rawDueDay) || 1, 1), 31);

  /*
   * The payment due date must always fall after the billing cycle.
   *
   * If the configured due day is still ahead of the cycle-end day,
   * use it in the same month. Otherwise use the following month.
   */
  const dueMonthKey = dueDay > cycleEndDay
    ? cycleEndMonthKey
    : addMonths(cycleEndMonthKey, 1);

  return dateForMonthDay(dueMonthKey, dueDay);
}

const CREDIT_CARD_CYCLE_SETTLEMENTS_KEY = 'credit-card-cycle-settlements';

function creditCardCycleSettlementKey(cardId, cycleEnd) {
  return `${cardId}|${cycleEnd}`;
}

async function loadCreditCardCycleSettlements() {
  const stored = await Store.get(CREDIT_CARD_CYCLE_SETTLEMENTS_KEY, {});
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

export async function setCreditCardCycleSettled(cardId, cycleEnd, settled) {
  if (!cardId || !cycleEnd) return;

  const settlements = await loadCreditCardCycleSettlements();
  const key = creditCardCycleSettlementKey(cardId, cycleEnd);

  if (settled) settlements[key] = true;
  else delete settlements[key];

  await Store.set(CREDIT_CARD_CYCLE_SETTLEMENTS_KEY, settlements);
}

export function creditCardCurrentStatementMonthKey(card, asOfDate = todayStr()) {
  const monthKey = asOfDate.slice(0, 7);
  const thisMonthCycleEnd = dateForMonthDay(
    monthKey,
    card?.billingDay
  );

  /*
   * billingDay is the statement / cycle END day.
   *
   * Example: billing day = 13
   *
   * 14 Aug -> 13 Sep = September statement
   * 14 Sep -> 13 Oct = October statement
   */
  return asOfDate <= thisMonthCycleEnd
    ? monthKey
    : addMonths(monthKey, 1);
}

export function creditCardBillingWindow(card, statementMonthKey) {
  const previousStatementMonthKey =
    addMonths(statementMonthKey, -1);

  const previousCycleEnd = dateForMonthDay(
    previousStatementMonthKey,
    card?.billingDay
  );

  const cycleEnd = dateForMonthDay(
    statementMonthKey,
    card?.billingDay
  );

  return {
    statementMonthKey,
    nextStatementMonthKey:
      addMonths(statementMonthKey, 1),

    cycleStart: dayAfter(previousCycleEnd),
    cycleEnd,
  };
}

export async function creditCardCycleLedger(card, recurringSeries, statementMonthKey, asOfDate = todayStr()) {
  if (!card?.id || !statementMonthKey) return null;

  const window = creditCardBillingWindow(card, statementMonthKey);
  const effectiveEnd = asOfDate < window.cycleEnd ? asOfDate : window.cycleEnd;
  const monthKeys = [
    addMonths(window.statementMonthKey, -1),
    window.statementMonthKey,
  ];

  const transactions = [];

  await Promise.all(monthKeys.map(async monthKey => {
    const data = await loadMonth(monthKey);
    const recurringRows = recurringRowsForMonth(
      recurringSeries || [],
      monthKey,
      data.deletedRecurring,
      data.recurringOverrides
    );

    for (const entry of [...(data.entries || []), ...recurringRows]) {
      if (!entry.date || entry.date < window.cycleStart || entry.date > effectiveEnd) continue;
      if (entry.cardId !== card.id) continue;

      const isCardCharge = entry.type === 'cardcharge';
      const isCardRecurring = entry.type === 'recurring' && entry.paymentMode === 'card';
      if (!isCardCharge && !isCardRecurring) continue;

      transactions.push({
        id: entry.id,
        date: entry.date,
        description: entry.description || (isCardRecurring ? 'Recurring card payment' : 'Card charge'),
        amount: Number(entry.amount) || 0,
        type: isCardRecurring ? 'recurring' : 'cardcharge',
        sourceLabel: isCardRecurring ? 'Recurring' : 'Card charge',
        tag: entry.tag || entry.category || '',
      });
    }
  }));

  transactions.sort((a, b) => {
    const dateCompare = String(a.date).localeCompare(String(b.date));
    return dateCompare || String(a.description).localeCompare(String(b.description));
  });

  const grossAmount = transactions.reduce((sum, entry) => sum + entry.amount, 0);
  const settlements = await loadCreditCardCycleSettlements();
  const fullySettled = settlements[creditCardCycleSettlementKey(card.id, window.cycleEnd)] === true;

  return {
    cardId: card.id,
    cardName: card.name,
    statementMonthKey,
    cycleStart: window.cycleStart,
    cycleEnd: window.cycleEnd,
    effectiveEnd,
    dueDate: creditCardDueDate(window.cycleEnd, card.dueDay),
    grossAmount,
    dueAmount: fullySettled ? 0 : grossAmount,
    fullySettled,
    transactions,
  };
}

export async function computeCreditCardDueBudget(
  cards,
  recurringSeries,
  budgetMonthKey,
  asOfDate = todayStr()
) {
  const cardList = Array.isArray(cards) ? cards : [];

  if (!cardList.length) {
    return { total: 0, cards: [] };
  }

  /*
   * For an October budget:
   *
   * last statement  = cycle ending in September
   * current cycle   = cycle ending in October
   *
   * Reserve =
   *   unpaid last statement
   *   + current-cycle spend accrued so far
   *   - recorded CC Due payments
   *
   * Once the current cycle closes, later card spends belong to
   * November and no longer increase October's reserve.
   */
  const previousMonthKey =
    addMonths(budgetMonthKey, -1);

  const monthKeys = [
    addMonths(budgetMonthKey, -2),
    previousMonthKey,
    budgetMonthKey,
  ];

  const rowsByMonth = new Map();

  await Promise.all(monthKeys.map(async monthKey => {
    const data = await loadMonth(monthKey);

    const recurringRows = recurringRowsForMonth(
      recurringSeries || [],
      monthKey,
      data.deletedRecurring,
      data.recurringOverrides
    );

    rowsByMonth.set(monthKey, [
      ...(data.entries || []),
      ...recurringRows,
    ]);
  }));

  const settlements =
    await loadCreditCardCycleSettlements();

  const budgetMonthEnd =
    dateForMonthDay(budgetMonthKey, 31);

  const liabilityAsOf =
    asOfDate < budgetMonthEnd
      ? asOfDate
      : budgetMonthEnd;

  const details = cardList.map(card => {
    const lastWindow =
      creditCardBillingWindow(
        card,
        previousMonthKey
      );

    const currentWindow =
      creditCardBillingWindow(
        card,
        budgetMonthKey
      );

    const currentEffectiveEnd =
      liabilityAsOf < currentWindow.cycleEnd
        ? liabilityAsOf
        : currentWindow.cycleEnd;

    let lastCycleGross = 0;
    let currentCycleGross = 0;
    let payments = 0;

    for (const monthKey of monthKeys) {
      for (const entry of (rowsByMonth.get(monthKey) || [])) {
        if (!entry.date || entry.date > liabilityAsOf) {
          continue;
        }

        if (entry.cardId !== card.id) {
          continue;
        }

        const amount =
          Number(entry.amount) || 0;

        if (amount <= 0) continue;

        const isCardCharge =
          entry.type === 'cardcharge';

        const isCardRecurring =
          entry.type === 'recurring' &&
          entry.paymentMode === 'card';

        const isCcDuePayment =
          entry.type === 'spend' &&
          String(entry.tag || '')
            .trim()
            .toLowerCase() === 'cc due';

        /*
         * Payments made after the previous statement closed reduce
         * that statement first, then any excess reduces the current
         * accruing cycle.
         */
        if (
          isCcDuePayment &&
          entry.date > lastWindow.cycleEnd
        ) {
          payments += amount;
          continue;
        }

        if (!isCardCharge && !isCardRecurring) {
          continue;
        }

        /*
         * Closed previous statement.
         */
        if (
          entry.date >= lastWindow.cycleStart &&
          entry.date <= lastWindow.cycleEnd
        ) {
          lastCycleGross += amount;
          continue;
        }

        /*
         * Currently accruing cycle.
         *
         * It grows only until this statement's closing date.
         */
        if (
          entry.date >= currentWindow.cycleStart &&
          entry.date <= currentEffectiveEnd
        ) {
          currentCycleGross += amount;
        }
      }
    }

    const lastFullySettled =
      settlements[
        creditCardCycleSettlementKey(
          card.id,
          lastWindow.cycleEnd
        )
      ] === true;

    let lastOutstanding =
      lastCycleGross;

    let currentOutstanding =
      currentCycleGross;

    /*
     * Actual CC Due payments apply oldest-first.
     */
    let remainingPayment =
      payments;

    const paidAgainstLast =
      Math.min(
        lastOutstanding,
        remainingPayment
      );

    lastOutstanding -= paidAgainstLast;
    remainingPayment -= paidAgainstLast;

    /*
     * The manual Fully Settled flag is authoritative for the
     * previous statement.
     */
    if (lastFullySettled) {
      lastOutstanding = 0;
    }

    /*
     * An overpayment against the old statement may reduce the
     * currently accruing liability.
     */
    if (remainingPayment > 0) {
      currentOutstanding =
        Math.max(
          0,
          currentOutstanding - remainingPayment
        );
    }

    const carriedOutstanding =
      Math.max(0, lastOutstanding);

    const currentCycleAccrued =
      Math.max(0, currentOutstanding);

    const amount =
      carriedOutstanding +
      currentCycleAccrued;

    return {
      cardId: card.id,
      name: card.name,

      billingDay:
        Number(card.billingDay) || 1,

      dueDay:
        Number(card.dueDay) || 1,

      lastCycleStart:
        lastWindow.cycleStart,

      lastCycleEnd:
        lastWindow.cycleEnd,

      currentCycleStart:
        currentWindow.cycleStart,

      currentCycleEnd:
        currentWindow.cycleEnd,

      carriedDueDate:
        creditCardDueDate(
          lastWindow.cycleEnd,
          card.dueDay
        ),

      currentCycleDueDate:
        creditCardDueDate(
          currentWindow.cycleEnd,
          card.dueDay
        ),

      dueDate:
        carriedOutstanding > 0
          ? creditCardDueDate(lastWindow.cycleEnd, card.dueDay)
          : creditCardDueDate(currentWindow.cycleEnd, card.dueDay),

      effectiveEnd:
        currentEffectiveEnd,

      lastStatementGross:
        lastCycleGross,

      currentCycleGross:
        currentCycleGross,

      paidAmount:
        payments,

      carriedOutstanding,
      currentCycleAccrued,
      
      budgetAmount: lastCycleGross + currentCycleGross,
      amount,
    };
  });

  return {
    total: details.reduce(
      (sum, card) =>
        sum + card.amount,
      0
    ),

    cards: details,
  };
}

export function settledLentAmount(entry) {
  const type = String(entry?.type || '').toLowerCase();
  if (!['spend', 'cardcharge', 'cashpayment'].includes(type) || !Array.isArray(entry?.lent)) return 0;

  return entry.lent.reduce(
    (sum, lent) => lent.settled ? sum + (Number(lent.amount) || 0) : sum,
    0
  );
}

export function netSpendAmount(entry) {
  const amount = Number(entry?.amount) || 0;
  if (amount <= 0) return amount;
  return Math.max(0, amount - settledLentAmount(entry));
}

export function spendingAmountForEntry(entry) {
  const type = String(entry?.type || '').toLowerCase();
  const amount = Number(entry?.amount) || 0;

  if (amount <= 0 || ['income', 'payback', 'goal_funding'].includes(type)) return 0;
  if (type === 'spend' && String(entry?.tag || '').trim().toLowerCase() === 'atm') return 0;
  if (['spend', 'cardcharge', 'cashpayment'].includes(type)) return netSpendAmount(entry);

  return amount;
}

export function computeSpendingBreakdown(entries) {
  const breakdown = {
    regularDebit: 0,
    creditCardSpends: 0,
    creditCardDues: 0,
    cashPayments: 0,
    emi: 0,
    recurring: 0,
    sip: 0,
    investment: 0,
    total: 0,
  };

  for (const entry of (entries || [])) {
    const amount = spendingAmountForEntry(entry);
    if (amount <= 0) continue;

    const type = String(entry.type || '').toLowerCase();

    if (type === 'spend') {
      if (entry.paymentMode === 'card' || String(entry.tag || '').trim().toLowerCase() === 'cc due') {
        breakdown.creditCardDues += amount;
      } else {
        breakdown.regularDebit += amount;
      }
    } else if (type === 'cardcharge') {
      breakdown.creditCardSpends += amount;
    } else if (type === 'cashpayment') {
      breakdown.cashPayments += amount;
    } else if (type === 'emi') {
      breakdown.emi += amount;
    } else if (type === 'recurring') {
      if (entry.paymentMode === 'card') breakdown.creditCardSpends += amount;
      else breakdown.recurring += amount;
    } else if (type === 'sip') {
      breakdown.sip += amount;
    } else if (type === 'investment') {
      breakdown.investment += amount;
    }
  }

  breakdown.total =
    breakdown.regularDebit +
    breakdown.creditCardSpends +
    breakdown.creditCardDues +
    breakdown.cashPayments +
    breakdown.emi +
    breakdown.recurring +
    breakdown.sip +
    breakdown.investment;

  return breakdown;
}

export function computeMonthTotals(entries) {
  let income = 0, cashSpend = 0, cardPaymentSpend = 0, cardCharge = 0, payback = 0, recurringCash = 0;
  let others = 0, goalFunding = 0;

  for (const e of entries) {
    const amt = Number(e.amount) || 0;

    if (e.type === 'income') {
      income += amt;
    } else if (e.type === 'spend') {
      if (e.paymentMode === 'card') cardPaymentSpend += amt;
      else cashSpend += amt;
    } else if (e.type === 'cardcharge') {
      cardCharge += amt;
    } else if (e.type === 'investment' || e.type === 'emi' || e.type === 'sip') {
      others += amt;
    } else if (e.type === 'recurring') {
      others += amt;
      if (e.paymentMode === 'card') cardCharge += amt;
      else recurringCash += amt;
    } else if (e.type === 'payback') {
      cashSpend -= amt;
      payback += amt;
    } else if (e.type === 'goal_funding') {
      goalFunding += amt;
      others += amt;
    }
  }

  const spending = computeSpendingBreakdown(entries);
  const regularDebit = spending.regularDebit;
  const cashPayments = spending.cashPayments;
  const ccSpends = spending.creditCardSpends;
  const creditCardDues = spending.creditCardDues;
  const emi = spending.emi;
  const recurring = spending.recurring;
  const sip = spending.sip;
  const invest = spending.investment;
  const totalConsumption = regularDebit + cashPayments + ccSpends + emi + recurring;

  return {
    income, cashSpend, cardPaymentSpend, cardCharge, invest, emi, sip, payback, recurring, recurringCash,
    regularDebit, cashPayments, ccSpends, creditCardDues, others, totalConsumption, goalFunding,
    spendingTotal: spending.total,
  };
}

export function monthCashOutflow(totals) {
  const recCash = totals.recurringCash !== undefined ? totals.recurringCash : totals.recurring;
  return totals.cashSpend + totals.cardPaymentSpend + totals.emi + totals.invest + totals.sip + recCash;
}

/* Chronological per-month running balance, honouring each month's carry/manual mode. */
export async function computeMonthlyBreakdown(monthsIndex, emiSeries, sipSeries, recurringSeries) {
  const sortedKeys = [...monthsIndex].sort();
  const rows = [];
  let prevEnding = null;
  for (const k of sortedKeys) {
    const data = await loadMonth(k);
    const emiRows = emiRowsForMonth(emiSeries, k, data.deletedEmi).filter(r => r.date <= todayStr());
    const sipRows = sipRowsForMonth(sipSeries, k, data.deletedSip, data.sipOverrides).filter(r => r.date <= todayStr());
    const recurringRows = recurringRowsForMonth(
      recurringSeries || [],
      k,
      data.deletedRecurring,
      data.recurringOverrides
    ).filter(r => r.date <= todayStr());
    const totals = computeMonthTotals(data.entries.concat(emiRows, sipRows, recurringRows));
    let starting;
    if (data.startingBalanceMode === 'auto' && prevEnding !== null) {
      starting = prevEnding;
    } else {
      starting = Number(data.startingBalance) || 0;
    }
    const outflow = monthCashOutflow(totals);
    const ending = starting + totals.income - outflow;
    rows.push({ monthKey: k, starting, income: totals.income, outflow, ending, totals });
    prevEnding = ending;
  }
  return rows;
}

/* Day-by-day running balance, from the 1st of the earliest logged month
   through today, carried flat on days with no transactions. */
export async function computeDailyBalanceSeries(monthsIndex, emiSeries, sipSeries, recurringSeries) {
  const breakdown = await computeMonthlyBreakdown(monthsIndex, emiSeries, sipSeries, recurringSeries);
  if (!breakdown.length) return [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const series = [];

  for (const b of breakdown) {
    const data = await loadMonth(b.monthKey);
    const emiRows = emiRowsForMonth(emiSeries, b.monthKey, data.deletedEmi).filter(r => r.date <= todayStr());
    const sipRows = sipRowsForMonth(sipSeries, b.monthKey, data.deletedSip, data.sipOverrides).filter(r => r.date <= todayStr());
    const recurringRows = recurringRowsForMonth(recurringSeries || [], b.monthKey, data.deletedRecurring).filter(r => r.date <= todayStr());
    const relevant = [...data.entries, ...emiRows, ...sipRows, ...recurringRows].filter(e =>
      e.type === 'income' || e.type === 'investment' || e.type === 'emi' || e.type === 'sip' || e.type === 'recurring' || e.type === 'spend' || e.type === 'payback'
    );
    const deltaByDay = {};
    for (const e of relevant) {
      if (!e.date) continue;
      if (e.type === 'recurring' && e.paymentMode === 'card') continue;

      const amt = Number(e.amount) || 0;
      const signed = (e.type === 'income' || e.type === 'payback') ? amt : -amt;
      deltaByDay[e.date] = (deltaByDay[e.date] || 0) + signed;
    }
    const [y, m] = b.monthKey.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    let running = b.starting;
    for (let d = 1; d <= daysInMonth; d++) {
      const dateObj = new Date(y, m - 1, d);
      if (dateObj > today) break;
      const dateStr = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      if (deltaByDay[dateStr]) running += deltaByDay[dateStr];
      series.push({ date: dateStr, balance: running });
    }
  }

  if (series.length) {
    let lastDate = new Date(series[series.length - 1].date + 'T00:00:00');
    const lastBalance = series[series.length - 1].balance;
    while (lastDate < today) {
      lastDate = new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate() + 1);
      const dateStr = lastDate.getFullYear() + '-' + String(lastDate.getMonth() + 1).padStart(2, '0') + '-' + String(lastDate.getDate()).padStart(2, '0');
      series.push({ date: dateStr, balance: lastBalance });
    }
  }
  return series;
}

export function windowSeries(series, rangeMonths) {
  if (!series.length) return series;
  const lastDate = new Date(series[series.length - 1].date + 'T00:00:00');
  const cutoff = new Date(lastDate.getFullYear(), lastDate.getMonth() - rangeMonths, lastDate.getDate());
  return series.filter(p => new Date(p.date + 'T00:00:00') >= cutoff);
}

export async function computeGlobalOwed(monthsIndex, isShared, sharedSplitId, splitsIndex) {
  const byPerson = {};
  for (const k of monthsIndex) {
    const data = await loadMonth(k);
    for (const e of data.entries) {
      if (e.type === 'owed' && !e.settled) {
        const name = e.description || 'Unknown';
        byPerson[name] = byPerson[name] || { amount: 0, items: [] };
        byPerson[name].amount += Number(e.amount) || 0;
        byPerson[name].items.push({ amount: e.amount, monthKey: k, source: 'Owed' });
      }
      if ((e.type === 'spend' || e.type === 'cardcharge' || e.type === 'cashpayment') && Array.isArray(e.lent)) {
        for (const l of e.lent) {
          if (l.settled) continue;
          const name = l.person || 'Unknown';
          byPerson[name] = byPerson[name] || { amount: 0, items: [] };
          byPerson[name].amount += Number(l.amount) || 0;
          byPerson[name].items.push({ amount: l.amount, monthKey: k, source: 'Lent · ' + e.description });
        }
      }
    }
  }

  const { owedToYou } = await computeSplitPageData(isShared, sharedSplitId, splitsIndex);
  for (const [person, amount] of Object.entries(owedToYou)) {
    if (amount > 0) {
      byPerson[person] = byPerson[person] || { amount: 0, items: [] };
      byPerson[person].amount += amount;
      byPerson[person].items.push({ amount, monthKey: 'Split', source: 'Split Money' });
    }
  }

  const list = Object.entries(byPerson).map(([person, v]) => ({ person, amount: v.amount, items: v.items }))
    .sort((a, b) => b.amount - a.amount);
  const total = list.reduce((s, x) => s + x.amount, 0);
  return { total, list };
}

export async function computeGlobalInvestments(monthsIndex, sipSeries, existingInvestments) {
  let total = Number(existingInvestments) || 0;
  const monthlyAggregates = [];

  for (const k of monthsIndex) {
    const data = await loadMonth(k);
    let monthSum = 0;
    for (const e of data.entries) {
      if (e.type === 'investment') monthSum += Number(e.amount) || 0;
    }
    const sipRows = sipRowsForMonth(sipSeries, k, data.deletedSip, data.sipOverrides).filter(r => r.date <= todayStr());
    for (const s of sipRows) monthSum += Number(s.amount) || 0;

    if (monthSum > 0) {
      monthlyAggregates.push({ description: 'Investments for', amount: monthSum, monthKey: k });
      total += monthSum;
    }
  }

  monthlyAggregates.sort((a, b) => b.monthKey.localeCompare(a.monthKey));

  const list = [];
  if (Number(existingInvestments) > 0) {
    list.push({ description: 'Base Portfolio', amount: Number(existingInvestments), monthKey: null });
  }
  list.push(...monthlyAggregates);

  return { total, list };
}

export async function computeGlobalCardDues(monthsIndex, cards, recurringSeries) {
  const perCard = {};
  for (const c of cards) perCard[c.id] = { card: c, dues: 0 };
  for (const k of monthsIndex) {
    const data = await loadMonth(k);
    const recRows = recurringRowsForMonth(
      recurringSeries || [],
      k,
      data.deletedRecurring,
      data.recurringOverrides
    ).filter(r => r.date <= todayStr());
    const allEntries = data.entries.concat(recRows);
    for (const e of allEntries) {
      if ((e.type === 'cardcharge' || (e.type === 'recurring' && e.paymentMode === 'card')) && e.cardId) {
        perCard[e.cardId] = perCard[e.cardId] || { card: cardById(cards, e.cardId), dues: 0 };
        perCard[e.cardId].dues += Number(e.amount) || 0;
      }
      if (e.type === 'spend' && e.paymentMode === 'card' && e.cardId) {
        perCard[e.cardId] = perCard[e.cardId] || { card: cardById(cards, e.cardId), dues: 0 };
        perCard[e.cardId].dues -= Number(e.amount) || 0;
      }
    }
  }
  const list = Object.values(perCard).filter(x => x.card).map(x => ({ cardId: x.card.id, name: x.card.name, billingDay: Number(x.card.billingDay) || 1, dueDay: Number(x.card.dueDay) || 1, dues: x.dues }));
  const total = list.reduce((s, x) => s + x.dues, 0);
  return { total, list };
}

/**
 * Full cross-page dashboard bundle. Callers pass in exactly the domain
 * data they already loaded (cards/emiSeries/sipSeries/monthsIndex/
 * existingInvestments) — nothing is fetched implicitly here.
 */
export async function computeGlobalStats({ cards, emiSeries, sipSeries, recurringSeries, monthsIndex, existingInvestments, isShared, sharedSplitId, splitsIndex }) {
  const [owed, invested, cardDues, breakdown] = await Promise.all([
    computeGlobalOwed(monthsIndex, isShared, sharedSplitId, splitsIndex),
    computeGlobalInvestments(monthsIndex, sipSeries, existingInvestments),
    computeGlobalCardDues(monthsIndex, cards, recurringSeries),
    computeMonthlyBreakdown(monthsIndex, emiSeries, sipSeries, recurringSeries),
  ]);
  const amountLeft = breakdown.length ? breakdown[breakdown.length - 1].ending : 0;
  return { owed, invested, cardDues, breakdown, amountLeft };
}

export function allSpendTags(defaultTags, customTags) {
  const seen = new Set();
  const out = [];
  for (const t of [...defaultTags, ...customTags]) {
    const key = String(t).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export function forecastCategorySpend(categoryName, isSub, parentName, budget, monthKey, currentMonthEntries) {
  if (budget <= 0 || !currentMonthEntries) return null;
  
  const today = new Date();
  const currentKey = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0');
  if (monthKey !== currentKey) return null;

  const dayOfMonth = today.getDate();
  if (dayOfMonth < 7) return null;
  
  const [y, m] = monthKey.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const todayStrVal = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  
  const sevenDaysAgoDt = new Date(today);
  sevenDaysAgoDt.setDate(today.getDate() - 7);
  const sevenDaysAgoStr = sevenDaysAgoDt.getFullYear() + '-' + String(sevenDaysAgoDt.getMonth() + 1).padStart(2, '0') + '-' + String(sevenDaysAgoDt.getDate()).padStart(2, '0');

  const target = categoryName.toLowerCase().trim();
  const pTarget = parentName ? parentName.toLowerCase().trim() : null;

  let variableSpentSoFar = 0;
  let recurringPosted = 0;
  let recurringRemaining = 0;
  let variableLast7Days = 0;
  let maxRecurringDate = null;
  let totalEntries = 0;
  let autoEntries = 0;

  for (const e of currentMonthEntries) {
    if (e.type === 'income' || e.type === 'payback' || e.type === 'goal_funding') continue;
    const amt = spendingAmountForEntry(e);
    if (amt <= 0) continue;

    if (!matchesCategory(e, target, isSub, pTarget)) continue;
    
    totalEntries++;
    const eType = (e.type || '').toLowerCase();
    const isAuto = (eType === 'emi' || eType === 'sip' || eType === 'recurring');
    if (isAuto) autoEntries++;

    if (isAuto) {
      if (!e.date || e.date <= todayStrVal) recurringPosted += amt;
      else recurringRemaining += amt;
      
      if (e.date && (!maxRecurringDate || e.date > maxRecurringDate)) {
        maxRecurringDate = e.date;
      }
    } else {
      if (!e.date || e.date <= todayStrVal) {
        variableSpentSoFar += amt;
        if (e.date && e.date > sevenDaysAgoStr) {
          variableLast7Days += amt;
        }
      }
    }
  }

  const isAutoOnly = (target === 'emi' || target === 'sip' || target === 'recurring') || (totalEntries > 0 && autoEntries === totalEntries);
  let projectedByMonthEnd = 0;
  let projectedOverBudget = 0;
  let message = '';
  let severity = 'ok';

  const fmtAmt = (val) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Math.round(val));

  if (isAutoOnly) {
    projectedByMonthEnd = recurringPosted + recurringRemaining;
    if (projectedByMonthEnd === 0) return null;
    projectedOverBudget = Math.max(0, projectedByMonthEnd - budget);
    
    let dateDisplay = 'month-end';
    if (maxRecurringDate) {
      const [,, d] = maxRecurringDate.split('-');
      const dt = new Date(maxRecurringDate + 'T00:00:00');
      dateDisplay = parseInt(d) + ' ' + dt.toLocaleDateString('en-IN', { month: 'short' });
    }

    if (projectedOverBudget <= 0) {
      message = `<span>${fmtAmt(projectedByMonthEnd)} auto-spent by ${dateDisplay}</span>`;
      severity = 'ok';
    } else {
      message = `<span>${fmtAmt(projectedByMonthEnd)} auto-spent by ${dateDisplay}. </span><span style="font-size: 0.9em; margin-top: 2px; color: var(--debit);">Consider increasing budget to ${fmtAmt(projectedByMonthEnd)}.</span>`;
      severity = 'auto-over';
    }
  } else {
    const recentDayRange = Math.min(dayOfMonth, 7);
    const variableDailyAvg = variableLast7Days / recentDayRange;
    const daysRemaining = daysInMonth - dayOfMonth;
    const variableProjectedRemaining = variableDailyAvg * daysRemaining;

    projectedByMonthEnd = variableSpentSoFar + recurringPosted + recurringRemaining + variableProjectedRemaining;
    projectedOverBudget = Math.max(0, projectedByMonthEnd - budget);

    if (variableSpentSoFar === 0 && recurringPosted === 0 && variableLast7Days === 0) {
      return null;
    } else if (projectedOverBudget <= 0) {
      const under = budget - projectedByMonthEnd;
      message = `<span>On pace to spend ${fmtAmt(projectedByMonthEnd)} — ${fmtAmt(under)} under budget</span>`;
      severity = 'ok';
    } else {
      message = `<span>On pace to spend ${fmtAmt(projectedByMonthEnd)} — ${fmtAmt(projectedOverBudget)} over budget</span>`;
      severity = 'warning';
    }
  }

  return {
    projectedByMonthEnd,
    projectedOverBudget,
    variableSpentSoFar,
    recurringRemaining,
    maxRecurringDate,
    isAutoOnly,
    message,
    severity
  };
}
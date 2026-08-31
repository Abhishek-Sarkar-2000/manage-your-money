/* ---------- Month + cross-month domain logic ----------
   Ported verbatim from the monolith's month/EMI/SIP/global-stat functions.
   Each view calls only the pieces it needs — nothing here is invoked at
   boot for every page the way the old loadCore() was. */
import { Store } from './store.js';
import { currentMonthKey, diffMonths } from './format.js';
import { computeSplitPageData } from './split-domain.js';

/* In-memory per-page-load cache. Fresh on every navigation (a real page
   load now), so there's no cross-route staleness to manage. */
const monthCache = {};

export async function loadMonth(key) {
  if (monthCache[key]) return monthCache[key];
  const data = await Store.get('month:' + key, {
    startingBalanceMode: 'manual', startingBalance: 0, entries: [], deletedEmi: [], deletedSip: [], deletedRecurring: [],
  });
  if (!data.startingBalanceMode) data.startingBalanceMode = 'manual';
  if (!data.deletedSip) data.deletedSip = [];
  if (!data.deletedRecurring) data.deletedRecurring = [];
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
  for (const series of emiSeries) {
    const inst = diffMonths(series.startMonth, monthKey) + 1;
    if (inst >= 1 && inst <= series.totalMonths) {
      if ((deletedEmi || []).includes(series.id)) continue;
      rows.push({
        id: 'emi-' + series.id + '-' + monthKey, type: 'emi', date: monthKey + '-01',
        description: series.description, amount: series.monthlyAmount,
        seriesId: series.id, installment: inst, totalMonths: series.totalMonths,
      });
    }
  }
  return rows;
}

export function sipRowsForMonth(sipSeries, monthKey, deletedSip) {
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
    rows.push({
      id: 'sip-' + series.id + '-' + monthKey, type: 'sip', date: dateStr,
      description: series.description, amount: series.amount, seriesId: series.id,
    });
  }
  return rows;
}

/* Maps a recurring series' "date of deduction" (1-31) onto a real date for
   the given monthKey, clamping to the month's last valid day when the
   chosen date doesn't exist that month (e.g. the 31st in February). */
export function recurringRowsForMonth(recurringSeries, monthKey, deletedRecurring) {
  const rows = [];
  const [y, m] = monthKey.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  for (const series of recurringSeries) {
    if (series.startMonth && series.startMonth > monthKey) continue;
    if ((deletedRecurring || []).includes(series.id)) continue;
    const targetDay = Math.min(Math.max(Number(series.dayOfMonth) || 1, 1), 31);
    const day = Math.min(targetDay, daysInMonth);
    const dateStr = monthKey + '-' + String(day).padStart(2, '0');
    rows.push({
      id: 'recurring-' + series.id + '-' + monthKey, type: 'recurring', date: dateStr,
      description: series.description, amount: series.amount, seriesId: series.id,
      paymentMode: series.paymentMode || 'bank', cardId: series.cardId || null,
    });
  }
  return rows;
}

export function computeMonthTotals(entries) {
  let income = 0, cashSpend = 0, cardPaymentSpend = 0, cardCharge = 0, invest = 0, emi = 0, sip = 0, payback = 0, recurring = 0, recurringCash = 0;
  let regularDebit = 0, cashPayments = 0, ccSpends = 0, others = 0;

  for (const e of entries) {
    const amt = Number(e.amount) || 0;
    if (e.type === 'income') {
      income += amt;
    } else if (e.type === 'spend') {
      if (e.paymentMode === 'card') {
        cardPaymentSpend += amt;
      } else {
        cashSpend += amt;
        if (e.tag !== 'ATM') regularDebit += amt;
      }
    } else if (e.type === 'cardcharge') {
      cardCharge += amt;
      ccSpends += amt;
    } else if (e.type === 'cashpayment') {
      cashPayments += amt;
    } else if (e.type === 'investment') {
      invest += amt;
      others += amt;
    } else if (e.type === 'emi') {
      emi += amt;
      others += amt;
    } else if (e.type === 'sip') {
      sip += amt;
      others += amt;
    } else if (e.type === 'recurring') {
      recurring += amt;
      others += amt;
      if (e.paymentMode === 'card') {
        cardCharge += amt;
        ccSpends += amt;
      } else {
        recurringCash += amt;
      }
    } else if (e.type === 'payback') {
      // Settlement of a "Lent" chip. Restores the running balance (it's
      // modelled as a negative regular cash outflow, same lever as a
      // spend) without ever touching `income`, so the Cashflow Overview's
      // Total Income stat isn't inflated by getting your own money back.
      cashSpend -= amt;
      regularDebit -= amt;
      payback += amt;
    }
  }

  const totalConsumption = regularDebit + cashPayments + ccSpends + emi + recurring;

  return {
    income, cashSpend, cardPaymentSpend, cardCharge, invest, emi, sip, payback, recurring, recurringCash,
    regularDebit, cashPayments, ccSpends, others, totalConsumption,
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
    const emiRows = emiRowsForMonth(emiSeries, k, data.deletedEmi);
    const sipRows = sipRowsForMonth(sipSeries, k, data.deletedSip);
    const recurringRows = recurringRowsForMonth(recurringSeries || [], k, data.deletedRecurring);
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
    const emiRows = emiRowsForMonth(emiSeries, b.monthKey, data.deletedEmi);
    const sipRows = sipRowsForMonth(sipSeries, b.monthKey, data.deletedSip);
    const recurringRows = recurringRowsForMonth(recurringSeries || [], b.monthKey, data.deletedRecurring);
    const relevant = [...data.entries, ...emiRows, ...sipRows, ...recurringRows].filter(e =>
      e.type === 'income' || e.type === 'investment' || e.type === 'emi' || e.type === 'sip' || e.type === 'recurring' || e.type === 'spend' || e.type === 'payback'
    );
    const deltaByDay = {};
    for (const e of relevant) {
      if (!e.date) continue;
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
    const sipRows = sipRowsForMonth(sipSeries, k, data.deletedSip);
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
    const recRows = recurringRowsForMonth(recurringSeries || [], k, data.deletedRecurring);
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
  const list = Object.values(perCard).filter(x => x.card).map(x => ({ name: x.card.name, dues: x.dues }));
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

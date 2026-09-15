/* ---------- /budget ---------- */
import { Store } from '../core/store.js';
import { $, $$, uid, escapeHtml } from '../core/dom.js';
import { fmtINR, currentMonthKey, addMonths, monthKeyLabel } from '../core/format.js';
import { authReady } from '../core/auth.js';
import { appendPageChrome } from '../components/page-chrome.js';
import { showToast } from '../components/toast.js';
import { markRendered } from '../components/render-guard.js';
import { showDeleteCallout, hideDeleteCallout, wireDeletePopoverDismiss } from '../components/delete-popover.js';
import {
  loadMonth, saveMonth, cardById, allSpendTags, ensureMonthIndexed,
  emiRowsForMonth, sipRowsForMonth, recurringRowsForMonth,
  forecastCategorySpend, matchesCategory, migrateBudgetData,
  validateGroupBudget, validateCategoryBudget, validateCategoryMove
} from '../core/domain.js';
import { computeGoalRecommendation } from '../core/goal-algorithm.js';

const root = document.getElementById('budget-root');
const DEFAULT_TAGS = ['Groceries', 'Food', 'Fuel', 'Transport', 'Rent', 'Utility', 'Shopping', 'Recharge', 'Medicine', 'Gift', 'EMI', 'RECURRING', 'Fund', 'Stock', 'FD', 'Bond', 'MF', 'ETF'];

const INVESTMENT_BUDGET_MAP = { fund: 'Fund', 'lump-sum mf': 'Fund', stock: 'Stock', 'fixed deposit': 'FD', fd: 'FD', bond: 'Bond', 'mutual fund': 'MF', mf: 'MF', etf: 'ETF' };

function investmentBudgetCategory(entry) {
  const type = String(entry?.type || '').toLowerCase();
  const raw = String(entry?.category || '').trim().toLowerCase();
  return (type === 'investment' || type === 'sip') ? (INVESTMENT_BUDGET_MAP[raw] || null) : null;
}

// Sensible default classification for each built-in tag — used to seed
// new categories and as a fallback for legacy categories saved before
// this field existed. Anything not listed here, including all custom
// tags, defaults to "discretionary".
const DEFAULT_TAG_CLASSIFICATIONS = {
  groceries: 'essential', food: 'essential', fuel: 'essential', transport: 'essential',
  rent: 'essential', utility: 'essential', medicine: 'essential', emi: 'essential', recurring: 'essential',
  sip: 'investment', investment: 'investment', fund: 'investment', stock: 'investment', fd: 'investment', bond: 'investment', mf: 'investment', etf: 'investment',
  shopping: 'discretionary', recharge: 'discretionary', gift: 'discretionary',
};

function defaultClassificationForTag(name) {
  const key = String(name || '').toLowerCase().trim();
  return DEFAULT_TAG_CLASSIFICATIONS[key] || 'discretionary';
}

function classificationOf(cat) {
  return cat.classification || defaultClassificationForTag(cat.name);
}

const dotsSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="12" cy="12" r="2"></circle><circle cx="12" cy="5" r="2"></circle><circle cx="12" cy="19" r="2"></circle></svg>`;

let budgetData = [];
let customTags = [];
let emiSeries = [];
let sipSeries = [];
let recurringSeries = [];
let currentMonthEntries = [];
let monthsIndex = [];
let domainLoaded = false;
let isFormOpen = false;
let isGoalFormOpen = false;
let monthEntries = [];
let draggedItem = null;
let goals = [];
let budgetDataByMonthMemo = {};
let entriesByMonthMemo = {};

let currentKey = currentMonthKey();
let isPastMonth = false;

async function loadDomain() {
  if (domainLoaded) return;
  [customTags, emiSeries, sipSeries, recurringSeries, monthsIndex, goals] = await Promise.all([
    Store.get('custom-spend-tags', []),
    Store.get('emiseries', []),
    Store.get('sipseries', []),
    Store.get('recurringseries', []),
    Store.get('months-index', []),
    Store.get('goals', []),
  ]);
  
  // Pre-fetch past 6 months data for the goal algorithm
  const past6 = [...monthsIndex].filter(m => m < currentMonthKey()).sort().slice(-6);
  await Promise.all(past6.map(async mk => {
    const data = await loadMonth(mk);
    entriesByMonthMemo[mk] = data.entries || [];
    let bd = await Store.get(`budget-data:${mk}`, null);
    if (!bd) bd = await Store.get('budget-data', []);
    budgetDataByMonthMemo[mk] = migrateBudgetData(bd);
  }));
  
  domainLoaded = true;
}

function calculateUsed(name, isSub, parentName) {
  if (!name || !currentMonthEntries) return 0;
  let total = 0;
  const target = String(name).trim().toLowerCase();
  for (const e of currentMonthEntries) {
    if (e.type === 'income' || e.type === 'payback' || e.type === 'goal_funding') continue;
    const amt = Number(e.amount) || 0;
    if (amt <= 0) continue;

    // Investments are bucketed from Month/SIP asset categories. This makes
    // Fund/Stock/FD/Bond/MF/ETF usable as Budget categories without changing
    // the labels stored by the Month and SIP pages.
    const investmentBucket = investmentBudgetCategory(e);
    if (!isSub && investmentBucket && investmentBucket.toLowerCase() === target) {
      total += amt;
      continue;
    }

    if (matchesCategory(e, name, isSub, parentName)) total += amt;
  }
  return total;
}

// pct -> { label, cls } used for both row status pills and the KPI overall pill
function getStatusInfo(pct) {
  if (pct > 100) return { label: 'Over budget', cls: 'status-over' };
  if (pct > 70) return { label: 'High spend', cls: 'status-high' };
  return { label: 'On track', cls: 'status-ontrack' };
}

// Goal funding never enters totalBudget, totalUsed, or totalSpent — only the Goals section's own numbers.
function computeSummary() {
  let totalBudget = 0;
  let totalUsed = 0;
  let totalIncome = 0;
  let totalSpent = 0;

  if (currentMonthEntries) {
    for (const e of currentMonthEntries) {
      if (e.type === 'goal_funding') continue;
      const amt = Number(e.amount) || 0;
      if (e.type === 'income') {
        totalIncome += amt;
      } else if (e.type !== 'payback' && amt > 0) {
        totalSpent += amt;
      }
    }
  }

  budgetData.forEach(group => {
    totalBudget += Number(group.budget) || 0;
    (group.categories || []).forEach(cat => {
      totalUsed += calculateUsed(cat.name, false, null);
    });
  });

  const totalRemaining = totalBudget - totalUsed;
  const usedPct = totalBudget > 0 ? (totalUsed / totalBudget) * 100 : (totalUsed > 0 ? 100 : 0);
  const remainingPct = totalBudget > 0 ? Math.max(0, (totalRemaining / totalBudget) * 100) : 0;
  const unallocated = totalIncome - totalBudget;
  const totalSavings = totalIncome - totalSpent;
  const savingsPct = totalIncome > 0 ? Math.max(0, (totalSavings / totalIncome) * 100) : 0;
  const spentPct = totalBudget > 0 ? (totalSpent / totalBudget) * 100 : (totalSpent > 0 ? 100 : 0);

  return { totalBudget, totalUsed, totalRemaining, usedPct, remainingPct, totalIncome, unallocated, totalSpent, totalSavings, savingsPct, spentPct };
}

// Finds spend that isn't captured under any budgeted top-level category —
// e.g. a tag the user spent against but never set a budget for. Mirrors
// the same special-case classification calculateUsed() uses (sip/recurring/
// emi/tag) so a transaction is never double-counted as both "used" under
// a category AND "unbudgeted".
function calculateUnbudgeted() {
  if (!currentMonthEntries) return { total: 0, tags: [] };

  const budgetedNames = new Set();
  budgetData.forEach(g => (g.categories || []).forEach(c => budgetedNames.add(c.name.toLowerCase().trim())));
  const byTag = new Map(); // key: lowercase label -> { label, amount, count }
  let total = 0;

  for (const e of currentMonthEntries) {
    if (e.type === 'income' || e.type === 'payback') continue;
    const amt = Number(e.amount) || 0;
    if (amt <= 0) continue;

    const eType = (e.type || '').toLowerCase();
    const eTag = (e.tag || '').toLowerCase();
    const eCat = (e.category || '').toLowerCase();
    const investmentBucket = investmentBudgetCategory(e);

    let key;
    let label;
    if (investmentBucket) {
      key = investmentBucket.toLowerCase();
      label = investmentBucket;
    } else if (eType === 'sip' || eTag === 'sip' || eCat === 'sip') {
      key = 'sip'; label = 'SIP';
    } else if (eType === 'recurring' || eTag === 'recurring') {
      key = 'recurring'; label = 'Recurring';
    } else if (eType === 'emi' || eTag === 'emi') {
      key = 'emi'; label = 'EMI';
    } else if (eTag) {
      key = eTag; label = e.tag;
    } else if (eCat) {
      key = eCat; label = e.category;
    } else {
      key = 'uncategorized'; label = 'Uncategorized';
    }

    if (budgetedNames.has(key)) continue; // already accounted for in a category's "used"

    total += amt;
    const existing = byTag.get(key);
    if (existing) {
      existing.amount += amt;
      existing.count += 1;
    } else {
      byTag.set(key, { label: label || 'Uncategorized', amount: amt, count: 1 });
    }
  }

  const tags = Array.from(byTag.values()).sort((a, b) => b.amount - a.amount);
  return { total, tags };
}

function renderUnbudgetedCallout() {
  const { total, tags } = calculateUnbudgeted();
  if (total <= 0 || tags.length === 0) return '';

  const warnSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path></svg>`;
  const chevronSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`;

  const rows = tags.map(t => `
    <div class="unbudgeted-row">
      <span class="unbudgeted-row-label">${escapeHtml(t.label)}</span>
      <span class="unbudgeted-row-meta">${t.count} ${t.count === 1 ? 'txn' : 'txns'}</span>
      <span class="unbudgeted-row-amt">${fmtINR(t.amount)}</span>
      <button class="icon-btn" data-view-txns="${escapeHtml(t.label)}" title="View transactions" style="margin-left: 6px; padding: 2px;">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
      </button>
    </div>
  `).join('');

  return `
  <div style="display: flex; align-items: center; gap: 8px; margin-top: 32px; margin-bottom: 16px;">
    <span style="color: var(--blue); display: flex;">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-3.5.9.9-3.5 9.1-9.9z"/><line x1="6" y1="10" x2="10" y2="10"/><line x1="6" y1="14" x2="9" y2="14"/></svg>
    </span>
    <h3 style="margin: 0;">Budget Planner</h3>
  </div>
  <div class="unbudgeted-callout" data-unbudgeted-callout style="border: 1px solid var(--amber); border-radius: 12px; background: var(--amber-bg);">
    <button class="unbudgeted-summary" data-unbudgeted-toggle type="button">
      <span class="unbudgeted-icon">${warnSvg}</span>
      <span class="unbudgeted-text"><strong>${fmtINR(total)}</strong> unbudgeted this month across ${tags.length} ${tags.length === 1 ? 'tag' : 'tags'}</span>
      <span class="unbudgeted-chevron">${chevronSvg}</span>
    </button>
    <div class="unbudgeted-wrap" data-unbudgeted-wrap>
      <div class="unbudgeted-inner">
        ${rows}
      </div>
    </div>
  </div>
  `;
}

function renderSummaryCards() {
  const { totalBudget, totalUsed, totalRemaining, usedPct, remainingPct, totalIncome, unallocated, totalSpent, totalSavings, savingsPct, spentPct } = computeSummary();
  const status = getStatusInfo(usedPct);

  const briefcaseSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"></rect><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"></path><path d="M2 13h20"></path></svg>`;
  const coinsSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="8" ry="3"></ellipse><path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6"></path><path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"></path></svg>`;
  const clockSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 15"></polyline></svg>`;
  const alertIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="var(--debit)" class="alert-svg" "><path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM11 15V17H13V15H11ZM11 7V13H13V7H11Z"/></svg>`;

  const savingsClass = totalSavings < 0 ? 'negative' : '';
  const savingsPctDisplay = totalSavings < 0 ? '0%' : `${savingsPct.toFixed(1)}%`;

  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const clampedPct = Math.min(Math.max(usedPct, 0), 100);
  const dashOffset = circumference - (clampedPct / 100) * circumference;
  const ringColor = usedPct > 100 ? 'var(--debit)' : 'var(--credit)';

  let incomeReportHtml = '';
  let forecastReportHtml = '';
  let budgetCardContent = '';

  if (totalIncome > 0) {
    const diamondExclamation = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 2L22 12L12 22L2 12ZM11 7H13V13H11V7ZM11 15H13V17H11V15Z"/></svg>`;
    
    incomeReportHtml = `
      <div class="income-report-banner">
        <span class="irb-icon">${diamondExclamation}</span>
        <span class="irb-text">Income for the month: <strong>${fmtINR(totalIncome)}</strong></span>
      </div>
    `;

    const unallocatedClass = unallocated < 0 ? 'negative' : '';
    const unallocatedDisplay = unallocated < 0 ? `-${fmtINR(Math.abs(unallocated))}` : fmtINR(unallocated);
    const subTextColor = unallocated < 0 ? 'var(--debit)' : 'var(--muted)';
    
    budgetCardContent = `
      <div class="kpi-label" style="${unallocated < 0 ? 'color: var(--debit);' : ''}">Left to Budget</div>
      <div class="kpi-value ${unallocatedClass}">${unallocatedDisplay}</div>
      <div class="kpi-sub" style="color: ${subTextColor}; font-weight: ${unallocated < 0 ? '600' : 'normal'};">${unallocated < 0 ? 'Over-allocated!' : `Total ${fmtINR(totalBudget)}`}</div>
    `;
  } else {
    budgetCardContent = `
      <div class="kpi-label">Total Budget</div>
      <div class="kpi-value">${fmtINR(totalBudget)}</div>
    `;
  }

  if (currentMonthEntries && currentKey === currentMonthKey()) {
    const today = new Date();
    if (today.getDate() >= 7) {
      let totalForecast = 0;
      let hasForecast = false;

      budgetData.forEach(group => {
        (group.categories || []).forEach(cat => {
          const forecast = forecastCategorySpend(cat.name, false, null, cat.budget, currentKey, currentMonthEntries);
          if (forecast) {
            totalForecast += forecast.projectedByMonthEnd;
            hasForecast = true;
          }
        });
      });

      if (hasForecast) {
        const unbudgetedTotal = calculateUnbudgeted().total;
        const projectedTotalSpend = totalForecast + unbudgetedTotal;
        const benchmarkValue = totalIncome;
        const benchmarkLabel = 'income';
        const isOver = projectedTotalSpend > benchmarkValue;
        const diffAmount = Math.abs(projectedTotalSpend - benchmarkValue);
        const overUnderText = isOver ? 'over' : 'under';

        const forecastIcon = isOver
          ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 18 13 8 3 18"></polyline><polyline points="17 18 23 18 23 12"></polyline></svg>`
          : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

        const bannerClass = isOver ? 'frb-over' : 'frb-under';

        forecastReportHtml = `
          <div class="forecast-report-banner ${bannerClass}">
            <span class="frb-icon">${forecastIcon}</span>
            <span class="frb-text">On pace to spend <strong>${fmtINR(projectedTotalSpend)}</strong> — ${fmtINR(diffAmount)} ${overUnderText} ${benchmarkLabel}</span>
          </div>
        `;
      }
    }
  }

  return `
  ${incomeReportHtml}
  ${forecastReportHtml}
  <div class="budget-summary-grid">
    <div class="kpi-card">
      <div class="kpi-icon" style="position: relative;">
        ${briefcaseSvg}
        ${unallocated < 0 ? alertIcon : ''}
      </div>
      <div class="kpi-body">
        ${budgetCardContent}
      </div>
    </div>
    <div class="kpi-card">
      <div class="kpi-icon" style="position: relative;">
        ${coinsSvg}
        ${spentPct > 100 ? alertIcon : ''}
      </div>
      <div class="kpi-body">
        <div class="kpi-label" style="${spentPct > 100 ? 'color: var(--debit);' : ''}">Spent</div>
        <div class="kpi-value ${spentPct > 100 ? 'negative' : ''}">${fmtINR(totalSpent)}</div>
        <div class="kpi-sub" style="${spentPct > 100 ? 'color: var(--debit);' : 'color: var(--blue);'}">${spentPct.toFixed(1)}% of budget</div>
      </div>
    </div>
    <div class="kpi-card">
      <div class="kpi-icon" style="position: relative;">
        ${clockSvg}
        ${totalSavings < 0 ? alertIcon : ''}
      </div>
      <div class="kpi-body">
        <div class="kpi-label" style="${totalSavings < 0 ? 'color: var(--debit);' : ''}">Savings</div>
        <div class="kpi-value ${savingsClass}">${fmtINR(totalSavings)}</div>
        <div class="kpi-sub" style="${totalSavings < 0 ? 'color: var(--debit);' : 'color: var(--credit);'}">${savingsPctDisplay} of income</div>
      </div>
    </div>
    <div class="kpi-card status-card">
      <div style="position: relative; display: flex; flex-shrink: 0;">
        <svg width="48" height="48" viewBox="0 0 48 48">
          <circle cx="24" cy="24" r="${radius}" fill="none" stroke="var(--sky)" stroke-width="5"></circle>
          <circle cx="24" cy="24" r="${radius}" fill="none" stroke="${ringColor}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${dashOffset.toFixed(2)}" transform="rotate(-90 24 24)"></circle>
          <text x="24" y="28" text-anchor="middle" font-size="11" font-family="'IBM Plex Mono', monospace" fill="var(--navy)">${Math.round(usedPct)}%</text>
        </svg>
        ${usedPct > 100 ? alertIcon.replace('top: -4px; right: -4px;', 'top: 0px; right: 0px;') : ''}
      </div>
      <div class="kpi-body">
        <div class="kpi-label" style="${usedPct > 100 ? 'color: var(--debit);' : ''}">
          <span class="hide-sm">Budget Utilization</span>
          <span class="show-sm">Utilization</span>
        </div>
        <div class="kpi-sub">${usedPct.toFixed(1)}% used</div>
        <span class="kpi-status-pill status-pill ${status.cls}">${status.label}</span>
      </div>
    </div>
  </div>
  `;
}

function renderBudgetRow(item, isSub, parentId, groupId) {
  let parentName = null;
  if (isSub && parentId) {
    for (const g of budgetData) {
      const parent = (g.categories || []).find(c => c.id === parentId);
      if (parent) { parentName = parent.name; break; }
    }
  }
  const used = calculateUsed(item.name, isSub, parentName);
  const pct = item.budget > 0 ? (used / item.budget) * 100 : 0;
  const isDanger = pct > 100;
  const status = item.budget > 0 ? getStatusInfo(pct) : { label: 'Unassigned', cls: 'status-unassigned' };

  let forecastHtml = '';
  const forecast = forecastCategorySpend(item.name, isSub, parentName, item.budget, currentKey, currentMonthEntries);
  if (forecast) {
    const svgs = {
      'ok': `<svg class="forecast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
      'warning': `<svg class="forecast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 18 13 8 3 18"></polyline><polyline points="17 18 23 18 23 12"></polyline></svg>`,
      'auto-over': `<svg class="forecast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 20h20L12 2z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`
    };
    forecastHtml = `
      <div class="budget-forecast ${forecast.severity}">
        ${svgs[forecast.severity]}<span class="bf-text">${forecast.message}</span>
      </div>
    `;
  }

  const dragHandleSvg = `<svg class="drag-handle" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"></circle><circle cx="15" cy="6" r="1.6"></circle><circle cx="9" cy="12" r="1.6"></circle><circle cx="15" cy="12" r="1.6"></circle><circle cx="9" cy="18" r="1.6"></circle><circle cx="15" cy="18" r="1.6"></circle></svg>`;

  const pencilSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>`;
  const eyeSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
  const warnSvg = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path></svg>`;

  let chevronHtml = '';
  if (!isSub) {
    chevronHtml = `<button class="toggle-sub ${item.expanded ? 'expanded' : ''}" data-toggle-sub="${item.id}" title="${item.expanded ? 'Collapse' : 'Expand'}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></button>`;
  }

  let classificationHtml = '';
  if (!isSub) {
    const currentClass = classificationOf(item);
    const classDefs = [
      { key: 'essential', label: 'Essential', letter: 'E' },
      { key: 'investment', label: 'Investment', letter: 'I' },
      { key: 'discretionary', label: 'Discretionary (Optional)', letter: 'O' },
    ];
    classificationHtml = `
      <div class="cat-classification-toggle" title="Goal-funding priority classification">
        ${classDefs.map(c => `
          <button type="button" class="cat-class-dot cat-class-${c.key} ${currentClass === c.key ? 'active' : ''}" data-set-classification="${c.key}" data-cat-id="${item.id}" title="${c.label}">${c.letter}</button>
        `).join('')}
      </div>
    `;
  }

  let actionsContent = '';
  if (!isPastMonth) {
    actionsContent = `
      <button class="edit-budget-btn icon-btn row-menu-btn" data-edit-budget="${item.id}" data-type="${isSub ? 'sub' : 'cat'}" ${parentId ? `data-parent-id="${parentId}"` : ''} title="Edit budget">
        <span class="row-menu-icon">${pencilSvg}</span><span class="row-menu-text">Edit</span>
      </button>
      <button class="icon-btn row-menu-btn" data-popover-trigger data-del-budget="${item.id}" data-type="${isSub ? 'sub' : 'cat'}" ${parentId ? `data-parent-id="${parentId}"` : ''} title="Remove">
        <span class="row-menu-icon">✕</span><span class="row-menu-text">Delete</span>
      </button>
    `;
  }

  return `
  <div class="budget-row ${isSub ? 'is-sub' : ''}" data-id="${item.id}" data-type="${isSub ? 'sub' : 'cat'}" data-parent-id="${parentId ? parentId : ''}" data-group-id="${groupId}" draggable="${!isPastMonth}">
    <div class="cat-name-col">
      ${classificationHtml}
      <div class="cat-name-inner" style="display:flex; align-items:center; gap:8px;">
        ${dragHandleSvg}
        <span style="font-weight:600; color:var(--navy); font-family:'Source Serif 4', Georgia, serif; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(item.name)}</span>
      </div>
    </div>
    <div class="budget-amt-col">
      ${fmtINR(item.budget)}
    </div>
    <div class="budget-progress" style="display:flex; flex-direction:column; gap:6px; width:100%;">
      <div class="budget-text" style="display:flex; justify-content:flex-end; gap:6px; font-family:'IBM Plex Mono', monospace; font-size:0.8rem; font-weight:600; color:var(--navy);">
        <span>${fmtINR(used)}</span> <span style="color:var(--muted);">(${status.cls === 'status-unassigned' ? '--' : Math.round(pct)}%)</span>
      </div>
      <div class="bp-bar"><div class="bp-fill ${isDanger ? 'danger' : ''}" style="width: ${Math.min(pct, 100)}%;"></div></div>
      ${forecastHtml}
    </div>
    <div class="status-col">
      <span class="status-pill ${status.cls}">${status.cls === 'status-high' ? warnSvg : ''}${status.label}</span>
    </div>
    <div class="actions-col">
      ${chevronHtml}
      <div class="row-actions-menu">
        <button class="icon-btn row-menu-btn" data-view-txns="${escapeHtml(item.name)}" title="View transactions">
          <span class="row-menu-icon">${eyeSvg}</span><span class="row-menu-text">Check</span>
        </button>
        ${actionsContent}
      </div>
      <button class="icon-btn mobile-actions-toggle" data-toggle-row-actions title="Actions">${dotsSvg}</button>
    </div>
  </div>
  `;
}

function renderGoalsSection() {
  const goalFormHtml = isGoalFormOpen && !isPastMonth ? `
  <div class="form-panel slide-down-fade" style="margin: 14px 0px;">
    <div class="form-row">
      <div class="field"><label>Goal Name</label><input id="f-goal-name" type="text" placeholder="e.g. Emergency Fund" /></div>
      <div class="field"><label>Target Amount (₹)</label><input id="f-goal-target" type="number" step="1" min="0" placeholder="0" /></div>
      <div class="field"><label>Expected Completion</label><input id="f-goal-month" type="month" min="${currentMonthKey()}" /></div>
    </div>
    <label class="checkline"><input type="checkbox" id="f-goal-downpayment-toggle" /> Has an earlier funding milestone</label>
    <div class="form-row" id="f-goal-downpayment-wrap" style="display:none;">
      <div class="field"><label>Funding Amount (₹)</label><input id="f-goal-downpayment" type="number" step="1" min="0" placeholder="0" /></div>
    </div>
    <div class="form-actions">
      <button class="btn primary" data-submit-goal type="button">Save Goal</button>
      <button class="btn ghost" data-close-goal-form type="button">Cancel</button>
    </div>
  </div>
  ` : '';

  const goalIconSvg = `<svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg>`;

  const sectionHeaderHtml = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="color: var(--blue); display: flex;">
          ${goalIconSvg}
        </span>
        <h3 style="margin: 0;">Financial Goals</h3>
      </div>
      ${!isPastMonth ? `<button class="pill-btn ${isGoalFormOpen ? '' : 'active'}" data-goal-form-toggle type="button" style="margin: 0;">+ Set Goal</button>` : ''}
    </div>
    ${goalFormHtml}
  `;

  if (!goals || goals.length === 0) {
    return `
      <div class="financial-goals-section" style="margin-bottom: 24px;">
        ${sectionHeaderHtml}
        <div class="empty-chart">Set your first goal by clicking on "Set Goal"</div>
      </div>
    `;
  }

  // Hoisted out of the per-goal map below — these are static per render,
  // no need to rebuild the markup once per goal.
  const undoSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 3v6h6"></path></svg>`;
  const trashSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>`;
  const calendarSvg = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>`;

  const goalRows = goals.map(goal => {
    // Solid bar = any earlier funding plus everything funded in prior
    // months. Striped bar = only this calendar month's contribution.
    // Recomputed fresh from fundingHistory's monthKey on every render,
    // so it carries over correctly as the month boundary rolls forward.
    const earlierFunding = goal.hasDownpayment ? (Number(goal.downpaymentAmount) || 0) : 0;
    const monthlyFunded = (goal.fundingHistory || []).reduce((s, h) => s + (Number(h.amount) || 0), 0);
    const totalFunded = earlierFunding + monthlyFunded;
    const thisMonthFunded = (goal.fundingHistory || []).filter(h => h.monthKey === currentKey).reduce((s, h) => s + (Number(h.amount) || 0), 0);
    const previouslyFunded = totalFunded - thisMonthFunded;

    const pctPrev = goal.targetAmount > 0 ? Math.min(100, (previouslyFunded / goal.targetAmount) * 100) : 0;
    const pctThisMonth = goal.targetAmount > 0 ? Math.min(100 - pctPrev, (thisMonthFunded / goal.targetAmount) * 100) : 0;

    const rec = computeGoalRecommendation(goal, { monthsIndex, budgetDataByMonth: budgetDataByMonthMemo, entriesByMonth: entriesByMonthMemo });

    let breakdownHtml = '';
    if (rec.breakdown && rec.breakdown.length > 0) {
      breakdownHtml = `
        <div class="goal-breakdown-details">
          ${rec.breakdown.map(b => `<div style="display:flex; justify-content: space-between; margin-bottom:4px;"><span>${escapeHtml(b.source)}</span><span class="num">${fmtINR(b.amount)}</span></div>`).join('')}
        </div>
      `;
    }

    const earlierFundingHtml = goal.hasDownpayment ? `<div class="goal-earlier-funding">Earlier Funding: ${fmtINR(goal.downpaymentAmount)}</div>` : '';
    const canReverse = (goal.fundingHistory || []).length > 0;
    const monthsLeft = Math.max(0, rec.gapMonths || 0);

    return `
      <div class="card goal-card" data-goal-id="${goal.id}">
        <div class="goal-card-top">
          <div class="goal-card-info">
            <h4 class="goal-name">${escapeHtml(goal.name)}</h4>
            <div class="goal-target num">Target: ${fmtINR(goal.targetAmount)}</div>
          </div>
          <div class="goal-fund-controls">
            <input type="number" class="inline-edit-input" value="${rec.suggestedMonthlyContribution}" step="0.01" min="0" />
            <button class="btn primary small" data-fund-goal="${goal.id}">Fund</button>
          </div>
        </div>

        <div class="goal-progress-row" style="display: flex; align-items: flex-end; gap: 16px;">
          <div style="flex: stretch; flex-direction: column; gap: 8px;">
            <div class="goal-progress-meta" style="font-size: 0.82rem; font-weight: 600;">
              <span class="num">${fmtINR(totalFunded)} / ${fmtINR(goal.targetAmount)}</span>
            </div>
            <div class="goal-progress-bar">
              <div class="goal-seg-saved" style="width: ${pctPrev}%;"></div>
              <div class="goal-seg-this-month" style="width: ${pctThisMonth}%;"></div>
            </div>
          </div>
          <div class="goal-progress-actions" style="display: flex; gap: 4px;">
            <button class="icon-btn goal-icon-btn" data-popover-trigger data-reverse-funding="${goal.id}" ${canReverse ? '' : 'disabled'} title="Undo the most recent funding action">${undoSvg}</button>
            <button class="icon-btn goal-icon-btn goal-delete-btn" data-popover-trigger data-delete-goal="${goal.id}" title="Delete this goal">${trashSvg}</button>
          </div>
        </div>

        <div class="goal-deadline-row">
          ${calendarSvg}<span>Target deadline: <strong>${monthKeyLabel(goal.expectedMonth)}</strong> &bull; ${monthsLeft} ${monthsLeft === 1 ? 'month' : 'months'} left</span>
        </div>

        <div class="goal-suggestion">
          <div class="goal-suggested-line">Suggested Funding: <span class="num">${fmtINR(rec.suggestedMonthlyContribution)}</span> / month</div>
          <div class="goal-explanation">${escapeHtml(rec.explanation)}</div>
          ${breakdownHtml}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="financial-goals-section" style="margin-bottom: 24px;">
      ${sectionHeaderHtml}
      ${goalRows}
    </div>
  `;
}

async function renderBudget() {
  await loadDomain();

  currentKey = root.dataset.monthKey || currentMonthKey();
  isPastMonth = currentKey < currentMonthKey();

  budgetData = await Store.get(`budget-data:${currentKey}`, null);
  if (!budgetData) {
    const legacy = await Store.get('budget-data', null);
    if (legacy && currentKey === currentMonthKey()) {
      budgetData = legacy;
    } else if (currentKey === currentMonthKey()) {
      const lastLogged = monthsIndex.length ? monthsIndex[monthsIndex.length - 1] : null;
      if (lastLogged && lastLogged !== currentKey) {
        budgetData = await Store.get(`budget-data:${lastLogged}`, []) || [];
      } else {
        budgetData = [];
      }
    } else {
      budgetData = [];
    }
  }
  budgetData = migrateBudgetData(budgetData);
  await Store.set(`budget-data:${currentKey}`, budgetData);

  // Handle deep link from Month -> Budget
  const openReq = sessionStorage.getItem('month-to-budget-open');
  let scrollTargetId = null;
  if (openReq) {
    try {
      const { tagName, monthKey: reqMk } = JSON.parse(openReq);
      if (reqMk === currentKey) {
        const targetLower = tagName.toLowerCase();
        for (const group of budgetData) {
          for (const cat of (group.categories || [])) {
            if (cat.name.toLowerCase() === targetLower) { scrollTargetId = cat.id; break; }
            const sub = (cat.subcategories || []).find(s => s.name.toLowerCase() === targetLower);
            if (sub) { scrollTargetId = sub.id; cat.expanded = true; break; }
          }
          if (scrollTargetId) break;
        }
        if (!scrollTargetId) {
          setTimeout(() => showToast(`No budget set for '${escapeHtml(tagName)}' yet`), 500);
        }
      }
    } catch(e) {}
    sessionStorage.removeItem('month-to-budget-open');
  }

  const [monthData, freshEmi, freshSip, freshRec] = await Promise.all([
    loadMonth(currentKey),
    Store.get('emiseries', []),
    Store.get('sipseries', []),
    Store.get('recurringseries', []),
  ]);
  emiSeries = freshEmi;
  sipSeries = freshSip;
  recurringSeries = freshRec;

  const emiRows = emiRowsForMonth(emiSeries, currentKey, monthData.deletedEmi);
  const sipRows = sipRowsForMonth(sipSeries, currentKey, monthData.deletedSip);
  const recurringRows = recurringRowsForMonth(recurringSeries, currentKey, monthData.deletedRecurring);

  currentMonthEntries = [
    ...(monthData.entries || []),
    ...sipRows,
    ...recurringRows,
    ...emiRows,
  ];

  let totalBudget = 0;
  let totalUsed = 0;

  let tableRows = '';
  budgetData.forEach(group => {
    let groupAllocated = (group.categories || []).reduce((s, c) => s + (Number(c.budget) || 0), 0);
    let groupUsed = 0;
    (group.categories || []).forEach(c => groupUsed += calculateUsed(c.name, false, null));
    
    tableRows += `
      <div class="budget-group" data-group-id="${group.id}">
        <div class="budget-group-header ${group.expanded !== false ? 'expanded' : ''}" data-group-drop-target="${group.id}">
          <button class="toggle-sub ${group.expanded !== false ? 'expanded' : ''}" data-toggle-group="${group.id}" title="${group.expanded !== false ? 'Collapse' : 'Expand'}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></button>
          <span class="bgh-name">${escapeHtml(group.name)}</span>
          <span class="bgh-amount">${fmtINR(groupUsed)} / ${fmtINR(group.budget)}</span>
          <div class="bgh-actions">
            <div class="row-actions-menu">
              ${!isPastMonth ? `
              <button class="edit-budget-btn icon-btn row-menu-btn" data-edit-budget="${group.id}" data-type="group" title="Edit budget">
                <span class="row-menu-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg></span><span class="row-menu-text">Edit</span>
              </button>
              <button class="icon-btn row-menu-btn" data-popover-trigger data-del-budget="${group.id}" data-type="group" title="Remove">
                <span class="row-menu-icon">✕</span><span class="row-menu-text">Delete</span>
              </button>
              ` : ''}
            </div>
            ${!isPastMonth ? `<button class="icon-btn mobile-actions-toggle" data-toggle-row-actions title="Actions">${dotsSvg}</button>` : ''}
          </div>
        </div>
        <div class="group-wrap ${group.expanded !== false ? 'expanded' : ''}" data-group-wrap="${group.id}">
          <div class="group-inner">
          <div class="budget-group-body">
    `;
    
    (group.categories || []).forEach(cat => {
      tableRows += renderBudgetRow(cat, false, null, group.id);
      tableRows += `<div class="subcat-wrap ${cat.expanded ? 'expanded' : ''}" data-subcat-wrap="${cat.id}"><div class="subcat-inner">`;
      if (cat.subcategories && cat.subcategories.length > 0) {
        cat.subcategories.forEach(sub => {
          tableRows += renderBudgetRow(sub, true, cat.id, group.id);
        });
      }
      if (!isPastMonth) {
        tableRows += `<button class="add-row-btn is-sub" data-inline-add-btn="${cat.id}" data-group-id="${group.id}" type="button">+ Add subcategory for ${escapeHtml(cat.name)}</button>`;
      }
      tableRows += `</div></div>`;
    });
    
    if (!isPastMonth) {
      tableRows += `<div style="padding: 12px 16px;"><button class="add-row-btn dashed-add-btn" data-inline-newcat-btn="${group.id}" type="button">+ Add category</button></div>`;
    }
    tableRows += `</div></div></div></div>`;
  });

  if (!tableRows) {
    const hasPrevLogged = monthsIndex.some(m => m < currentKey);
    if (!isPastMonth && hasPrevLogged) {
      tableRows = `
        <div class="empty-chart" style="padding: 24px 0; grid-column: 1/-1; display: flex; flex-wrap: wrap; gap: 12px;">
          <button class="add-row-btn" data-add-group-btn type="button" style="flex: 1 1 250px; margin: 0;">+ Add a Group</button>
          <button class="add-row-btn" id="copy-last-budget-btn" type="button" style="flex: 1 1 250px; margin: 0; border-color: var(--sky); color: var(--blue);">Copy from the last logged month</button>
        </div>
      `;
    } else if (!isPastMonth) {
      tableRows = `
        <div class="empty-chart" style="padding: 24px 0; grid-column: 1/-1; display: flex; flex-wrap: wrap;">
          <button class="add-row-btn" data-add-group-btn type="button" style="flex: 1 1 100%; margin: 0;">+ Add a Group</button>
        </div>
      `;
    } else {
      tableRows = `<div class="empty-chart" style="padding: 24px; grid-column: 1/-1; text-align: center; color: var(--muted);">No budgets set for this month.</div>`;
    }
  }

  let catsWithSubs = [];
  budgetData.forEach(g => {
    (g.categories || []).forEach(c => {
      if (c.subcategories && c.subcategories.length > 0) catsWithSubs.push(c);
    });
  });
  const allExpanded = catsWithSubs.length > 0 && catsWithSubs.every(c => c.expanded);

  const formHtml = isFormOpen ? `
  <div class="form-panel slide-down-fade" style="margin: 14px 0px;">
    <div class="inline-add-context">Create a new top-level Budget Group. Categories and subcategories are added inline underneath the table once the group exists.</div>
    <div class="form-row">
      <div class="field">
        <label>Group name</label>
        <input id="f-group-name" type="text" placeholder="e.g. Housing" />
      </div>
      <div class="field">
        <label>Group Budget (₹)</label>
        <input id="f-group-budget" type="number" step="0.01" min="0" placeholder="0.00" />
      </div>
    </div>
    <div class="form-actions">
      <button class="btn primary" data-submit-budget type="button">Add Group</button>
      <button class="btn ghost" data-close-budget-form type="button">Cancel</button>
    </div>
  </div>
  ` : '';
  
  const tb = document.getElementById('global-topbar');
  if (tb) tb.style.display = '';

  markRendered(root);
  root.innerHTML = `
  <div class="section">
    <div class="month-header" style="display: flex; justify-content: space-between; gap: 24px;">
      <h1>Budget</h1>
      <div class="range-toggle" style="align-self: center;">
        ${(!monthsIndex.length || currentKey <= monthsIndex[0]) 
          ? `<span class="range-btn" style="opacity: 0.3; cursor: not-allowed;">◀</span>` 
          : `<a href="/budget/${addMonths(currentKey, -1)}" class="range-btn" style="text-decoration:none;">◀</a>`}
        ${monthsIndex.includes(currentKey)
          ? `<a href="/month/${currentKey}" class="range-btn active" style="text-decoration:none;" title="View Month Transactions">${monthKeyLabel(currentKey)}</a>`
          : `<span class="range-btn active" style="cursor:default; opacity:0.6;" title="No transactions for this month">${monthKeyLabel(currentKey)}</span>`}
        <a href="/budget/${addMonths(currentKey, 1)}" class="range-btn" style="text-decoration:none;">▶</a>
      </div>
    </div>
    <p style="color:var(--muted); max-width:56ch; margin-top:6px;">Set monthly goals for your tags and track your personal spending. Drag and drop rows to reorder.</p>
  </div>

  <div class="section">
    ${renderSummaryCards()}
    ${renderGoalsSection()}
    ${renderUnbudgetedCallout()}
    
    <div class="pill-grid" style="margin: 16px 0px;">
      ${!isPastMonth ? `<button class="pill-btn ${isFormOpen ? '' : 'active'}" data-budget-form-toggle type="button">+ Add Group</button>` : ''}
      ${catsWithSubs.length > 0 ? `
      <button class="pill-btn expand-all-btn ${allExpanded ? 'expanded' : ''}" data-expand-all type="button">
        <svg class="expand-all-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
        <span data-expand-all-label>${allExpanded ? 'Collapse All' : 'Expand All'}</span>
      </button>` : ''}
    </div>
    </div>
    ${!isPastMonth ? formHtml : ''}
    <div class="budget-list">
      ${tableRows}
    </div>
  </div>
  `;

  appendPageChrome(root);

  if (scrollTargetId) {
    setTimeout(() => {
      const targetRow = document.querySelector(`.budget-row[data-id="${scrollTargetId}"]`);
      if (targetRow) {
        targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targetRow.style.transition = 'background 0.5s ease';
        targetRow.style.background = 'var(--ice)';
        setTimeout(() => targetRow.style.background = '', 1500);
      }
    }, 100);
  }
}

// Drag & Drop Handlers
root.addEventListener('dragstart', (ev) => {
  if (isPastMonth) return;
  const row = ev.target.closest('.budget-row');
  if (!row) return;
  draggedItem = {
    id: row.dataset.id,
    type: row.dataset.type,
    parentId: row.dataset.parentId || null,
    groupId: row.dataset.groupId
  };
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', draggedItem.id);
  row.style.opacity = '0.4';
});

root.addEventListener('dragend', (ev) => {
  const row = ev.target.closest('.budget-row');
  if (row) row.style.opacity = '1';
  document.querySelectorAll('.drop-above, .drop-below, .drag-target-active').forEach(el => {
    el.classList.remove('drop-above', 'drop-below', 'drag-target-active');
  });
  draggedItem = null;
});

root.addEventListener('dragover', (ev) => {
  if (isPastMonth || !draggedItem) return;
  ev.preventDefault();
  
  const groupHeader = ev.target.closest('.budget-group-header');
  if (groupHeader && draggedItem.type === 'cat') {
    ev.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.drag-target-active').forEach(el => el.classList.remove('drag-target-active'));
    groupHeader.closest('.budget-group').classList.add('drag-target-active');
    return;
  }
  
  const row = ev.target.closest('.budget-row');
  if (!row) return;

  const targetType = row.dataset.type;
  const targetParentId = row.dataset.parentId || null;

  if (draggedItem.type === 'sub') {
    if (targetType === 'cat' || targetParentId !== draggedItem.parentId) {
      ev.dataTransfer.dropEffect = 'none';
      document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
      return;
    }
  }

  if (draggedItem.type === 'cat' && targetType === 'sub') {
    ev.dataTransfer.dropEffect = 'none';
    document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
    return;
  }

  const rect = row.getBoundingClientRect();
  const isBottomHalf = ev.clientY > rect.top + rect.height / 2;

  document.querySelectorAll('.drop-above, .drop-below, .drag-target-active').forEach(el => {
    if (el !== row) el.classList.remove('drop-above', 'drop-below', 'drag-target-active');
  });

  row.classList.remove('drop-above', 'drop-below');
  row.classList.add(isBottomHalf ? 'drop-below' : 'drop-above');
});

root.addEventListener('dragleave', (ev) => {
  const row = ev.target.closest('.budget-row');
  if (row && !row.contains(ev.relatedTarget)) {
    row.classList.remove('drop-above', 'drop-below');
  }
  const group = ev.target.closest('.budget-group');
  if (group && !group.contains(ev.relatedTarget)) {
    group.classList.remove('drag-target-active');
  }
});

root.addEventListener('drop', async (ev) => {
  if (isPastMonth || !draggedItem) return;
  ev.preventDefault();
  
  const groupHeader = ev.target.closest('.budget-group-header');
  if (groupHeader && draggedItem.type === 'cat') {
    const destGroupId = groupHeader.dataset.groupDropTarget;
    if (destGroupId !== draggedItem.groupId) {
      const sourceGroup = budgetData.find(g => g.id === draggedItem.groupId);
      const destGroup = budgetData.find(g => g.id === destGroupId);
      const catToMove = sourceGroup.categories.find(c => c.id === draggedItem.id);
      
      if (!validateCategoryMove(destGroup, catToMove)) {
        showToast('Not enough budget in target group');
        document.querySelectorAll('.drag-target-active').forEach(el => el.classList.remove('drag-target-active'));
        return;
      }
      
      const idx = sourceGroup.categories.findIndex(c => c.id === draggedItem.id);
      sourceGroup.categories.splice(idx, 1);
      destGroup.categories = destGroup.categories || [];
      destGroup.categories.push(catToMove);
      destGroup.expanded = true;
      
      await Store.set(`budget-data:${currentKey}`, budgetData);
      await renderBudget();
      showToast('Moved to group');
    }
    return;
  }

  const row = ev.target.closest('.budget-row');
  if (!row) return;

  const targetId = row.dataset.id;
  const targetType = row.dataset.type;
  const targetParentId = row.dataset.parentId || null;
  const targetGroupId = row.dataset.groupId;

  if (draggedItem.type === 'sub') {
    if (targetType === 'cat' || targetParentId !== draggedItem.parentId) {
      document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
      return;
    }
  }

  if (draggedItem.type === 'cat' && targetType === 'sub') {
    document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
    return;
  }

  if (draggedItem.id === targetId) {
     document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
     return;
  }

  let itemToMove;
  let sourceGroup;
  if (draggedItem.type === 'cat') {
    sourceGroup = budgetData.find(g => g.id === draggedItem.groupId);
    const idx = sourceGroup.categories.findIndex(c => c.id === draggedItem.id);
    if (idx > -1) itemToMove = sourceGroup.categories[idx];
    
    if (targetGroupId !== draggedItem.groupId) {
      const destGroup = budgetData.find(g => g.id === targetGroupId);
      if (!validateCategoryMove(destGroup, itemToMove)) {
        showToast('Not enough budget in target group');
        document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
        return;
      }
      // Same reasoning as the header-drop path above: dropping into a
      // collapsed group must not hide the item that was just moved there.
      destGroup.expanded = true;
    }
    if (idx > -1) sourceGroup.categories.splice(idx, 1);
  } else {
    for (const g of budgetData) {
      const parent = (g.categories || []).find(c => c.id === draggedItem.parentId);
      if (parent && parent.subcategories) {
        const idx = parent.subcategories.findIndex(s => s.id === draggedItem.id);
        if (idx > -1) { itemToMove = parent.subcategories.splice(idx, 1)[0]; break; }
      }
    }
  }

  if (!itemToMove) return;

  const rect = row.getBoundingClientRect();
  const isBottomHalf = ev.clientY > rect.top + rect.height / 2;

  if (targetType === 'cat') {
    const destGroup = budgetData.find(g => g.id === targetGroupId);
    const targetIdx = destGroup.categories.findIndex(c => c.id === targetId);
    destGroup.categories.splice(isBottomHalf ? targetIdx + 1 : targetIdx, 0, itemToMove);
  } else if (targetType === 'sub') {
    let parentFound;
    for (const g of budgetData) {
      parentFound = (g.categories || []).find(c => c.id === targetParentId);
      if (parentFound) break;
    }
    if (parentFound && parentFound.subcategories) {
      const targetIdx = parentFound.subcategories.findIndex(s => s.id === targetId);
      parentFound.subcategories.splice(isBottomHalf ? targetIdx + 1 : targetIdx, 0, itemToMove);
      parentFound.expanded = true;
    }
  }

  document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
  
  await Store.set(`budget-data:${currentKey}`, budgetData);
  await renderBudget();
  showToast('Order updated');
});

// Click Handlers
root.addEventListener('click', async (ev) => {
  const toggleRowActions = ev.target.closest('[data-toggle-row-actions]');
  if (toggleRowActions) {
    const row = toggleRowActions.closest('.budget-row, .budget-group-header');
    const wasOpen = row.classList.contains('show-actions');
    document.querySelectorAll('.budget-row.show-actions, .budget-group-header.show-actions').forEach(r => r.classList.remove('show-actions'));
    if (!wasOpen) row.classList.add('show-actions');
    ev.stopPropagation();
    return;
  }

  if (!ev.target.closest('.actions-col, .bgh-actions') || (ev.target.closest('.row-menu-btn') && !ev.target.closest('[data-del-budget]'))) {
    document.querySelectorAll('.budget-row.show-actions, .budget-group-header.show-actions').forEach(r => r.classList.remove('show-actions'));
  }

  const classBtn = ev.target.closest('[data-set-classification]');
  if (classBtn) {
    ev.stopPropagation();
    const catId = classBtn.dataset.catId;
    const newClass = classBtn.dataset.setClassification;
    for (const g of budgetData) {
      const cat = (g.categories || []).find(c => c.id === catId);
      if (cat) { cat.classification = newClass; break; }
    }
    await Store.set(`budget-data:${currentKey}`, budgetData);
    await renderBudget();
    return;
  }

  const inlineAddSubBtn = ev.target.closest('[data-inline-add-btn]');
  if (inlineAddSubBtn) {
    ev.stopPropagation();
    const existingForm = document.querySelector('.inline-subcat-form, .inline-newcat-form');
    const parentCatId = inlineAddSubBtn.dataset.inlineAddBtn;
    const groupId = inlineAddSubBtn.dataset.groupId;
    const reopenSame = existingForm && existingForm.dataset.inlineFor === parentCatId;
    
    if (existingForm) existingForm.remove();
    if (reopenSame) return;

    const group = budgetData.find(g => g.id === groupId);
    const parentCat = group ? (group.categories || []).find(c => c.id === parentCatId) : null;
    if (!parentCat) return;

    const existingSubs = parentCat.subcategories || [];
    const datalistId = `inline-add-dl-${parentCatId}`;
    const datalistOptions = existingSubs.map(s => `<option value="${escapeHtml(s.name)}"></option>`).join('');

    const formEl = document.createElement('div');
    formEl.className = 'inline-subcat-form form-panel slide-down-fade is-sub';
    formEl.dataset.inlineFor = parentCatId;
    formEl.innerHTML = `
      <div class="inline-add-context">Add subcategory for <strong>${escapeHtml(parentCat.name)}</strong></div>
      <div class="form-row">
        <div class="field">
          <label>Subcategory name</label>
          <input type="text" class="inline-add-name" list="${datalistId}" placeholder="e.g. Meat" autocomplete="off" />
          <datalist id="${datalistId}">${datalistOptions}</datalist>
        </div>
        <div class="field">
          <label>Amount (₹)</label>
          <input type="number" step="0.01" min="0" class="inline-add-amount" placeholder="0.00" />
        </div>
      </div>
      <div class="form-actions">
        <button class="btn primary" data-inline-add-save="${parentCatId}" type="button">Save</button>
        <button class="btn ghost" data-inline-add-cancel type="button">Cancel</button>
      </div>
    `;
    inlineAddSubBtn.insertAdjacentElement('beforebegin', formEl);
    formEl.querySelector('.inline-add-name').focus();
    return;
  }

  const inlineNewCatBtn = ev.target.closest('[data-inline-newcat-btn]');
  if (inlineNewCatBtn) {
    ev.stopPropagation();
    const existingForm = document.querySelector('.inline-subcat-form, .inline-newcat-form');
    const groupId = inlineNewCatBtn.dataset.inlineNewcatBtn;
    const reopenSame = existingForm && existingForm.classList.contains('inline-newcat-form') && existingForm.dataset.inlineForGroup === groupId;
    
    if (existingForm) existingForm.remove();
    if (reopenSame) return;

    const allTags = allSpendTags(DEFAULT_TAGS, customTags);
    const tagOptions = allTags.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');

    const formEl = document.createElement('div');
    formEl.className = 'inline-newcat-form form-panel slide-down-fade';
    formEl.dataset.inlineForGroup = groupId;
    formEl.style.width = '100%';
    formEl.innerHTML = `
      <div class="inline-add-context">Add a new category</div>
      <div class="form-row">
        <div class="field">
          <label>Category (Tag)</label>
          <select class="inline-newcat-name">
            <option value="" disabled selected>Select tag...</option>
            ${tagOptions}
            <option value="__custom__">+ Add custom tag</option>
          </select>
        </div>
        <div class="field inline-newcat-custom-wrap" style="display:none;">
          <label>New tag name</label>
          <input type="text" class="inline-newcat-custom" placeholder="e.g. Pets" />
        </div>
        <div class="field">
          <label>Budget (₹)</label>
          <input type="number" step="0.01" min="0" class="inline-newcat-budget" placeholder="0.00" />
        </div>
      </div>
      <div class="form-actions">
        <button class="btn primary" data-inline-newcat-save="${groupId}" type="button">Save</button>
        <button class="btn ghost" data-inline-add-cancel type="button">Cancel</button>
      </div>
    `;
    inlineNewCatBtn.insertAdjacentElement('beforebegin', formEl);
    return;
  }

  const inlineCancelBtn = ev.target.closest('[data-inline-add-cancel]');
  if (inlineCancelBtn) {
    const formEl = inlineCancelBtn.closest('.inline-subcat-form, .inline-newcat-form');
    if (formEl) formEl.remove();
    return;
  }

  const inlineSaveBtn = ev.target.closest('[data-inline-add-save]');
  if (inlineSaveBtn) {
    const parentCatId = inlineSaveBtn.dataset.inlineAddSave;
    const formEl = inlineSaveBtn.closest('.inline-subcat-form');
    const nameInput = formEl.querySelector('.inline-add-name');
    const amountInput = formEl.querySelector('.inline-add-amount');
    const name = nameInput.value.trim();
    const amount = Number(amountInput.value) || 0;

    if (!name || amount <= 0) { showToast('Enter a valid name and amount'); return; }

    let isDuplicate = false;
    for (const g of budgetData) {
      (g.categories || []).forEach(c => {
        if (c.name.toLowerCase() === name.toLowerCase()) isDuplicate = true;
        if (c.subcategories && c.subcategories.some(s => s.name.toLowerCase() === name.toLowerCase())) isDuplicate = true;
      });
    }
    if (isDuplicate) { showToast('Name already in use'); return; }

    let parentCat;
    for (const g of budgetData) {
      parentCat = (g.categories || []).find(c => c.id === parentCatId);
      if (parentCat) break;
    }
    if (!parentCat) { showToast('Parent category not found'); return; }

    const newSub = { id: uid(), name, budget: amount };
    const tempParent = JSON.parse(JSON.stringify(parentCat));
    tempParent.subcategories = tempParent.subcategories || [];
    tempParent.subcategories.push(newSub);

    if (!validateCategoryBudget(tempParent, parentCat.budget)) {
      showToast('Sub-category budgets exceed parent budget');
      return;
    }

    parentCat.subcategories = tempParent.subcategories;
    parentCat.expanded = true;

    await Store.set(`budget-data:${currentKey}`, budgetData);
    await renderBudget();
    showToast('Subcategory added');
    return;
  }

  const inlineNewCatSaveBtn = ev.target.closest('[data-inline-newcat-save]');
  if (inlineNewCatSaveBtn) {
    const groupId = inlineNewCatSaveBtn.dataset.inlineNewcatSave;
    const formEl = inlineNewCatSaveBtn.closest('.inline-newcat-form');
    const select = formEl.querySelector('.inline-newcat-name');
    const customInput = formEl.querySelector('.inline-newcat-custom');
    const budgetInput = formEl.querySelector('.inline-newcat-budget');

    let catName = select.value;
    if (catName === '__custom__') catName = customInput.value.trim();
    const catBudget = Number(budgetInput.value) || 0;

    if (!catName || catBudget <= 0) { showToast('Enter valid category name and budget'); return; }

    let isDuplicateSub = false;
    for (const g of budgetData) {
      (g.categories || []).forEach(c => {
        if (c.subcategories && c.subcategories.some(s => s.name.toLowerCase() === catName.toLowerCase())) isDuplicateSub = true;
      });
    }
    if (isDuplicateSub) { showToast('Name already in use as a subcategory'); return; }

    if (select.value === '__custom__') {
      if (!allSpendTags(DEFAULT_TAGS, customTags).some(t => t.toLowerCase() === catName.toLowerCase())) {
        customTags.push(catName);
        await Store.set('custom-spend-tags', customTags);
      }
    }
    
    const group = budgetData.find(g => g.id === groupId);
    if (!group) return;

    const existingIdx = (group.categories || []).findIndex(c => c.name.toLowerCase() === catName.toLowerCase());
    if (existingIdx > -1) {
      group.categories[existingIdx].budget = catBudget;
    } else {
      const newCat = { id: uid(), name: catName, budget: catBudget, expanded: true, subcategories: [], classification: defaultClassificationForTag(catName) };
      group.categories = group.categories || [];
      group.categories.push(newCat);
    }
    
    if (!validateGroupBudget(group, group.budget)) {
      showToast('Sum of categories exceeds group budget');
      return; // mutation happened but not persisted, UI resets on return
    }

    await Store.set(`budget-data:${currentKey}`, budgetData);
    await renderBudget();
    showToast('Budget added');
    return;
  }

  const viewTxnsBtn = ev.target.closest('[data-view-txns]');
  if (viewTxnsBtn) {
    const tag = viewTxnsBtn.dataset.viewTxns;
    sessionStorage.setItem('budget-to-month-filter', JSON.stringify({ tag, monthKey: currentKey }));
    window.location.href = `/month/${currentKey}`;
    return;
  }

  const addGroupBtn = ev.target.closest('[data-add-group-btn]');
  if (addGroupBtn) {
    // Previously fired two blocking prompt() dialogs that could be
    // cancelled or fail validation without any persistence or re-render
    // ever happening. Now opens the same Add Budget group form, which
    // always persists via Store.set and re-renders via renderBudget().
    isFormOpen = true;
    isGoalFormOpen = false;
    await renderBudget();
    const nameInput = document.getElementById('f-group-name');
    if (nameInput) nameInput.focus();
    return;
  }

  const formToggle = ev.target.closest('[data-budget-form-toggle]');
  if (formToggle) { isFormOpen = !isFormOpen; isGoalFormOpen = false; await renderBudget(); return; }
  
  const closeForm = ev.target.closest('[data-close-budget-form]');
  if (closeForm) { isFormOpen = false; await renderBudget(); return; }
  
  const goalFormToggle = ev.target.closest('[data-goal-form-toggle]');
  if (goalFormToggle) { isGoalFormOpen = !isGoalFormOpen; isFormOpen = false; await renderBudget(); return; }
  
  const closeGoalForm = ev.target.closest('[data-close-goal-form]');
  if (closeGoalForm) { isGoalFormOpen = false; await renderBudget(); return; }
  
  const submitGoal = ev.target.closest('[data-submit-goal]');
  if (submitGoal) {
    const name = $('#f-goal-name').value.trim();
    const targetAmount = Number($('#f-goal-target').value);
    const expectedMonth = $('#f-goal-month').value;
    const hasDownpayment = $('#f-goal-downpayment-toggle').checked;
    const downpaymentAmount = Number($('#f-goal-downpayment').value);
    
    if (!name || targetAmount <= 0 || !expectedMonth || expectedMonth.length !== 7) { showToast('Invalid goal details'); return; }
    if (hasDownpayment && (downpaymentAmount <= 0 || downpaymentAmount > targetAmount)) { showToast('Invalid downpayment'); return; }
    
    goals.push({ id: uid(), name, targetAmount, expectedMonth, hasDownpayment, downpaymentAmount, createdAt: new Date().toISOString(), active: true, fundingHistory: [] });
    await Store.set('goals', goals);
    isGoalFormOpen = false;
    await renderBudget();
    showToast('Goal saved');
    return;
  }
  
  const fundGoalBtn = ev.target.closest('[data-fund-goal]');
  if (fundGoalBtn) {
    const goalId = fundGoalBtn.dataset.fundGoal;
    const amount = Number(fundGoalBtn.closest('.goal-card').querySelector('.inline-edit-input').value);
    if (!amount || amount <= 0) { showToast('Invalid amount'); return; }
    
    await ensureMonthIndexed(currentKey, monthsIndex);
    const data = await loadMonth(currentKey);
    const entryId = uid();
    data.entries.push({ id: entryId, type: 'goal_funding', amount, date: new Date().toISOString().split('T')[0], description: 'Goal Funding', goalId });
    await saveMonth(currentKey);
    
    const goal = goals.find(g => g.id === goalId);
    if (goal) {
        goal.fundingHistory = goal.fundingHistory || [];
        goal.fundingHistory.push({ id: uid(), amount, monthKey: currentKey, date: new Date().toISOString().split('T')[0], entryId });
        await Store.set('goals', goals);
    }
    
    await renderBudget();
    showToast('Goal funded');
    return;
  }

  const reverseFundBtn = ev.target.closest('[data-reverse-funding]');
  if (reverseFundBtn) {
    ev.stopPropagation();
    showDeleteCallout(reverseFundBtn, 'confirm-reverse-funding', reverseFundBtn.dataset.reverseFunding, 'Undo funding?');
    return;
  }

  const confirmReverseFund = ev.target.closest('[data-confirm-reverse-funding]');
  if (confirmReverseFund) {
    ev.stopPropagation();
    const goalId = confirmReverseFund.dataset.confirmReverseFunding;
    const goal = goals.find(g => g.id === goalId);
    hideDeleteCallout();
    if (!goal || !goal.fundingHistory || goal.fundingHistory.length === 0) { showToast('No funding to reverse'); return; }

    const last = goal.fundingHistory[goal.fundingHistory.length - 1];
    goal.fundingHistory = goal.fundingHistory.slice(0, -1);
    await Store.set('goals', goals);

    if (last.entryId) {
      const targetMonth = last.monthKey || currentKey;
      const data = await loadMonth(targetMonth);
      data.entries = (data.entries || []).filter(e => e.id !== last.entryId);
      await saveMonth(targetMonth);
      if (targetMonth === currentKey) currentMonthEntries = currentMonthEntries.filter(e => e.id !== last.entryId);
    }

    await renderBudget();
    showToast('Last funding reversed');
    return;
  }

  const deleteGoalBtn = ev.target.closest('[data-delete-goal]');
  if (deleteGoalBtn) {
    ev.stopPropagation();
    showDeleteCallout(deleteGoalBtn, 'confirm-delete-goal', deleteGoalBtn.dataset.deleteGoal);
    return;
  }

  const confirmDeleteGoal = ev.target.closest('[data-confirm-delete-goal]');
  if (confirmDeleteGoal) {
    ev.stopPropagation();
    const goalId = confirmDeleteGoal.dataset.confirmDeleteGoal;
    goals = goals.filter(g => g.id !== goalId);
    await Store.set('goals', goals);
    hideDeleteCallout();
    await renderBudget();
    showToast('Goal deleted');
    return;
  }

  const unbudgetedToggle = ev.target.closest('[data-unbudgeted-toggle]');
  if (unbudgetedToggle) {
    const callout = unbudgetedToggle.closest('[data-unbudgeted-callout]');
    const wrap = callout ? callout.querySelector('[data-unbudgeted-wrap]') : null;
    if (wrap) wrap.classList.toggle('expanded');
    unbudgetedToggle.classList.toggle('expanded');
    return;
  }
  
  const expandAllBtn = ev.target.closest('[data-expand-all]');
  if (expandAllBtn) {
    // Bulk version of the single toggle above: flip in-memory state and
    // toggle classes on every already-rendered wrap/chevron. No re-render,
    // no data fetch, no recalculation — each subcat-wrap animates with
    // its own existing CSS transition, independently and instantly.
    const shouldExpand = !expandAllBtn.classList.contains('expanded');

    budgetData.forEach(group => {
      group.expanded = shouldExpand;
      const gWrapper = document.querySelector(`[data-group-wrap="${group.id}"]`);
      if (gWrapper) gWrapper.classList.toggle('expanded', shouldExpand);
      const gChevron = document.querySelector(`[data-toggle-group="${group.id}"]`);
      if (gChevron) gChevron.classList.toggle('expanded', shouldExpand);
      const gHeader = document.querySelector(`.budget-group-header[data-group-drop-target="${group.id}"]`);
      if (gHeader) gHeader.classList.toggle('expanded', shouldExpand);

      (group.categories || []).forEach(cat => {
        if (!cat.subcategories || cat.subcategories.length === 0) return;
        cat.expanded = shouldExpand;

        const wrapper = document.querySelector(`[data-subcat-wrap="${cat.id}"]`);
        if (wrapper) wrapper.classList.toggle('expanded', shouldExpand);

        const chevron = document.querySelector(`[data-toggle-sub="${cat.id}"]`);
        if (chevron) chevron.classList.toggle('expanded', shouldExpand);
      });
    });

    expandAllBtn.classList.toggle('expanded', shouldExpand);
    const label = expandAllBtn.querySelector('[data-expand-all-label]');
    if (label) label.textContent = shouldExpand ? 'Collapse All' : 'Expand All';

    // Persist afterwards, fire-and-forget — never block the UI on this.
    Store.set(`budget-data:${currentKey}`, budgetData);
    return;
  }

  const copyLastBtn = ev.target.closest('#copy-last-budget-btn');
  if (copyLastBtn) {
    const prevMonths = monthsIndex.filter(m => m < currentKey);
    let lastLogged = prevMonths.length ? prevMonths[prevMonths.length - 1] : null;
    if (lastLogged) {
        let lastBudget = await Store.get(`budget-data:${lastLogged}`, null);
        if (!lastBudget) lastBudget = await Store.get('budget-data', []) || [];
        
        budgetData = JSON.parse(JSON.stringify(lastBudget));
        await Store.set(`budget-data:${currentKey}`, budgetData);
        await renderBudget();
        showToast('Budget copied');
    } else {
        showToast('No logged months found to copy from');
    }
    return;
  }

  const toggleSub = ev.target.closest('[data-toggle-sub]');
  if (toggleSub) {
    let cat;
    for (const g of budgetData) {
      cat = (g.categories || []).find(c => c.id === toggleSub.dataset.toggleSub);
      if (cat) break;
    }
    if (cat) {
      // Flip in-memory state and toggle classes FIRST and SYNCHRONOUSLY —
      // this is the only work needed to drive the CSS grid-template-rows
      // transition. No re-render, no recalculation, no awaiting I/O before
      // the browser can paint the animation.
      cat.expanded = !cat.expanded;

      const wrapper = document.querySelector(`[data-subcat-wrap="${cat.id}"]`);
      if (wrapper) wrapper.classList.toggle('expanded', cat.expanded);
      toggleSub.classList.toggle('expanded', cat.expanded);

      // Persist afterwards, fire-and-forget — never block the UI on this.
      Store.set(`budget-data:${currentKey}`, budgetData);
    }
    return;
  }

  const toggleGroup = ev.target.closest('[data-toggle-group]');
  
  if (toggleGroup) {
    const groupId = toggleGroup.dataset.toggleGroup;
    const group = budgetData.find(g => g.id === groupId);
    if (group) {
      group.expanded = group.expanded === false ? true : false;

      const wrapper = document.querySelector(`[data-group-wrap="${group.id}"]`);
      if (wrapper) wrapper.classList.toggle('expanded', group.expanded);
      
      const btn = document.querySelector(`[data-toggle-group="${group.id}"]`);
      if (btn) btn.classList.toggle('expanded', group.expanded);

      const header = document.querySelector(`.budget-group-header[data-group-drop-target="${group.id}"]`);
      if (header) header.classList.toggle('expanded', group.expanded);

      Store.set(`budget-data:${currentKey}`, budgetData);
    }
    return;
  }

  if (ev.target.closest('[data-submit-budget]')) {
  const groupName = $('#f-group-name').value.trim();
  const groupBudget = Number($('#f-group-budget').value);

  if (!groupName) { showToast('Enter a group name'); return; }
  if (isNaN(groupBudget) || groupBudget <= 0) { showToast('Enter a valid group budget'); return; }

  const isDuplicateGroup = budgetData.some(g => g.name.toLowerCase() === groupName.toLowerCase());
  if (isDuplicateGroup) { showToast('A group with that name already exists'); return; }

  budgetData.push({ id: uid(), name: groupName, budget: groupBudget, expanded: true, categories: [] });

  await Store.set(`budget-data:${currentKey}`, budgetData);
  isFormOpen = false;
  await renderBudget();
  showToast('Group added');
  return;
}

  const editBtn = ev.target.closest('[data-edit-budget]');
  if (editBtn) {
    const id = editBtn.dataset.editBudget;
    const type = editBtn.dataset.type;
    let amtCol;
    let currentAmount;

    if (type === 'group') {
      // Group headers have no .budget-row ancestor and their .bgh-amount
      // shows two numbers ("allocated / budget"), so it can't be text-parsed
      // like a row's single-number .budget-amt-col — read group.budget directly.
      amtCol = editBtn.closest('.budget-group-header').querySelector('.bgh-amount');
      const group = budgetData.find(g => g.id === id);
      currentAmount = group ? group.budget : 0;
      amtCol.classList.add('budget-amt-col'); // reuse save/cancel handlers' lookup
    } else {
      const row = editBtn.closest('.budget-row');
      amtCol = row.querySelector('.budget-amt-col');
      currentAmount = amtCol.textContent.trim().replace(/[^0-9.]/g, '');
    }
    if (!amtCol) return;

    amtCol.innerHTML = `
      <input type="number" step="0.01" min="0" class="inline-edit-input" value="${currentAmount}" />
      <button class="icon-btn" data-save-edit="${id}" data-type="${type}" data-parent-id="${editBtn.dataset.parentId || ''}" style="color:var(--credit);">✓</button>
      <button class="icon-btn" data-cancel-edit style="color:var(--debit);">✕</button>
    `;
    amtCol.querySelector('.inline-edit-input').focus();
    return;
  }

  if (ev.target.closest('[data-cancel-edit]')) {
    await renderBudget();
    return;
  }

  const saveEdit = ev.target.closest('[data-save-edit]');
  if (saveEdit) {
    const id = saveEdit.dataset.saveEdit;
    const type = saveEdit.dataset.type;
    const parentId = saveEdit.dataset.parentId;
    const newBudget = Number(saveEdit.closest('.budget-amt-col').querySelector('.inline-edit-input').value);

    if (isNaN(newBudget) || newBudget < 0) { showToast('Invalid amount'); return; }

    if (type === 'group') {
      const group = budgetData.find(g => g.id === id);
      if (group) {
        if (!validateGroupBudget(group, newBudget)) {
          showToast('Group budget cannot be less than sum of categories');
          return;
        }
        group.budget = newBudget;
      }
    } else if (type === 'cat') {
      for (const g of budgetData) {
        const cat = (g.categories || []).find(c => c.id === id);
        if (cat) {
          const tempCat = JSON.parse(JSON.stringify(cat));
          tempCat.budget = newBudget;
          if (!validateCategoryBudget(tempCat, newBudget)) { showToast('Budget cannot be less than sum of sub-categories'); return; }
          cat.budget = newBudget;
          if (!validateGroupBudget(g, g.budget)) { showToast('Group budget cannot support this increase'); return; }
          break;
        }
      }
    } else if (type === 'sub') {
      for (const g of budgetData) {
        const parent = (g.categories || []).find(c => c.id === parentId);
        if (parent) {
          const tempParent = JSON.parse(JSON.stringify(parent));
          const sub = tempParent.subcategories.find(s => s.id === id);
          if (sub) sub.budget = newBudget;
          if (!validateCategoryBudget(tempParent, parent.budget)) { showToast('Sub-category budgets exceed parent budget'); return; }
          parent.subcategories.find(s => s.id === id).budget = newBudget;
          break;
        }
      }
    }

    await Store.set(`budget-data:${currentKey}`, budgetData);
    await renderBudget();
    showToast('Budget updated');
    return;
  }

  const delBtn = ev.target.closest('[data-del-budget]');
  if (delBtn) {
    ev.stopPropagation();
    showDeleteCallout(delBtn, 'confirm-del-budget', `${delBtn.dataset.type}|${delBtn.dataset.parentId || ''}|${delBtn.dataset.delBudget}`);
    return;
  }

  const confirmDel = ev.target.closest('[data-confirm-del-budget]');
  if (confirmDel) {
    ev.stopPropagation();
    const [type, parentId, id] = confirmDel.dataset.confirmDelBudget.split('|');
    if (type === 'group') {
      budgetData = budgetData.filter(g => g.id !== id);
    } else if (type === 'cat') {
      for (const g of budgetData) {
        if (g.categories && g.categories.some(c => c.id === id)) {
          g.categories = g.categories.filter(c => c.id !== id);
          break;
        }
      }
    } else {
      for (const g of budgetData) {
        const parent = (g.categories || []).find(c => c.id === parentId);
        if (parent && parent.subcategories) {
          parent.subcategories = parent.subcategories.filter(s => s.id !== id);
        }
      }
    }
    await Store.set(`budget-data:${currentKey}`, budgetData);
    hideDeleteCallout();
    await renderBudget();
    showToast('Budget removed');
    return;
  }
});

root.addEventListener('change', (ev) => {
  if (ev.target.matches('.inline-newcat-name')) {
    const wrap = ev.target.closest('.inline-newcat-form').querySelector('.inline-newcat-custom-wrap');
    if (wrap) {
      wrap.style.display = ev.target.value === '__custom__' ? 'block' : 'none';
      if (ev.target.value === '__custom__') wrap.querySelector('.inline-newcat-custom').focus();
    }
    return;
  }

  if (ev.target.matches('.sc-name-select')) {
    const customInput = ev.target.nextElementSibling;
    if (customInput && customInput.classList.contains('sc-name-custom')) {
      customInput.style.display = ev.target.value === '__custom__' ? 'block' : 'none';
      if (ev.target.value === '__custom__') customInput.focus();
    }
    return;
  }

  if (ev.target.id === 'f-goal-downpayment-toggle') {
    const wrap = $('#f-goal-downpayment-wrap');
    if (wrap) wrap.style.display = ev.target.checked ? 'block' : 'none';
  }
});

wireDeletePopoverDismiss(root);
window.addEventListener('auth:signed-in', renderBudget);
window.addEventListener('auth:checked', renderBudget);
authReady.then(renderBudget);
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
  loadMonth, saveMonth, cardById, allSpendTags,
  emiRowsForMonth, sipRowsForMonth, recurringRowsForMonth,
  forecastCategorySpend
} from '../core/domain.js';

const root = document.getElementById('budget-root');
const DEFAULT_TAGS = ['Groceries', 'Food', 'Fuel', 'Transport', 'Rent', 'Utility', 'Shopping', 'Recharge', 'Medicine', 'Gift', 'EMI', 'SIP', 'RECURRING'];

let budgetData = [];
let customTags = [];
let emiSeries = [];
let sipSeries = [];
let recurringSeries = [];
let currentMonthEntries = [];
let monthsIndex = [];
let domainLoaded = false;
let isFormOpen = false;
let monthEntries = [];
let draggedItem = null;

let currentKey = currentMonthKey();
let isPastMonth = false;

async function loadDomain() {
  if (domainLoaded) return;
  [customTags, emiSeries, sipSeries, recurringSeries, monthsIndex] = await Promise.all([
    Store.get('custom-spend-tags', []),
    Store.get('emiseries', []),
    Store.get('sipseries', []),
    Store.get('recurringseries', []),
    Store.get('months-index', []),
  ]);
  domainLoaded = true;
}

function calculateUsed(name, isSub, parentName) {
  if (!name || !currentMonthEntries) return 0;
  const target = name.toLowerCase().trim();
  const pTarget = parentName ? parentName.toLowerCase().trim() : null;
  let total = 0;

  for (const e of currentMonthEntries) {
    if (e.type === 'income' || e.type === 'payback') continue;
    const amt = Number(e.amount) || 0;
    if (amt <= 0) continue;

    const eType = (e.type || '').toLowerCase();
    const eTag = (e.tag || '').toLowerCase();
    const eSub = (e.subCategory || '').toLowerCase();
    const eCat = (e.category || '').toLowerCase();
    const eDesc = (e.description || '').toLowerCase();

    if (isSub) {
      if (pTarget === 'sip') {
        if ((eType === 'sip' || eTag === 'sip') && (eSub === target || eCat === target || eDesc === target)) {
          total += amt;
        }
      } else if (pTarget === 'recurring') {
        if ((eType === 'recurring' || eTag === 'recurring') && (eSub === target || eDesc === target)) {
          total += amt;
        }
      } else if (pTarget === 'emi') {
        if ((eType === 'emi' || eTag === 'emi') && (eSub === target || eDesc === target || eTag === target)) {
          total += amt;
        }
      } else {
        if (eTag === pTarget && eSub === target) {
          total += amt;
        }
      }
    } else {
      if (target === 'sip') {
        if (eType === 'sip' || eTag === 'sip' || eCat === 'sip') {
          total += amt;
        }
      } else if (target === 'recurring') {
        if (eType === 'recurring' || eTag === 'recurring') {
          total += amt;
        }
      } else if (target === 'emi') {
        if (eType === 'emi' || eTag === 'emi') {
          total += amt;
        }
      } else {
        if (eTag === target) {
          total += amt;
        }
      }
    }
  }
  return total;
}

// pct -> { label, cls } used for both row status pills and the KPI overall pill
function getStatusInfo(pct) {
  if (pct > 100) return { label: 'Over budget', cls: 'status-over' };
  if (pct > 70) return { label: 'High spend', cls: 'status-high' };
  return { label: 'On track', cls: 'status-ontrack' };
}

function computeSummary() {
  let totalBudget = 0;
  let totalUsed = 0;

  // Only top-level categories are counted: subcategory budgets/spend are
  // subsets of their parent category and would otherwise be double counted.
  budgetData.forEach(cat => {
    totalBudget += Number(cat.budget) || 0;
    totalUsed += calculateUsed(cat.name, false, null);
  });

  const totalRemaining = totalBudget - totalUsed;
  const usedPct = totalBudget > 0 ? (totalUsed / totalBudget) * 100 : (totalUsed > 0 ? 100 : 0);
  const remainingPct = totalBudget > 0 ? Math.max(0, (totalRemaining / totalBudget) * 100) : 0;

  return { totalBudget, totalUsed, totalRemaining, usedPct, remainingPct };
}

// Finds spend that isn't captured under any budgeted top-level category —
// e.g. a tag the user spent against but never set a budget for. Mirrors
// the same special-case classification calculateUsed() uses (sip/recurring/
// emi/tag) so a transaction is never double-counted as both "used" under
// a category AND "unbudgeted".
function calculateUnbudgeted() {
  if (!currentMonthEntries) return { total: 0, tags: [] };

  const budgetedNames = new Set(budgetData.map(c => c.name.toLowerCase().trim()));
  const byTag = new Map(); // key: lowercase label -> { label, amount, count }
  let total = 0;

  for (const e of currentMonthEntries) {
    if (e.type === 'income' || e.type === 'payback') continue;
    const amt = Number(e.amount) || 0;
    if (amt <= 0) continue;

    const eType = (e.type || '').toLowerCase();
    const eTag = (e.tag || '').toLowerCase();
    const eCat = (e.category || '').toLowerCase();

    let key;
    let label;
    if (eType === 'sip' || eTag === 'sip' || eCat === 'sip') {
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
  <div class="unbudgeted-callout" data-unbudgeted-callout>
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
  const { totalBudget, totalUsed, totalRemaining, usedPct, remainingPct } = computeSummary();
  const status = getStatusInfo(usedPct);

  const briefcaseSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"></rect><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"></path><path d="M2 13h20"></path></svg>`;
  const coinsSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="8" ry="3"></ellipse><path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6"></path><path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"></path></svg>`;
  const clockSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 15"></polyline></svg>`;

  const remainingClass = totalRemaining < 0 ? 'negative' : '';
  const remainingPctDisplay = totalRemaining < 0 ? '0%' : `${remainingPct.toFixed(1)}%`;

  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const clampedPct = Math.min(Math.max(usedPct, 0), 100);
  const dashOffset = circumference - (clampedPct / 100) * circumference;
  const ringColor = usedPct > 100 ? 'var(--debit)' : 'var(--credit)';

  return `
  <div class="budget-summary-grid">
    <div class="kpi-card">
      <div class="kpi-icon">${briefcaseSvg}</div>
      <div class="kpi-body">
        <div class="kpi-label">Total Budget</div>
        <div class="kpi-value">${fmtINR(totalBudget)}</div>
      </div>
    </div>
    <div class="kpi-card">
      <div class="kpi-icon">${coinsSvg}</div>
      <div class="kpi-body">
        <div class="kpi-label">Used</div>
        <div class="kpi-value">${fmtINR(totalUsed)}</div>
        <div class="kpi-sub blue">${usedPct.toFixed(1)}%</div>
      </div>
    </div>
    <div class="kpi-card">
      <div class="kpi-icon">${clockSvg}</div>
      <div class="kpi-body">
        <div class="kpi-label">Remaining</div>
        <div class="kpi-value ${remainingClass}">${fmtINR(totalRemaining)}</div>
        <div class="kpi-sub green">${remainingPctDisplay}</div>
      </div>
    </div>
    <div class="kpi-card status-card">
      <svg width="48" height="48" viewBox="0 0 48 48">
        <circle cx="24" cy="24" r="${radius}" fill="none" stroke="var(--sky)" stroke-width="5"></circle>
        <circle cx="24" cy="24" r="${radius}" fill="none" stroke="${ringColor}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${dashOffset.toFixed(2)}" transform="rotate(-90 24 24)"></circle>
        <text x="24" y="28" text-anchor="middle" font-size="11" font-family="'IBM Plex Mono', monospace" fill="var(--navy)">${Math.round(usedPct)}%</text>
      </svg>
      <div class="kpi-body">
        <div class="kpi-label">Overall</div>
        <div class="kpi-sub">${usedPct.toFixed(1)}% used</div>
        <span class="kpi-status-pill status-pill ${status.cls}">${status.label}</span>
      </div>
    </div>
  </div>
  `;
}

function renderBudgetRow(item, isSub, parentId) {
  let parentName = null;
  if (isSub && parentId) {
    const parent = budgetData.find(c => c.id === parentId);
    if (parent) parentName = parent.name;
  }
  const used = calculateUsed(item.name, isSub, parentName);
  const pct = item.budget > 0 ? (used / item.budget) * 100 : 0;
  const isDanger = pct > 100;
  const status = item.budget > 0 ? getStatusInfo(pct) : { label: 'Unassigned', cls: 'status-unassigned' };

  let forecastHtml = '';
  const forecast = forecastCategorySpend(item.name, isSub, parentName, item.budget, currentKey, currentMonthEntries);
  if (forecast) {
    const svgs = {
      'ok': `<svg viewBox="0 0 24 24"><polyline points="23 6 9 20 1 12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></polyline></svg>`,
      'warning': `<svg viewBox="0 0 24 24"><path d="M12 2L2 20h20L12 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>`,
      'auto-over': `<svg viewBox="0 0 24 24"><path d="M12 2L2 20h20L12 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>`
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
  const dotsSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="12" cy="12" r="2"></circle><circle cx="12" cy="5" r="2"></circle><circle cx="12" cy="19" r="2"></circle></svg>`;

  let chevronHtml = '';
  if (!isSub) {
    chevronHtml = `<button class="toggle-sub ${item.expanded ? 'expanded' : ''}" data-toggle-sub="${item.id}" title="${item.expanded ? 'Collapse' : 'Expand'}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></button>`;
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
  <div class="budget-row ${isSub ? 'is-sub' : ''}" data-id="${item.id}" data-type="${isSub ? 'sub' : 'cat'}" data-parent-id="${parentId ? parentId : ''}" draggable="${!isPastMonth}">
    <div class="cat-name-col">
      ${dragHandleSvg}
      ${escapeHtml(item.name)}
    </div>
    <div class="budget-amt-col">
      ${fmtINR(item.budget)}
    </div>
    <div class="budget-progress">
      <div style="text-align: right;">${fmtINR(used)} (${status.cls === 'status-unassigned' ? '--' : Math.round(pct)}%)</div>
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

async function renderBudget() {
  await loadDomain();

  currentKey = root.dataset.monthKey || currentMonthKey();
  isPastMonth = currentKey < currentMonthKey();

  budgetData = await Store.get(`budget-data:${currentKey}`, null);
  if (!budgetData) {
    const legacy = await Store.get('budget-data', null);
    if (legacy && currentKey === currentMonthKey()) {
      budgetData = legacy;
      await Store.set(`budget-data:${currentKey}`, budgetData);
    } else if (currentKey === currentMonthKey()) {
      const lastLogged = monthsIndex.length ? monthsIndex[monthsIndex.length - 1] : null;
      if (lastLogged && lastLogged !== currentKey) {
        budgetData = await Store.get(`budget-data:${lastLogged}`, []) || [];
      } else {
        budgetData = [];
      }
      await Store.set(`budget-data:${currentKey}`, budgetData);
    } else {
      budgetData = [];
    }
  }

  // Handle deep link from Month -> Budget
  const openReq = sessionStorage.getItem('month-to-budget-open');
  let scrollTargetId = null;
  if (openReq) {
    try {
      const { tagName, monthKey: reqMk } = JSON.parse(openReq);
      if (reqMk === currentKey) {
        const targetLower = tagName.toLowerCase();
        for (const cat of budgetData) {
          if (cat.name.toLowerCase() === targetLower) { scrollTargetId = cat.id; break; }
          const sub = (cat.subcategories || []).find(s => s.name.toLowerCase() === targetLower);
          if (sub) { scrollTargetId = sub.id; cat.expanded = true; break; } // auto-expand parent
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
  budgetData.forEach(cat => {
    totalBudget += cat.budget;
    totalUsed += calculateUsed(cat.name, false, null);
    tableRows += renderBudgetRow(cat, false, null);
    
    tableRows += `<div class="subcat-wrap ${cat.expanded ? 'expanded' : ''}" data-subcat-wrap="${cat.id}"><div class="subcat-inner">`;
    if (cat.subcategories && cat.subcategories.length > 0) {
      cat.subcategories.forEach(sub => {
        tableRows += renderBudgetRow(sub, true, cat.id);
      });
    }
    if (!isPastMonth) {
      tableRows += `<button class="add-row-btn is-sub" data-inline-add-btn="${cat.id}" type="button">+ Add subcategory for ${escapeHtml(cat.name)}</button>`;
    }
    tableRows += `</div></div>`;
  });

  if (!tableRows) {
    const hasPrevLogged = monthsIndex.some(m => m < currentKey);
    if (!isPastMonth && hasPrevLogged) {
      tableRows = `
        <div class="empty-chart" style="padding: 24px 0; grid-column: 1/-1; display: flex; flex-wrap: wrap; gap: 12px;">
          <button class="add-row-btn" data-inline-newcat-btn type="button" style="flex: 1 1 250px; margin: 0;">+ Add budget for a category</button>
          <button class="add-row-btn" id="copy-last-budget-btn" type="button" style="flex: 1 1 250px; margin: 0; border-color: var(--sky); color: var(--blue);">Copy from the last logged month</button>
        </div>
      `;
    } else if (!isPastMonth) {
      tableRows = `
        <div class="empty-chart" style="padding: 24px 0; grid-column: 1/-1; display: flex; flex-wrap: wrap;">
          <button class="add-row-btn" data-inline-newcat-btn type="button" style="flex: 1 1 100%; margin: 0;">+ Add budget for a category</button>
        </div>
      `;
    } else {
      tableRows = `<div class="empty-chart" style="padding: 24px; grid-column: 1/-1; text-align: center; color: var(--muted);">No budgets set for this month.</div>`;
    }
  } else {
    if (!isPastMonth) {
      tableRows += `<button class="add-row-btn" data-inline-newcat-btn type="button">+ Add budget for a category</button>`;
    }
  }

  // Aggregate expand/collapse state, purely for the "Expand All" button's
  // initial label/icon on a full render — the button's own click handler
  // never re-renders, it just flips classes (see click handler below).
  const catsWithSubs = budgetData.filter(c => c.subcategories && c.subcategories.length > 0);
  const allExpanded = catsWithSubs.length > 0 && catsWithSubs.every(c => c.expanded);

  const allTags = allSpendTags(DEFAULT_TAGS, customTags);
  const tagOptions = allTags.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');

  const formHtml = isFormOpen ? `
  <div class="form-panel slide-down-fade" style="margin: 14px 0px;">
    <div class="form-row">
      <div class="field">
        <label>Category (Tag)</label>
        <select id="f-cat-name">
          <option value="" disabled selected>Select tag...</option>
          ${tagOptions}
          <option value="__custom__">+ Add custom tag</option>
        </select>
      </div>
      <div class="field" id="f-cat-custom-wrap" style="display:none;">
        <label>New tag name</label>
        <input id="f-cat-custom" type="text" placeholder="e.g. Pets" />
      </div>
      <div class="field">
        <label>Budget (₹)</label>
        <input id="f-cat-budget" type="number" step="0.01" min="0" placeholder="0.00" />
      </div>
    </div>
    <div id="subcat-container"></div>
    <div style="margin-top: 10px; margin-bottom: 14px;">
      <button class="btn ghost small" id="f-add-subcat" disabled>+ Add subcategory</button>
    </div>
    <div class="form-actions">
      <button class="btn primary" data-submit-budget type="button">Save Budget</button>
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
    ${renderUnbudgetedCallout()}

    <div class="pill-grid" style="margin-bottom: 16px;">
      ${!isPastMonth ? `<button class="pill-btn ${isFormOpen ? '' : 'active'}" data-budget-form-toggle type="button">+ Add Budget</button>` : ''}
      ${catsWithSubs.length > 0 ? `
      <button class="pill-btn expand-all-btn ${allExpanded ? 'expanded' : ''}" data-expand-all type="button">
        <svg class="expand-all-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
        <span data-expand-all-label>${allExpanded ? 'Collapse All' : 'Expand All'}</span>
      </button>` : ''}
    </div>
    ${!isPastMonth ? formHtml : ''}
    
    <div class="budget-list">
        <div class="budget-header">
            <div>Category</div>
            <div class="b-budget-header">Budget</div>
            <div class="b-used-header">Used</div>
            <div class="b-status-header">Status</div>
            <div></div>
        </div>
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
    parentId: row.dataset.parentId || null
  };
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', draggedItem.id);
  row.style.opacity = '0.4';
});

root.addEventListener('dragend', (ev) => {
  const row = ev.target.closest('.budget-row');
  if (row) row.style.opacity = '1';
  document.querySelectorAll('.drag-over, .drag-over-right').forEach(el => {
    el.classList.remove('drag-over', 'drag-over-right');
  });
  draggedItem = null;
});

root.addEventListener('dragover', (ev) => {
  if (isPastMonth) return;
  ev.preventDefault();
  const row = ev.target.closest('.budget-row');
  if (!row) return;

  const targetType = row.dataset.type;
  const targetParentId = row.dataset.parentId || null;
  const targetId = row.dataset.id;

  if (draggedItem && draggedItem.type === 'sub') {
    if (targetType === 'cat' || targetParentId !== draggedItem.parentId) {
      ev.dataTransfer.dropEffect = 'none';
      document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
      return;
    }
  }

  if (draggedItem && draggedItem.type === 'cat' && targetType === 'sub') {
    ev.dataTransfer.dropEffect = 'none';
    document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
    return;
  }

  const rect = row.getBoundingClientRect();
  const isBottomHalf = ev.clientY > rect.top + rect.height / 2;

  document.querySelectorAll('.drop-above, .drop-below').forEach(el => {
    if (el !== row) el.classList.remove('drop-above', 'drop-below');
  });

  row.classList.remove('drop-above', 'drop-below');
  row.classList.add(isBottomHalf ? 'drop-below' : 'drop-above');
});

root.addEventListener('dragleave', (ev) => {
  const row = ev.target.closest('.budget-row');
  if (row) {
    if (!row.contains(ev.relatedTarget)) {
      row.classList.remove('drop-above', 'drop-below');
    }
  }
});

root.addEventListener('dragend', (ev) => {
  const row = ev.target.closest('.budget-row');
  if (row) row.style.opacity = '1';
  document.querySelectorAll('.drop-above, .drop-below').forEach(el => {
    el.classList.remove('drop-above', 'drop-below');
  });
  draggedItem = null;
});

root.addEventListener('drop', async (ev) => {
  if (isPastMonth) return;
  ev.preventDefault();
  const row = ev.target.closest('.budget-row');
  if (!row || !draggedItem) return;

  const targetId = row.dataset.id;
  const targetType = row.dataset.type;
  const targetParentId = row.dataset.parentId || null;

  if (draggedItem.type === 'sub') {
    if (targetType === 'cat' || targetParentId !== draggedItem.parentId) {
      document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
      draggedItem = null;
      return;
    }
  }

  if (draggedItem.type === 'cat' && targetType === 'sub') {
    document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
    draggedItem = null;
    return;
  }

  if (draggedItem.id === targetId) {
     document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
     draggedItem = null;
     return;
  }

  let itemToMove;
  if (draggedItem.type === 'cat') {
    const idx = budgetData.findIndex(c => c.id === draggedItem.id);
    if (idx > -1) itemToMove = budgetData.splice(idx, 1)[0];
  } else {
    const parent = budgetData.find(c => c.id === draggedItem.parentId);
    if (parent && parent.subcategories) {
      const idx = parent.subcategories.findIndex(s => s.id === draggedItem.id);
      if (idx > -1) itemToMove = parent.subcategories.splice(idx, 1)[0];
    }
  }

  if (!itemToMove) return;

  const rect = row.getBoundingClientRect();
  const isBottomHalf = ev.clientY > rect.top + rect.height / 2;

  if (targetType === 'cat') {
    const targetIdx = budgetData.findIndex(c => c.id === targetId);
    budgetData.splice(isBottomHalf ? targetIdx + 1 : targetIdx, 0, itemToMove);
  } else if (targetType === 'sub') {
    const parent = budgetData.find(c => c.id === targetParentId);
    if (parent && parent.subcategories) {
      const targetIdx = parent.subcategories.findIndex(s => s.id === targetId);
      parent.subcategories.splice(isBottomHalf ? targetIdx + 1 : targetIdx, 0, itemToMove);
      parent.expanded = true;
    }
  }

  document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
  draggedItem = null;

  await Store.set(`budget-data:${currentKey}`, budgetData);
  await renderBudget();
  showToast('Order updated');
});

// Click Handlers
root.addEventListener('click', async (ev) => {
  const toggleRowActions = ev.target.closest('[data-toggle-row-actions]');
  if (toggleRowActions) {
    const row = toggleRowActions.closest('.budget-row');
    const wasOpen = row.classList.contains('show-actions');
    document.querySelectorAll('.budget-row.show-actions').forEach(r => r.classList.remove('show-actions'));
    if (!wasOpen) row.classList.add('show-actions');
    ev.stopPropagation();
    return;
  }

  if (!ev.target.closest('.actions-col') || (ev.target.closest('.row-menu-btn') && !ev.target.closest('[data-del-budget]'))) {
    document.querySelectorAll('.budget-row.show-actions').forEach(r => r.classList.remove('show-actions'));
  }

  const inlineAddSubBtn = ev.target.closest('[data-inline-add-btn]');
  if (inlineAddSubBtn) {
    ev.stopPropagation();
    const existingForm = document.querySelector('.inline-subcat-form, .inline-newcat-form');
    const parentCatId = inlineAddSubBtn.dataset.inlineAddBtn;
    const reopenSame = existingForm && existingForm.dataset.inlineFor === parentCatId;
    
    if (existingForm) existingForm.remove();
    if (reopenSame) return;

    const parentCat = budgetData.find(c => c.id === parentCatId);
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
    const reopenSame = existingForm && existingForm.classList.contains('inline-newcat-form');
    
    if (existingForm) existingForm.remove();
    if (reopenSame) return;

    const allTags = allSpendTags(DEFAULT_TAGS, customTags);
    const tagOptions = allTags.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');

    const formEl = document.createElement('div');
    formEl.className = 'inline-newcat-form form-panel slide-down-fade';
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
        <button class="btn primary" data-inline-newcat-save type="button">Save</button>
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
    for (const c of budgetData) {
      if (c.name.toLowerCase() === name.toLowerCase()) isDuplicate = true;
      if (c.subcategories && c.subcategories.some(s => s.name.toLowerCase() === name.toLowerCase())) isDuplicate = true;
    }
    if (isDuplicate) { showToast('Name already in use'); return; }

    const parentCat = budgetData.find(c => c.id === parentCatId);
    if (!parentCat) { showToast('Parent category not found'); return; }

    const sumSubs = (parentCat.subcategories || []).reduce((s, sub) => s + (Number(sub.budget) || 0), 0);
    if (sumSubs + amount > parentCat.budget) {
      showToast('Sub-category budgets exceed parent budget');
      return;
    }

    parentCat.subcategories = parentCat.subcategories || [];
    const newSub = { id: uid(), name, budget: amount };
    parentCat.subcategories.push(newSub);
    parentCat.expanded = true;

    await Store.set(`budget-data:${currentKey}`, budgetData);
    await renderBudget();
    showToast('Subcategory added');
    return;
  }

  const inlineNewCatSaveBtn = ev.target.closest('[data-inline-newcat-save]');
  if (inlineNewCatSaveBtn) {
    const formEl = inlineNewCatSaveBtn.closest('.inline-newcat-form');
    const select = formEl.querySelector('.inline-newcat-name');
    const customInput = formEl.querySelector('.inline-newcat-custom');
    const budgetInput = formEl.querySelector('.inline-newcat-budget');

    let catName = select.value;
    if (catName === '__custom__') catName = customInput.value.trim();
    const catBudget = Number(budgetInput.value) || 0;

    if (!catName || catBudget <= 0) { showToast('Enter valid category name and budget'); return; }

    let isDuplicateSub = false;
    for (const c of budgetData) {
      if (c.subcategories && c.subcategories.some(s => s.name.toLowerCase() === catName.toLowerCase())) {
        isDuplicateSub = true;
      }
    }
    if (isDuplicateSub) { showToast('Name already in use as a subcategory'); return; }

    if (select.value === '__custom__') {
      if (!allSpendTags(DEFAULT_TAGS, customTags).some(t => t.toLowerCase() === catName.toLowerCase())) {
        customTags.push(catName);
        await Store.set('custom-spend-tags', customTags);
      }
    }

    const existingIdx = budgetData.findIndex(c => c.name.toLowerCase() === catName.toLowerCase());
    if (existingIdx > -1) {
      budgetData[existingIdx].budget = catBudget;
    } else {
      const newCat = { id: uid(), name: catName, budget: catBudget, expanded: true, subcategories: [] };
      budgetData.push(newCat);
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

  const formToggle = ev.target.closest('[data-budget-form-toggle]');
  if (formToggle) { isFormOpen = !isFormOpen; await renderBudget(); return; }
  
  const closeForm = ev.target.closest('[data-close-budget-form]');
  if (closeForm) { isFormOpen = false; await renderBudget(); return; }

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

    budgetData.forEach(cat => {
      if (!cat.subcategories || cat.subcategories.length === 0) return;
      cat.expanded = shouldExpand;

      const wrapper = document.querySelector(`[data-subcat-wrap="${cat.id}"]`);
      if (wrapper) wrapper.classList.toggle('expanded', shouldExpand);

      const chevron = document.querySelector(`[data-toggle-sub="${cat.id}"]`);
      if (chevron) chevron.classList.toggle('expanded', shouldExpand);
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
    const cat = budgetData.find(c => c.id === toggleSub.dataset.toggleSub);
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

  if (ev.target.closest('#f-add-subcat')) {
    let catName = $('#f-cat-name').value;
    if (catName === '__custom__') catName = $('#f-cat-custom').value.trim();

    let existingSubs = [];
    if (catName) {
      const cat = budgetData.find(c => c.name.toLowerCase() === catName.toLowerCase());
      if (cat && cat.subcategories) existingSubs = cat.subcategories.map(s => s.name);
    }
    const subOptions = existingSubs.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');

    const container = $('#subcat-container');
    const row = document.createElement('div');
    row.className = 'form-row subcat-row';
    row.style.alignItems = 'flex-start';
    row.innerHTML = `
      <div class="field">
        <label>Sub-category Tag</label>
        <select class="sc-name-select" style="padding: 10px 12px; border: 1px solid var(--hair); border-radius: 7px; width: 100%; font-family: 'Source Serif 4', serif; font-size: 0.95rem; background: #fff;">
          <option value="" disabled selected>Select...</option>
          ${subOptions}
          <option value="__custom__">+ Add sub-category</option>
        </select>
        <input type="text" class="sc-name-custom" placeholder="e.g. Meat" style="display:none; margin-top: 6px; padding: 10px 12px; border: 1px solid var(--hair); border-radius: 7px; width: 100%; font-family: 'Source Serif 4', serif; font-size: 0.95rem;" />
      </div>
      <div style="display: flex; flex-wrap: nowrap; gap: 10px;">
        <div class="field" style="width: 100%;"><label>Budget (₹)</label><input type="number" step="0.01" min="0" class="sc-budget" placeholder="0.00" /></div>
        <button class="icon-btn" data-remove-subcat-row style="align-self: flex-end; margin-bottom: 8px;">✕</button>
      </div>
    `;
    container.appendChild(row);
    return;
  }
  
  if (ev.target.closest('[data-remove-subcat-row]')) {
    ev.target.closest('.subcat-row').remove();
    return;
  }

  if (ev.target.closest('[data-submit-budget]')) {
    let catName = $('#f-cat-name').value;
    if (catName === '__custom__') catName = $('#f-cat-custom').value.trim();
    const catBudget = Number($('#f-cat-budget').value) || 0;
    
    if (!catName || catBudget <= 0) { showToast('Enter valid category name and budget'); return; }

    let isDuplicateCat = false;
    for (const c of budgetData) {
      if (c.subcategories && c.subcategories.some(s => s.name.toLowerCase() === catName.toLowerCase())) {
        isDuplicateCat = true;
      }
    }
    if (isDuplicateCat) { showToast('Category name already in use as a subcategory'); return; }

    const subcatRows = Array.from(document.querySelectorAll('.subcat-row'));
    const subcats = [];
    let subcatSum = 0;
    
    for (const row of subcatRows) {
      const select = row.querySelector('.sc-name-select');
      const custom = row.querySelector('.sc-name-custom');
      let sname = select ? select.value : '';
      if (sname === '__custom__') sname = custom.value.trim();

      const sbudg = Number(row.querySelector('.sc-budget').value) || 0;
      if (sname && sbudg > 0) {
        let isDupSub = false;
        if (sname.toLowerCase() === catName.toLowerCase()) isDupSub = true;
        for (const c of budgetData) {
          if (c.name.toLowerCase() === sname.toLowerCase()) isDupSub = true;
          if (c.subcategories && c.subcategories.some(s => s.name.toLowerCase() === sname.toLowerCase())) isDupSub = true;
        }
        if (subcats.some(s => s.name.toLowerCase() === sname.toLowerCase())) isDupSub = true;

        if (isDupSub) { showToast('Subcategory name already in use'); return; }

        subcats.push({ id: uid(), name: sname, budget: sbudg });
        subcatSum += sbudg;
      }
    }

    if (subcatSum > catBudget) {
      showToast('Sum of sub-category budgets exceeds parent budget');
      return;
    }

    if (catName === '__custom__') {
       const custom = $('#f-cat-custom').value.trim();
       if (!allSpendTags(DEFAULT_TAGS, customTags).some(t => t.toLowerCase() === custom.toLowerCase())) {
         customTags.push(custom);
         await Store.set('custom-spend-tags', customTags);
       }
       catName = custom;
    }

    const existingIdx = budgetData.findIndex(c => c.name.toLowerCase() === catName.toLowerCase());
    if (existingIdx > -1) {
      budgetData[existingIdx].budget = catBudget;
      if (subcats.length > 0) {
         budgetData[existingIdx].subcategories = budgetData[existingIdx].subcategories || [];
         budgetData[existingIdx].subcategories.push(...subcats);
      }
    } else {
      budgetData.push({
        id: uid(),
        name: catName,
        budget: catBudget,
        expanded: true,
        subcategories: subcats
      });
    }

    await Store.set(`budget-data:${currentKey}`, budgetData);
    isFormOpen = false;
    await renderBudget();
    showToast('Budget added');
    return;
  }

  const editBtn = ev.target.closest('[data-edit-budget]');
  if (editBtn) {
    const row = editBtn.closest('.budget-row');
    const amtCol = row.querySelector('.budget-amt-col');
    const currentAmtText = amtCol.textContent.trim().replace(/[^0-9.]/g, '');
    
    amtCol.innerHTML = `
      <input type="number" step="0.01" min="0" class="inline-edit-input" value="${currentAmtText}" />
      <button class="icon-btn" data-save-edit="${editBtn.dataset.editBudget}" data-type="${editBtn.dataset.type}" data-parent-id="${editBtn.dataset.parentId || ''}" style="color:var(--credit);">✓</button>
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

    if (type === 'cat') {
      const cat = budgetData.find(c => c.id === id);
      if (cat) {
        const sumSubs = (cat.subcategories || []).reduce((s, sub) => s + sub.budget, 0);
        if (newBudget < sumSubs) {
          showToast('Budget cannot be less than sum of sub-categories');
          return;
        }
        cat.budget = newBudget;
      }
    } else if (type === 'sub') {
      const parent = budgetData.find(c => c.id === parentId);
      if (parent) {
        const sumOtherSubs = (parent.subcategories || []).reduce((s, sub) => s + (sub.id === id ? 0 : sub.budget), 0);
        if (sumOtherSubs + newBudget > parent.budget) {
          showToast('Sub-category budgets exceed parent budget');
          return;
        }
        const sub = parent.subcategories.find(s => s.id === id);
        if (sub) sub.budget = newBudget;
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
    if (type === 'cat') {
      budgetData = budgetData.filter(c => c.id !== id);
    } else {
      const parent = budgetData.find(c => c.id === parentId);
      if (parent && parent.subcategories) {
        parent.subcategories = parent.subcategories.filter(s => s.id !== id);
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

  if (ev.target.id === 'f-cat-name') {
    const val = ev.target.value;
    const customWrap = $('#f-cat-custom-wrap');
    if (customWrap) customWrap.style.display = val === '__custom__' ? 'block' : 'none';
    
    const addSubBtn = $('#f-add-subcat');
    if (addSubBtn) addSubBtn.disabled = !val;

    $('#subcat-container').innerHTML = '';

    const budgetInput = $('#f-cat-budget');
    if (budgetInput && val !== '__custom__') {
      const existingCat = budgetData.find(c => c.name.toLowerCase() === val.toLowerCase());
      budgetInput.value = existingCat ? existingCat.budget : '';
    } else if (budgetInput) {
      budgetInput.value = '';
    }
  }
});

wireDeletePopoverDismiss(root);
window.addEventListener('auth:signed-in', renderBudget);
window.addEventListener('auth:checked', renderBudget);
authReady.then(renderBudget);
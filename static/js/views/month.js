/* ---------- /month/<month_key> ---------- */
import { Store } from '../core/store.js';
import { $, $$, uid, escapeHtml } from '../core/dom.js';
import { fmtINR, todayStr, currentMonthKey, monthKeyLabel, addMonths, diffMonths, ordinalSuffix } from '../core/format.js';
import { authReady } from '../core/auth.js';
import {
  loadMonth, saveMonth, ensureMonthIndexed, emiRowsForMonth, sipRowsForMonth, recurringRowsForMonth,
  computeMonthTotals, computeGlobalStats, cardById, allSpendTags,
} from '../core/domain.js';
import { renderStatCards, wireStatCardFlip } from '../components/stat-cards.js';
import { donutChart } from '../components/charts/donut.js';
import { barChart, tagsBarChart } from '../components/charts/bar-chart.js';
import { lineChart, wireChartTooltips } from '../components/charts/line-chart.js';
import { scrollWrapper, setupScrollWrappers, setupTableScrollIndicators } from '../components/scroll-wrapper.js';
import { appendPageChrome } from '../components/page-chrome.js';
import { showToast } from '../components/toast.js';
import { markRendered } from '../components/render-guard.js';

const root = document.getElementById('month-root');
const monthKey = root.dataset.monthKey;

const DEFAULT_TAGS = ['Groceries', 'Food', 'Fuel', 'Transport', 'Rent', 'Utility', 'Shopping', 'Recharge', 'Medicine'];

let cards = [];
let emiSeries = [];
let sipSeries = [];
let recurringSeries = [];
let monthsIndex = [];
let customTags = [];
let budgetData = [];
let priceTrackDictionary = {};
let priceItems = [];
let existingInvestments = 0;
let splitsIndex = [];
let openForm = null;
let expenseMenuOpen = false;
let isExpenseMenuOpening = false;
let isFormOpening = false;
let animTimeout = null;
let domainLoaded = false;
let currentSipFilter = 'All';

const PILL_ORDER = ['spend', 'cardcharge', 'cashpayment', 'recurring', 'income', 'owed', 'emi', 'invest'];

let activeTypeFilters = [];
let activeTagFilters = [];
let currentSort = { key: 'date', asc: false };
let deductCcCash = false;

const TABLE_TYPE_LABELS = {
  spend: 'Spend',
  cardcharge: 'Card spend',
  cashpayment: 'Cash spend',
  income: 'Income',
  payback: 'Payback',
  owed: 'Owed to you',
  investment: 'Investment',
  emi: 'EMI',
  sip: 'Investment',
  recurring: 'Recurring',
};

function getTableTypeLabel(e) {
  if (e.type === 'spend' && Number(e.amount) < 0) return 'Payback';
  return TABLE_TYPE_LABELS[e.type] || String(e.type || 'Unknown');
}

function getTableTagLabel(e) {
  if (['spend', 'cardcharge', 'cashpayment'].includes(e.type)) {
    return String(e.tag || '').trim() || 'Untagged';
  }

  if (['income', 'sip', 'investment'].includes(e.type)) {
    return String(e.category || '').trim() || 'Untagged';
  }

  return 'Untagged';
}

function hasLentData(e) {
  return Array.isArray(e.lent) && e.lent.length > 0;
}

function getTableSortDirectionLabel(key, asc) {
  if (key === 'date') return asc ? 'Oldest first' : 'Newest first';
  if (key === 'amount') return asc ? 'Low to High' : 'High to Low';
  if (key === 'type') return asc ? 'A-Z' : 'Z-A';
  if (key === 'tag') return asc ? 'A-Z' : 'Z-A';
  return '';
}

function compareTableRows(a, b, key) {
  if (key === 'date') {
    const aDate = Number.isFinite(Date.parse(a.date || '')) ? Date.parse(a.date || '') : -Infinity;
    const bDate = Number.isFinite(Date.parse(b.date || '')) ? Date.parse(b.date || '') : -Infinity;
    return aDate - bDate;
  }

  if (key === 'amount') {
    return Math.abs(Number(a.amount) || 0) - Math.abs(Number(b.amount) || 0);
  }

  if (key === 'type') {
    return getTableTypeLabel(a).localeCompare(
      getTableTypeLabel(b),
      undefined,
      { sensitivity: 'base' }
    );
  }

  if (key === 'tag') {
    return getTableTagLabel(a).localeCompare(
      getTableTagLabel(b),
      undefined,
      { sensitivity: 'base' }
    );
  }

  return 0;
}

// Fetched once. renderMonth() is called on almost every interaction on
// this page (add/delete an entry, toggle starting balance, settle a debt,
// skip a SIP...) — without this guard every one of those was doing 7
// network round trips before rebuilding the DOM. Every mutation below
// (EMI series, custom tags, price-tracker items, etc.) already updates
// these arrays/objects in place before calling Store.set(), so the cache
// stays correct without a refetch.
async function loadDomain() {
  if (domainLoaded) return;
  [cards, emiSeries, sipSeries, monthsIndex, customTags, budgetData, priceTrackDictionary, priceItems, existingInvestments, splitsIndex, recurringSeries] = await Promise.all([
    Store.get('creditcards', []),
    Store.get('emiseries', []),
    Store.get('sipseries', []),
    Store.get('months-index', []),
    Store.get('custom-spend-tags', []),
    Store.get(`budget-data:${monthKey}`, null),
    Store.get('price-track-dict', {}),
    Store.get('price-items', []),
    Store.get('existinginvestments', 0),
    Store.get('splits-index', []),
    Store.get('recurringseries', []),
  ]);
  if (!budgetData) {
     budgetData = await Store.get('budget-data', []);
  }
  domainLoaded = true;
}

async function resolveTagFromForm() {
  const sel = $('#f-tag');
  if (!sel) return '';
  const val = sel.value;
  if (val === '__custom__') {
    const custom = ($('#f-tag-custom')?.value || '').trim();
    if (!custom) return '';
    const exists = allSpendTags(DEFAULT_TAGS, customTags).some(t => t.toLowerCase() === custom.toLowerCase());
    if (!exists) {
      customTags.push(custom);
      await Store.set('custom-spend-tags', customTags);
    }
    return custom;
  }
  return val;
}

/* ---------- Row + form rendering ---------- */
function renderRow(e, key, rowspan = 1, isFirstDateRow = true) {
  let dateCell = '';
  if (isFirstDateRow) {
    let dateContent = '—';
    if (e.date) {
      const dt = new Date(e.date + 'T00:00:00');
      const day = dt.toLocaleDateString('en-IN', { day: '2-digit' });
      const month = dt.toLocaleDateString('en-IN', { month: 'short' });
      const weekday = dt.toLocaleDateString('en-IN', { weekday: 'short' });
      dateContent = `
        <div class="dv-date-badge" style="display: inline-flex; flex-wrap: wrap; flex-direction: column;">
          <div class="dv-date-top" style="white-space: nowrap;">
            <strong class="dv-date-day" style="display: inline-block; font-size: 1.2rem; font-weight: 600;">${day}</strong>
            <span class="dv-date-month">${month}</span>
          </div>
          <div class="dv-date-weekday" style="color: var(--muted);">${weekday}</div>
        </div>
      `;
    }
    dateCell = `<td class="dv-date" rowspan="${rowspan}">${dateContent}</td>`;
  }

  let metaHtml = '';
  const meta = e.meta || null;
  if (meta) {
    if (meta.source && meta.destination) metaHtml = `</br><span class="meta-text">${escapeHtml(meta.source)} → ${escapeHtml(meta.destination)}</span>`;
    else if (meta.quantity && meta.location) metaHtml = `</br><span class="meta-text">${escapeHtml(meta.quantity)} @ ${escapeHtml(meta.location)}</span>`;
    else if (meta.quantity) metaHtml = `</br><span class="meta-text">${escapeHtml(meta.quantity)}</span>`;
    else if (meta.location) metaHtml = `</br><span class="meta-text">${escapeHtml(meta.location)}</span>`;
    else if (meta.purpose) metaHtml = `</br><span class="meta-text">${escapeHtml(meta.purpose)}</span>`;
  }

  const editSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>`;

  const hasLent = Array.isArray(e.lent) && e.lent.length > 0;
  const lentTypeHtml = hasLent ? `<div style="margin-top: 6px;"><span class="tag owed">LENT</span></div>` : '';

  let tagHtml = '';
  if (e.tag) {
    tagHtml = ` <button class="src-badge" data-view-budget="${escapeHtml(e.tag)}" title="View in Budget" style="border:none; cursor:pointer;">${escapeHtml(e.tag)}</button>`;
  }
  if (e.subCategory) {
    tagHtml += ` <button class="src-badge subcat" data-view-budget="${escapeHtml(e.subCategory)}" title="View in Budget" style="border:none; cursor:pointer;">${escapeHtml(e.subCategory)}</button>`;
  }

  if (e.type === 'spend') {
    const isNegative = e.amount < 0;
    const displayAmount = isNegative ? Math.abs(e.amount) : e.amount;
    const card = e.paymentMode === 'card' ? cardById(cards, e.cardId) : null;
    const lentChips = (e.lent || []).map(l => `
      <span class="chip ${l.settled ? 'settled' : ''}">
        <button class="lent-toggle ${l.settled ? 'checked' : ''}" data-toggle-lent="${e.id}|${l.id}" type="button" role="checkbox" aria-checked="${l.settled}" title="${l.settled ? 'Undo payback' : 'Mark as paid back'}"></button>
        ${l.settled ? `<s>${escapeHtml(l.person)}</s>` : escapeHtml(l.person)} · ${fmtINR(l.amount)}
      </span>`).join('');

    if (isNegative) {
      return `<tr>
        ${dateCell}
        <td class="type-cell"><span class="tag payback">Payback</span>${lentTypeHtml}</td>
        <td class="desc-cell">
          <strong>${escapeHtml(e.description)}</strong><span class="tags-area">${tagHtml}</span>${metaHtml}
          <div class="subnote">Cash / debit</div>
          ${lentChips ? `<div class="chip-row">${lentChips}</div>` : ''}
        </td>
        <td class="num amt-credit">+${fmtINR(displayAmount)}</td>
        <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-edit-entry="${key}|${e.id}" title="Edit">${editSvg}</button></span></td>
      </tr>`;
    }

    return `<tr>
      ${dateCell}
      <td class="type-cell"><span class="tag spend">Spend</span>${lentTypeHtml}</td>
      <td class="desc-cell">
        <strong>${escapeHtml(e.description)}</strong><span class="tags-area">${tagHtml}</span>${metaHtml}
        <div class="subnote">${card ? 'Paid for ' + escapeHtml(card.name) + ' — reduces card dues' : 'Cash / debit'}</div>
        ${lentChips ? `<div class="chip-row">${lentChips}</div>` : ''}
      </td>
      <td class="num amt-debit">-${fmtINR(displayAmount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-edit-entry="${key}|${e.id}" title="Edit">${editSvg}</button></span></td>
    </tr>`;
  }
  if (e.type === 'cardcharge') {
    const card = cardById(cards, e.cardId);
    const lentChips = (e.lent || []).map(l => `
      <span class="chip ${l.settled ? 'settled' : ''}">
        <button class="lent-toggle ${l.settled ? 'checked' : ''}" data-toggle-lent="${e.id}|${l.id}" type="button" role="checkbox" aria-checked="${l.settled}" title="${l.settled ? 'Undo payback' : 'Mark as paid back'}"></button>
        ${l.settled ? `<s>${escapeHtml(l.person)}</s>` : escapeHtml(l.person)} · ${fmtINR(l.amount)}
      </span>`).join('');
    return `<tr>
      ${dateCell}
      <td class="type-cell"><span class="tag cardcharge">Card spend</span>${lentTypeHtml}</td>
      <td class="desc-cell">
        <strong>${escapeHtml(e.description)}</strong><span class="tags-area">${tagHtml}</span>${metaHtml}
        <div class="subnote">On ${card ? escapeHtml(card.name) : 'a removed card'} — adds to card dues</div>
        ${lentChips ? `<div class="chip-row">${lentChips}</div>` : ''}
      </td>
      <td class="num amt-neutral">${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-edit-entry="${key}|${e.id}" title="Edit">${editSvg}</button></span></td>
    </tr>`;
  }
  if (e.type === 'cashpayment') {
    const lentChips = (e.lent || []).map(l => `
      <span class="chip ${l.settled ? 'settled' : ''}">
        <button class="lent-toggle ${l.settled ? 'checked' : ''}" data-toggle-lent="${e.id}|${l.id}" type="button" role="checkbox" aria-checked="${l.settled}" title="${l.settled ? 'Undo payback' : 'Mark as paid back'}"></button>
        ${l.settled ? `<s>${escapeHtml(l.person)}</s>` : escapeHtml(l.person)} · ${fmtINR(l.amount)}
      </span>`).join('');
    return `<tr>
      ${dateCell}
      <td class="type-cell"><span class="tag cashpayment">Cash spend</span>${lentTypeHtml}</td>
      <td class="desc-cell">
        <strong>${escapeHtml(e.description)}</strong><span class="tags-area">${tagHtml}</span>${metaHtml}
        <div class="subnote">Physical cash spent — already accounted for via withdrawal</div>
        ${lentChips ? `<div class="chip-row">${lentChips}</div>` : ''}
      </td>
      <td class="num amt-neutral">${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-edit-entry="${key}|${e.id}" title="Edit">${editSvg}</button></span></td>
    </tr>`;
  }
  if (e.type === 'income') {
    return `<tr>
      ${dateCell}
      <td class="type-cell"><span class="tag income">Income</span></td>
      <td class="desc-cell"><strong>${escapeHtml(e.description)}</strong>${e.category ? ` <span class="src-badge">${escapeHtml(e.category)}</span>` : ''}</td>
      <td class="num amt-credit">+${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-edit-entry="${key}|${e.id}" title="Edit">${editSvg}</button></span></td>
    </tr>`;
  }
  if (e.type === 'payback') {
    return `<tr>
      ${dateCell}
      <td class="type-cell"><span class="tag payback">Payback</span></td>
      <td class="desc-cell">
        <strong>${escapeHtml(e.description)}</strong>${e.tag ? ` <span class="src-badge">${escapeHtml(e.tag)}</span>` : ''}
        <div class="subnote">Settlement of lent amount</div>
      </td>
      <td class="num amt-credit">+${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-edit-entry="${key}|${e.id}" title="Edit">${editSvg}</button></span></td>
    </tr>`;
  }
  if (e.type === 'owed') {
    return `<tr>
      ${dateCell}
      <td class="type-cell"><span class="tag owed">Owed to you</span></td>
      <td class="desc-cell">
        <strong>${escapeHtml(e.description)}</strong>${metaHtml}
        ${e.settled ? `<div class="subnote">Settled</div>` : `<div class="subnote">Carries forward until settled</div>`}
      </td>
      <td class="num" style="color:var(--amber)">${fmtINR(e.amount)}</td>
      <td class="actions-cell">
        <span class="row-actions">
          ${!e.settled ? `<button class="icon-btn" data-settle-owed="${key}|${e.id}" title="Mark as paid back">✓</button>` : ''}
          <button class="icon-btn" data-edit-entry="${key}|${e.id}" title="Edit">${editSvg}</button>
        </span>
      </td>
    </tr>`;
  }
  if (e.type === 'investment') {
    const catConfig = {
      'fixed deposit': { label: 'FD', cls: 'fd' },
      'lump-sum mf': { label: 'FUND', cls: 'mf' },
      'bond': { label: 'BOND', cls: 'bond' },
      'stock': { label: 'STOCK', cls: 'stock' }
    };
    const cat = catConfig[(e.category || '').toLowerCase()] || { label: 'FD', cls: 'fd' };
    return `<tr>
      ${dateCell}
      <td class="type-cell"><span class="tag invest">Investment</span></td>
      <td class="desc-cell"><strong>${escapeHtml(e.description)}</strong> <span class="src-badge ${cat.cls}">${cat.label}</span></td>
      <td class="num amt-debit">-${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-edit-entry="${key}|${e.id}" title="Edit">${editSvg}</button></span></td>
    </tr>`;
  }
  if (e.type === 'sip') {
    const catConfig = {
      'mutual fund': { label: 'MF', cls: 'mf' },
      'etf': { label: 'ETF', cls: 'etf' },
      'stock': { label: 'STOCK', cls: 'stock' }
    };
    const cat = catConfig[(e.category || '').toLowerCase()] || { label: 'MF', cls: 'mf' };
    return `<tr>
      ${dateCell}
      <td class="type-cell"><span class="tag invest">INVESTMENT</span></td>
      <td class="desc-cell">
        <strong>${escapeHtml(e.description)}</strong> <span class="src-badge ${cat.cls}">${cat.label}</span>
        <div class="subnote">Auto-deducted SIP</div>
      </td>
      <td class="num amt-debit">-${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-skip-sip="${key}|${e.seriesId}" title="Skip this month">✕</button></span></td>
    </tr>`;
  }
  if (e.type === 'recurring') {
    let modeText = 'Bank Transfer';
    let subnote = 'Auto-deducted recurring expense';
    if (e.paymentMode === 'card') {
      const card = cardById(cards, e.cardId);
      modeText = card ? card.name : 'Credit Card';
      subnote = `Auto-deducted on ${escapeHtml(modeText)} — adds to card dues`;
    }
    return `<tr>
      ${dateCell}
      <td class="type-cell"><span class="tag" style="background: #FCE8E6; color: #B0556F;">RECURRING</span></td>
      <td class="desc-cell">
        <strong>${escapeHtml(e.description)}</strong>
        <div class="subnote">${subnote}</div>
      </td>
      <td class="num amt-debit">-${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-skip-recurring="${key}|${e.seriesId}" title="Skip this month">✕</button></span></td>
    </tr>`;
  }
  if (e.type === 'emi') {
    return `<tr>
      ${dateCell}
      <td class="type-cell"><span class="tag emi">EMI</span></td>
      <td class="desc-cell">
        <strong>${escapeHtml(e.description)}</strong>${e.tag && e.tag !== 'EMI' ? ` <span class="src-badge">${escapeHtml(e.tag)}</span>` : ''}
        <div class="subnote">Instalment ${e.installment}/${e.totalMonths}</div>
      </td>
      <td class="num amt-debit">-${fmtINR(e.amount)}</td>
      <td class="actions-cell"></td>
    </tr>`;
  }
  return '';
}

async function resolveSubCategoryFromForm(tag) {
    if (!tag) return null;
    const subcatSelWrap = $('#f-subcat-select-wrap');
    if (subcatSelWrap && subcatSelWrap.style.display !== 'none') {
       let sVal = $('#f-subcat-select').value;
       if (sVal === '__custom__') sVal = $('#f-subcat-custom').value.trim();
       if (sVal) {
          const catIdx = budgetData.findIndex(c => c.name.toLowerCase() === tag.toLowerCase());
          if (catIdx > -1) {
            const cat = budgetData[catIdx];
            cat.subcategories = cat.subcategories || [];
            if (!cat.subcategories.some(s => s.name.toLowerCase() === sVal.toLowerCase())) {
              cat.subcategories.push({ id: uid(), name: sVal, budget: 0 });
              await Store.set(`budget-data:${monthKey}`, budgetData);
            }
          } else {
             budgetData.push({
               id: uid(), name: tag, budget: 0, expanded: true,
               subcategories: [{ id: uid(), name: sVal, budget: 0 }]
             });
             await Store.set(`budget-data:${monthKey}`, budgetData);
          }
          return sVal;
       }
    }
    return null;
}

function renderTagField() {
  const tags = allSpendTags(DEFAULT_TAGS, customTags);
  const options = tags.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  return `
  <div class="field" id="f-tag-wrap">
    <label>Tag</label>
    <select id="f-tag">
      <option value="">No tag</option>
      ${options}
      <option value="__custom__">+ Add custom tag</option>
    </select>
  </div>
  <div class="field" id="f-tag-custom-wrap" style="display:none;">
    <label>New tag name</label>
    <input id="f-tag-custom" type="text" placeholder="e.g. Pets" />
  </div>
  <div class="field" id="f-subcat-select-wrap" style="display:none;">
    <label>Subcategory</label>
    <div style="display:flex; gap:8px;">
      <select id="f-subcat-select" style="flex:1;">
        <option value="" disabled selected>Select...</option>
      </select>
      <input id="f-subcat-custom" type="text" placeholder="Name" style="display:none; flex:1;" />
    </div>
  </div>`;
}

function renderInlineEdit(entry, mk) {
  const isIncome = entry.type === 'income';
  const isInvest = entry.type === 'investment';

  let tagOpts = '';
  let showCustomTag = true;
  let showSubcat = true;

  if (isIncome) {
    const currentCat = (entry.category || entry.tag || '').toLowerCase();
    const incomeCats = ['Salary', 'Investments', 'Friends'];
    tagOpts = `<option value="">No category</option>` + incomeCats.map(c => `<option value="${c}" ${currentCat === c.toLowerCase() ? 'selected' : ''}>${c}</option>`).join('');
    showCustomTag = false;
    showSubcat = false;
  } else if (isInvest) {
    const currentCat = (entry.category || entry.tag || '').toLowerCase();
    const investCats = ['Fixed Deposit', 'Bond', 'Lump-sum MF', 'Stock'];
    tagOpts = investCats.map(c => `<option value="${c}" ${currentCat === c.toLowerCase() ? 'selected' : ''}>${c}</option>`).join('');
    showCustomTag = false;
    showSubcat = false;
  } else {
    const allTags = allSpendTags(DEFAULT_TAGS, customTags);
    tagOpts = `<option value="">No tag</option>` + allTags.map(t => `<option value="${escapeHtml(t)}" ${(entry.tag || '').toLowerCase() === t.toLowerCase() ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('') + `<option value="__custom__">+ Add custom</option>`;
  }

  const nameSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><defs><mask id="pin-hole"><rect width="24" height="24" fill="white"/><circle cx="12" cy="8.5" r="3" fill="black"/></mask></defs><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" mask="url(#pin-hole)"/><rect x="5" y="21" width="14" height="2"/></svg>`;
  const amtSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><defs><mask id="cash-hole"><rect width="24" height="24" fill="white"/><circle cx="12" cy="12" r="3" fill="black"/></mask></defs><rect x="2" y="6" width="20" height="12" rx="2" mask="url(#cash-hole)"/></svg>`;
  const tagSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><defs><mask id="tag-hole"><rect width="24" height="24" fill="white"/><rect x="6" y="7" width="12" height="2" fill="black"/><rect x="6" y="11" width="12" height="2" fill="black"/><rect x="6" y="15" width="12" height="2" fill="black"/></mask></defs><rect x="3" y="3" width="18" height="18" rx="2" mask="url(#tag-hole)"/></svg>`;
  const subcatSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><defs><mask id="subtag-hole"><rect width="24" height="24" fill="white"/><rect x="6" y="7" width="12" height="2" fill="black"/><rect x="10" y="11" width="8" height="2" fill="black"/><rect x="10" y="15" width="8" height="2" fill="black"/></mask></defs><rect x="3" y="3" width="18" height="18" rx="2" mask="url(#subtag-hole)"/></svg>`;
  const meta1Svg = `<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="10" fill="currentColor"/><text x="12" y="16.5" font-size="12" font-family="sans-serif" font-weight="bold" fill="var(--paper)" text-anchor="middle">1</text></svg>`;
  const meta2Svg = `<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="10" fill="currentColor"/><text x="12" y="16.5" font-size="12" font-family="sans-serif" font-weight="bold" fill="var(--paper)" text-anchor="middle">2</text></svg>`;

  let subcatHtml = '';
  if (showSubcat) {
    subcatHtml = `<button class="pill-btn sub-pill ie-add-subcat-btn" type="button" ${!entry.tag ? 'disabled' : ''} style="border: 1px dashed var(--sky); padding: 5px 12px; font-size: 0.72rem; background: transparent; color: var(--muted); cursor: pointer; text-transform: uppercase; ${!entry.tag ? 'opacity: 0.5; cursor: not-allowed;' : ''} margin-top: 2px;">+ Add Subcategory</button>`;
    
    if (entry.subCategory && entry.tag) {
      const cat = budgetData.find(c => c.name.toLowerCase() === entry.tag.toLowerCase());
      const subs = cat && cat.subcategories ? cat.subcategories.map(s => s.name) : [];
      if (!subs.some(s => s.toLowerCase() === entry.subCategory.toLowerCase())) subs.push(entry.subCategory);
      
      const subOpts = subs.map(s => `<option value="${escapeHtml(s)}" ${s.toLowerCase() === entry.subCategory.toLowerCase() ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('');
      
      subcatHtml = `
        <div class="ie-input-group" style="flex:1; min-width:140px;">
          ${subcatSvg}
          <select class="ie-subcat-select field-input">
            <option value="" disabled>Subcategory...</option>
            ${subOpts}
            <option value="__custom__">+ Add custom</option>
          </select>
          <input type="text" class="ie-subcat-custom field-input" style="display:none;" placeholder="Name">
        </div>
      `;
    }
  }

  let metaHtml = '';
  const tLow = (entry.tag || '').toLowerCase();
  if (tLow === 'transport') {
    metaHtml = `
      <div class="ie-input-group" style="flex:1; min-width:120px;">${meta1Svg}<input type="text" class="ie-meta-1 field-input" placeholder="Source" value="${escapeHtml(entry.meta?.source || '')}"></div>
      <div class="ie-input-group" style="flex:1; min-width:120px;">${meta2Svg}<input type="text" class="ie-meta-2 field-input" placeholder="Destination" value="${escapeHtml(entry.meta?.destination || '')}"></div>`;
  } else if (tLow === 'groceries') {
    metaHtml = `<div class="ie-input-group" style="flex:1; min-width:120px;">${meta1Svg}<input type="text" class="ie-meta-1 field-input" placeholder="Quantity" value="${escapeHtml(entry.meta?.quantity || '')}"></div>`;
  } else if (tLow === 'fuel') {
    metaHtml = `
      <div class="ie-input-group" style="flex:1; min-width:120px;">${meta1Svg}<input type="text" class="ie-meta-1 field-input" placeholder="Quantity" value="${escapeHtml(entry.meta?.quantity || '')}"></div>
      <div class="ie-input-group" style="flex:1; min-width:120px;">${meta2Svg}<input type="text" class="ie-meta-2 field-input" placeholder="Location" value="${escapeHtml(entry.meta?.location || '')}"></div>`;
  } else if (tLow === 'rent') {
    metaHtml = `<div class="ie-input-group" style="flex:1; min-width:120px;">${meta2Svg}<input type="text" class="ie-meta-1 field-input" placeholder="Location" value="${escapeHtml(entry.meta?.location || '')}"></div>`;
  }

  const delSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:2px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
  const saveSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>`;

  let dateContent = '—';
  if (entry.date) {
    const dt = new Date(entry.date + 'T00:00:00');
    const day = dt.toLocaleDateString('en-IN', { day: '2-digit' });
    const month = dt.toLocaleDateString('en-IN', { month: 'short' });
    const weekday = dt.toLocaleDateString('en-IN', { weekday: 'short' });
    dateContent = `
      <div style="display: flex; flex-direction: column; line-height: 1.2;">
        <div style="white-space: nowrap;">
          <strong style="font-size: 1.1rem; font-weight: 600; color: var(--navy);">${day} ${month}</strong>
        </div>
        <div style="color: var(--muted); font-size: 0.8rem; margin-top: 2px;">${weekday}</div>
      </div>
    `;
  }

  let typePill = '';
  if (entry.type === 'spend' && entry.amount < 0) {
      typePill = `<span class="tag payback">Payback</span>`;
  } else if (entry.type === 'spend') {
      typePill = `<span class="tag spend">Spend</span>`;
  } else if (entry.type === 'cardcharge') {
      typePill = `<span class="tag cardcharge">Card spend</span>`;
  } else if (entry.type === 'cashpayment') {
      typePill = `<span class="tag cashpayment">Cash spend</span>`;
  } else if (entry.type === 'income') {
      typePill = `<span class="tag income">Income</span>`;
  } else if (entry.type === 'payback') {
      typePill = `<span class="tag payback">Payback</span>`;
  } else if (entry.type === 'owed') {
      typePill = `<span class="tag owed">Owed to you</span>`;
  } else if (entry.type === 'investment' || entry.type === 'sip') {
      typePill = `<span class="tag invest">Investment</span>`;
  } else if (entry.type === 'recurring') {
      typePill = `<span class="tag" style="background: #FCE8E6; color: #B0556F;">RECURRING</span>`;
  } else if (entry.type === 'emi') {
      typePill = `<span class="tag emi">EMI</span>`;
  }

  const hasLent = Array.isArray(entry.lent) && entry.lent.length > 0;
  const lentTypeHtml = hasLent ? `<span class="tag owed">LENT</span>` : '';

  let dispClass = 'amt-debit';
  let dispSign = '-';
  let dispStyle = 'font-size: 1.05rem; font-weight: 600; margin-left: 8px;';
  const rawAmt = Number(entry.amount) || 0;
  let displayAmount = Math.abs(rawAmt);

  if (entry.type === 'income' || entry.type === 'payback' || (entry.type === 'spend' && rawAmt < 0)) {
      dispClass = 'amt-credit';
      dispSign = '+';
  } else if (entry.type === 'cardcharge' || entry.type === 'cashpayment') {
      dispClass = 'amt-neutral';
      dispSign = '';
  } else if (entry.type === 'owed') {
      dispClass = '';
      dispSign = '';
      dispStyle += ' color: var(--amber);';
  } else {
      dispClass = 'amt-debit';
      dispSign = '-';
  }

  return `
  <div class="inline-edit-container" data-entry-id="${entry.id}" data-entry-type="${entry.type}">
    <div style="display: flex; gap: 16px; align-items: stretch;">
      <div style="width: 120px; flex-shrink: 0; display: flex; flex-direction: column; gap: 10px; padding-right: 16px; border-right: 1px dashed var(--sky);">
        <div style="display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-start; justify-content: center;">
          ${typePill}
          ${lentTypeHtml}
        </div>
      </div>
      <div style="flex: 1; display: flex; flex-direction: column; gap: 10px; min-width: 0; padding-left: 4px;">
        <div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: center;">
          <div class="ie-input-group" style="flex:1; min-width: 150px;">
            ${nameSvg}
            <input type="text" class="ie-desc field-input" value="${escapeHtml(entry.description)}" placeholder="Name">
          </div>
          <div style="display: flex; flex-wrap: nowrap; align-items: center;">
            <div class="ie-input-group" style="width:140px;">
              ${amtSvg}
              <input type="number" class="ie-amount field-input" value="${entry.amount}" placeholder="Amount">
            </div>
            <div class="num ${dispClass}" style="${dispStyle}">
              ${dispSign}${fmtINR(displayAmount)}
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
          <div class="ie-input-group" style="width:160px; flex-shrink: 0;">
            ${tagSvg}
            <select class="ie-tag field-input">
              ${tagOpts}
            </select>
            ${showCustomTag ? `<input type="text" class="ie-tag-custom field-input" style="display:none;" placeholder="New Tag">` : ''}
          </div>
          ${showSubcat ? `
          <div class="ie-subcat-zone" style="display:flex; gap:8px; align-items:center; flex:1;">
            ${subcatHtml}
          </div>` : ''}
        </div>

        <div class="ie-meta-zone" style="display: ${metaHtml ? 'flex' : 'none'}; gap:10px; flex-wrap: wrap;">
          ${metaHtml}
        </div>

        <div style="display: flex; justify-content: space-between; gap: 10px; align-items: center; margin-top: 4px; flex-wrap: wrap;">
          <div style="display: flex; align-items: center; gap: 10px;">
             <!-- mode or chips if needed -->
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 10px; align-items: center;">
            <button class="btn ghost small" style="padding: 4px 16px; font-size: 0.75rem;" data-cancel-edit type="button">Cancel</button>
            <button class="btn primary small" style="padding: 4px 16px; font-size: 0.75rem; gap: 0px;" data-save-entry="${mk}|${entry.id}" type="button" style="display:flex; align-items:center;">
              ${saveSvg} Save
            </button>
            <button class="btn danger small" style="padding: 4px 8px; font-size: 0.75rem; gap: 0px;" data-del-entry="${mk}|${entry.id}" type="button" style="display:flex; align-items:center;">
              ${delSvg} Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function renderForm(kind) {
  if (!kind) return '';
  const cardOptions = cards.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if (kind === 'spend') {
    return `
    <div class="form-panel">
      <div class="pill-grid" style="margin-bottom: 12px;" id="f-spend-mode-selector">
        <button class="pill-btn sub-pill active" data-spend-mode="regular" type="button">Regular</button>
        <button class="pill-btn sub-pill" data-spend-mode="atm" type="button">Cash Withdrawal</button>
        <button class="pill-btn sub-pill" data-spend-mode="card" type="button" ${cards.length ? '' : 'disabled'}>Credit Card Due Payment</button>
      </div>
      <div class="form-note" id="f-mode-info" style="margin-top:0; margin-bottom:14px;">Add regular spends with tag for instant transfer modes like UPI.</div>

      <div class="form-row">
        <div class="field" id="f-desc-wrap"><label>Spend</label><input id="f-desc" type="text" placeholder="e.g. Groceries" /></div>
        <div class="field"><label>Amount (₹)</label><input id="f-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div class="field"><label>Date</label><input id="f-date" type="date" value="${todayStr()}" /></div>
      </div>
      <div class="form-row" style="align-items: flex-end;">
        <div class="field" id="f-card-wrap" style="display:none;">
          <label>Card being paid off</label>
          <select id="f-card">${cardOptions || '<option value="">No cards added</option>'}</select>
        </div>
        ${renderTagField()}
      </div>
      <div class="form-row" id="spend-dynamic-fields" style="display:none; margin-top: 14px;"></div>
      <div id="f-price-track-wrap" style="margin-bottom: 14px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <button class="pill-btn sub-pill" id="f-price-track-btn" type="button">+ Add to Price Tracker</button>
        <button class="pill-btn sub-pill dashed-subcat-btn" id="f-add-subcat-btn" type="button" disabled>+ Add Subcategory</button>
      </div>
      <label class="checkline" id="f-lent-container"><input type="checkbox" id="f-lent-toggle" /> Lent — someone owes me part of this</label>
      <div id="f-lent-wrap" style="display:none;">
        <div class="lent-rows" id="lent-rows">
          <div class="lent-row">
            <div class="field"><label>Person</label><input class="lent-person" type="text" placeholder="Name" /></div>
            <div class="field"><label>Amount (₹)</label><input class="lent-amount" type="number" step="0.01" placeholder="0.00" /></div>
            <button class="btn small ghost" data-add-lent-row type="button">+ Person</button>
          </div>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn" data-submit="spend">Add spend</button>
        <button class="btn ghost" data-close-form>Cancel</button>
      </div>
    </div>`;
  }
  if (kind === 'cardcharge') {
    return `
    <div class="form-panel">
      <div class="form-note invest-form" style="margin-top:0;">
        <span>Money spent on credit — adds to that card's dues. Doesn't touch your cash balance until you pay it off via a "Spend" entry with mode "Credit card".</span>
        <a class="pill-btn sub-pill active hyperlink" href="/subscriptions">Manage Credit Cards</a>
      </div>
      <div class="form-row">
        <div class="field"><label>Spend</label><input id="f-desc" type="text" placeholder="e.g. Dinner out" /></div>
        <div class="field"><label>Amount (₹)</label><input id="f-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div class="field"><label>Date</label><input id="f-date" type="date" value="${todayStr()}" /></div>
      </div>
      <div class="form-row" style="align-items: flex-end;">
        <div class="field">
          <label>Card</label>
          <select id="f-card">${cardOptions || '<option value="">No cards added — add one first</option>'}</select>
        </div>
        ${renderTagField()}
      </div>
      <div id="f-price-track-wrap" style="margin-bottom: 14px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <button class="pill-btn sub-pill" id="f-price-track-btn" type="button">+ Add to Price Tracker</button>
        <button class="pill-btn sub-pill dashed-subcat-btn" id="f-add-subcat-btn" type="button" disabled>+ Add Subcategory</button>
      </div>
      <label class="checkline"><input type="checkbox" id="f-lent-toggle" /> Lent — someone owes me part of this</label>
      <div id="f-lent-wrap" style="display:none;">
        <div class="lent-rows" id="lent-rows">
          <div class="lent-row">
            <div class="field"><label>Person</label><input class="lent-person" type="text" placeholder="Name" /></div>
            <div class="field"><label>Amount (₹)</label><input class="lent-amount" type="number" step="0.01" placeholder="0.00" /></div>
            <button class="btn small ghost" data-add-lent-row type="button">+ Person</button>
          </div>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn" data-submit="cardcharge" ${cards.length ? '' : 'disabled'}>Add card spend</button>
      </div>
    </div>`;
  }
  if (kind === 'cashpayment') {
    return `
    <div class="form-panel">
      <div class="form-note" style="margin-top:0;margin-bottom:14px;">Money spent from previously withdrawn physical cash. Doesn't deduct from your bank balance since the withdrawal was already logged.</div>
      <div class="form-row">
        <div class="field"><label>Spend</label><input id="f-desc" type="text" placeholder="e.g. Street food" /></div>
        <div class="field"><label>Amount (₹)</label><input id="f-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div class="field"><label>Date</label><input id="f-date" type="date" value="${todayStr()}" /></div>
      </div>
      <div class="form-row" style="align-items: flex-end;">
        ${renderTagField()}
      </div>
      <div id="f-price-track-wrap" style="margin-bottom: 14px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <button class="pill-btn sub-pill" id="f-price-track-btn" type="button">+ Add to Price Tracker</button>
        <button class="pill-btn sub-pill dashed-subcat-btn" id="f-add-subcat-btn" type="button" disabled>+ Add Subcategory</button>
      </div>
      <label class="checkline"><input type="checkbox" id="f-lent-toggle" /> Lent — someone owes me part of this</label>
      <div id="f-lent-wrap" style="display:none;">
        <div class="lent-rows" id="lent-rows">
          <div class="lent-row">
            <div class="field"><label>Person</label><input class="lent-person" type="text" placeholder="Name" /></div>
            <div class="field"><label>Amount (₹)</label><input class="lent-amount" type="number" step="0.01" placeholder="0.00" /></div>
            <button class="btn small ghost" data-add-lent-row type="button">+ Person</button>
          </div>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn" data-submit="cashpayment">Add cash payment</button>
        <button class="btn ghost" data-close-form>Cancel</button>
      </div>
    </div>`;
  }
  if (kind === 'recurring') {
    return `
    <div class="form-panel">
      <div class="form-note invest-form" style="margin-top:0;">
        <span>Auto-deducted every month on the date you choose. If a month doesn't have that many days, it deducts on the last valid day instead.</span>
        <a class="pill-btn sub-pill active hyperlink" href="/subscriptions">Manage Subscriptions</a>
      </div>
      <div class="pill-grid" style="margin-bottom: 12px;" id="f-recurring-mode-selector">
        <button class="pill-btn sub-pill active" data-recurring-mode="bank" type="button">Bank Transfer</button>
        <button class="pill-btn sub-pill" data-recurring-mode="card" type="button" ${cards.length ? '' : 'disabled'}>Credit Card</button>
      </div>
      <div class="form-row">
        <div class="field"><label>Details</label><input id="f-desc" type="text" placeholder="e.g. Netflix" /></div>
        <div class="field"><label>Amount (₹)</label><input id="f-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div class="field"><label>Date of deduction</label><input id="f-recurring-day" type="number" step="1" min="1" max="31" placeholder="e.g. 5" /></div>
      </div>
      <div class="form-row" id="f-recurring-card-row" style="display:none;">
        <div class="field">
          <label>Card</label>
          <select id="f-recurring-card">${cardOptions || '<option value="">No cards added</option>'}</select>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn" data-submit="recurring">Add recurring expense</button>
        <button class="btn ghost" data-close-form>Cancel</button>
      </div>
    </div>`;
  }
  if (kind === 'income') {
    return `
    <div class="form-panel">
      <div class="form-note">Log amounts credited to your account from various sources.</div>
      <div class="form-row">
        <div class="field"><label>Source</label><input id="f-desc" type="text" placeholder="e.g. Salary" /></div>
        <div class="field"><label>Amount (₹)</label><input id="f-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div class="field"><label>Date</label><input id="f-date" type="date" value="${todayStr()}" /></div>
      </div>
      <div class="form-row">
        <div class="field">
          <label>Category</label>
          <select id="f-income-category">
            <option value="">No category</option>
            <option value="Salary">Salary</option>
            <option value="Investments">Investments</option>
            <option value="Friends">Friends</option>
          </select>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn" data-submit="income">Add income</button>
        <button class="btn ghost" data-close-form>Cancel</button>
      </div>
    </div>`;
  }
  if (kind === 'owed') {
    return `
    <div class="form-panel">
      <div class="form-note">Carries forward automatically in your totals every month until you mark it settled.</div>
      <div class="form-row">
        <div class="field"><label>Person</label><input id="f-desc" type="text" placeholder="Who owes you" /></div>
        <div class="field"><label>Amount (₹)</label><input id="f-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div class="field"><label>Date</label><input id="f-date" type="date" value="${todayStr()}" /></div>
      </div>
      <div class="form-row">
        <div class="field"><label>Purpose</label><input id="f-owed-purpose" type="text" placeholder="e.g. Dinner split, movie tickets" /></div>
      </div>
      <div class="form-actions">
        <button class="btn" data-submit="owed">Add</button>
        <button class="btn ghost" data-close-form>Cancel</button>
      </div>
    </div>`;
  }
  if (kind === 'emi') {
    return `
    <div class="form-panel">
      <div class="form-note">Select when the EMI started. It auto-carries forward each month until the specified duration is reached.</div>
      <div class="form-row">
        <div class="field"><label>Description</label><input id="f-desc" type="text" placeholder="e.g. Laptop EMI" /></div>
        <div class="field"><label>Monthly deductible (₹)</label><input id="f-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div class="field"><label>Number of months</label><input id="f-months" type="number" step="1" min="1" placeholder="e.g. 12" /></div>
        <div class="field"><label>Starting Month</label><input id="f-emi-start" type="month" max="${currentMonthKey()}" value="${monthKey}" /></div>
      </div>
      <div class="form-row">
        <div class="field"><label>Date of deduction</label><input id="f-emi-day" type="number" step="1" min="1" max="31" placeholder="e.g. 5" /></div>
        <div id="f-tag-row" style="display:contents;">
          ${renderTagField()}
        </div>
      </div>
      <div class="form-actions">
        <button class="btn" data-submit="emi">Add EMI</button>
        <button class="btn ghost" data-close-form>Cancel</button>
      </div>
    </div>`;
  }
  if (kind === 'invest') {
    return `
    <div class="form-panel">
      <div class="form-note invest-form" style="margin-top:0;">
        <span>Any spend added here is a one-time investment. For recurring investments, add SIP.</span>
        <a class="pill-btn sub-pill active hyperlink" href="/sips">Add SIP</a>
      </div>
      <div class="form-row">
        <div class="field"><label>Description</label><input id="f-desc" type="text" placeholder="e.g. Fixed Deposit" /></div>
        <div class="field"><label>Amount (₹)</label><input id="f-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div class="field"><label>Date</label><input id="f-date" type="date" value="${todayStr()}" /></div>
      </div>
      <div class="form-row">
        <div class="field">
          <label>Category</label>
          <select id="f-invest-category">
            <option value="Fixed Deposit">Fixed Deposit</option>
            <option value="Bond">Bond</option>
            <option value="Lump-sum MF">Lump-sum MF</option>
            <option value="Stock">Stock</option>
          </select>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn" data-submit="invest">Add investment</button>
        <button class="btn ghost" data-close-form>Cancel</button>
      </div>
    </div>`;
  }
  return '';
}


const TXN_TYPES = {
  spend:       { 
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line><path d="M16 10a4 4 0 0 1-8 0"></path></svg>`, 
    title: 'Spend', desc: 'Everyday expenses', tone: 'blue' 
  },
  income:      { 
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"></path><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"></path><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"></path></svg>`, 
    title: 'Income', desc: 'Salary, interest, etc.', tone: 'green' 
  },
  cardcharge:  { 
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"></rect><line x1="1" y1="10" x2="23" y2="10"></line></svg>`, 
    title: 'Card spend', desc: 'Online or offline', tone: 'amber' 
  },
  cashpayment: { 
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"></rect><circle cx="12" cy="12" r="2"></circle><path d="M6 12h.01M18 12h.01"></path></svg>`, 
    title: 'Cash payment', desc: 'Paid via cash', tone: 'green' 
  },
  recurring:   { 
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><polyline points="23 20 23 14 17 14"></polyline><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path></svg>`, 
    title: 'Recurring', desc: 'Subscriptions, bills', tone: 'amber' 
  },
  invest:      { 
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline><polyline points="17 6 23 6 23 12"></polyline></svg>`, 
    title: 'Investment', desc: 'Investments, SIPs', tone: 'amber' 
  },
  owed:        { 
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`, 
    title: 'Owed to you', desc: 'Someone owes you', tone: 'purple' 
  },
  emi:         { 
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 22 7 12 2"></polygon><line x1="2" y1="22" x2="22" y2="22"></line><line x1="6" y1="18" x2="6" y2="11"></line><line x1="10" y1="18" x2="10" y2="11"></line><line x1="14" y1="18" x2="14" y2="11"></line><line x1="18" y1="18" x2="18" y2="11"></line></svg>`, 
    title: 'EMI', desc: 'Monthly deductable', tone: 'rose' 
  },
};

function renderTxnOptionCard(kind) {
  const meta = TXN_TYPES[kind];
  return `
    <button class="txn-option-card ${openForm === kind ? 'active' : ''}" data-form="${kind}" type="button">
      <span class="txn-option-icon txn-option-icon--${meta.tone}">${meta.icon}</span>
      <span class="txn-option-text">
        <span class="txn-option-title">${meta.title}</span>
        <span class="txn-option-desc">${meta.desc}</span>
      </span>
    </button>`;
}

function renderAddEntryPanel() {
  const svgs = {
    bolt: `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M13 10V3L4 14h7v8l9-11h-7z"/></svg>`,
    plus: `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
    income: `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"></path><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"></path><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"></path></svg>`,
    invest: `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline><polyline points="17 6 23 6 23 12"></polyline></svg>`,
    lent: `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,
    split: `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`
  };

  const expenseSubTypes = ['spend', 'cardcharge', 'cashpayment', 'recurring', 'emi'];
  const subOptionsHtml = expenseSubTypes.map(renderTxnOptionCard).join('');

  return `
  <div class="quick-actions-container">
    
    <div class="section-title" style="margin-bottom: 12px;">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="color: var(--blue); display: flex;">${svgs.bolt}</span>
        <h2 style="margin: 0;">Quick actions</h2>
      </div>
      <span class="hint">Get things done, faster</span>
    </div>

    <div class="qa-buttons-grid">
      <button class="qa-card ${expenseMenuOpen ? 'active' : ''}" data-qa-toggle="expense" type="button">
        <span class="qa-icon" style="background: var(--blue); color: #fff;">${svgs.plus}</span>
        <span class="qa-text">
          <span class="qa-title">Add expense</span>
          <span class="qa-desc">Track spending</span>
        </span>
      </button>
      <button class="qa-card ${openForm === 'income' ? 'active' : ''}" data-form="income" type="button">
        <span class="qa-icon" style="background: var(--credit-bg); color: var(--credit);">${svgs.income}</span>
        <span class="qa-text">
          <span class="qa-title">Log income</span>
          <span class="qa-desc">Salary & more</span>
        </span>
      </button>
      <button class="qa-card ${openForm === 'invest' ? 'active' : ''}" data-form="invest" type="button">
        <span class="qa-icon" style="background: var(--royal-bg); color: var(--royal);">${svgs.invest}</span>
        <span class="qa-text">
          <span class="qa-title">Log investment</span>
          <span class="qa-desc">Build wealth</span>
        </span>
      </button>
      <button class="qa-card ${openForm === 'owed' ? 'active' : ''}" data-form="owed" type="button">
        <span class="qa-icon" style="background: var(--amber-bg); color: var(--amber);">${svgs.lent}</span>
        <span class="qa-text">
          <span class="qa-title">Add lent</span>
          <span class="qa-desc">Owed to you</span>
        </span>
      </button>
      <a class="qa-card" href="/split">
        <span class="qa-icon" style="background: var(--ice); color: var(--blue);">${svgs.split}</span>
        <span class="qa-text">
          <span class="qa-title">Split bill</span>
          <span class="qa-desc">Group spends</span>
        </span>
      </a>
    </div>

    <div id="qa-sub-anim-inner" class="qa-sub-wrap ${expenseMenuOpen && !isExpenseMenuOpening ? 'expanded' : ''}">
      <div class="qa-sub-inner">
        <div class="qa-sub-menu">
          <div class="txn-option-grid">
            ${subOptionsHtml}
          </div>
        </div>
      </div>
    </div>

    <div id="form-panel-anim-inner" class="form-panel-wrap ${openForm && !isFormOpening ? 'expanded' : ''}">
      <div class="form-panel-inner">
        ${openForm ? renderForm(openForm) : ''}
      </div>
    </div>
  </div>`;
}


/* ---------- Main render ---------- */
async function renderMonth() {
  try {
    await loadDomain();
    
    // First-touch: mirrors the old openMonth()'s one-time carry/manual decision.
    await ensureMonthIndexed(monthKey, monthsIndex);
    const data = await loadMonth(monthKey);

    // Deep link from Budget -> Month
    let scrollToTransactions = false;
    const savedFilter = sessionStorage.getItem('budget-to-month-filter');
    if (savedFilter) {
      try {
        const { tag, monthKey: savedMonthKey } = JSON.parse(savedFilter);
        if (savedMonthKey === monthKey && !activeTagFilters.includes(tag)) {
          activeTagFilters.push(tag);
          scrollToTransactions = true;
        }
      } catch(e) {}
      sessionStorage.removeItem('budget-to-month-filter');
    }

    if (!data._touched) {
      const prevKey = addMonths(monthKey, -1);
      data.startingBalanceMode = monthsIndex.includes(prevKey) ? 'auto' : 'manual';
      data._touched = true;
      await saveMonth(monthKey);
    }

    const emiRows = emiRowsForMonth(emiSeries, monthKey, data.deletedEmi);
    const sipRows = sipRowsForMonth(sipSeries, monthKey, data.deletedSip);
    const recurringRows = recurringRowsForMonth(recurringSeries, monthKey, data.deletedRecurring);

    const emiRowsFiltered = emiRows.filter(r => r.date <= todayStr());
    const sipRowsFiltered = sipRows.filter(r => r.date <= todayStr());
    const recurringRowsFiltered = recurringRows.filter(r => r.date <= todayStr());

    const allRows = [...data.entries, ...sipRowsFiltered, ...recurringRowsFiltered, ...emiRowsFiltered].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const monthTotals = computeMonthTotals(data.entries.concat(emiRowsFiltered, sipRowsFiltered, recurringRowsFiltered));

    const stats = await computeGlobalStats({ cards, emiSeries, sipSeries, recurringSeries, monthsIndex, existingInvestments, isShared: false, sharedSplitId: null, splitsIndex });

    const monthInvestList = [];
    for (const e of data.entries) {
      if (e.type === 'investment') monthInvestList.push({ description: e.description, amount: Number(e.amount) || 0, monthKey: null });
    }
    for (const s of sipRowsFiltered) {
      monthInvestList.push({ description: s.description + ' (SIP)', amount: Number(s.amount) || 0, monthKey: null });
    }
    stats.invested = { total: monthTotals.invest + monthTotals.sip, list: monthInvestList, title: "This month's investments" };

    const breakdownByKey = Object.fromEntries(stats.breakdown.map(b => [b.monthKey, b]));
    const prevKey = addMonths(monthKey, -1);
    const hasPrev = monthsIndex.includes(prevKey) && !!breakdownByKey[prevKey];
    const prevEnding = hasPrev ? breakdownByKey[prevKey].ending : null;
    const mode = data.startingBalanceMode || 'manual';
    const displayedStarting = (mode === 'auto' && hasPrev) ? prevEnding : (Number(data.startingBalance) || 0);

    const typeOptions = [];
    const tagOptions = [];
    const seenTypeOptions = new Set();
    const seenTagOptions = new Set();

    for (const e of allRows) {
      const typeLabel = getTableTypeLabel(e);

      if (!seenTypeOptions.has(typeLabel)) {
        seenTypeOptions.add(typeLabel);
        typeOptions.push(typeLabel);
      }

      if (hasLentData(e) && !seenTypeOptions.has('Lent')) {
        seenTypeOptions.add('Lent');
        typeOptions.push('Lent');
      }

      const tagLabel = getTableTagLabel(e);

      if (!seenTagOptions.has(tagLabel)) {
        seenTagOptions.add(tagLabel);
        tagOptions.push(tagLabel);
      }
    }

    const filteredRows = allRows.filter(e => {
      const typeLabel = getTableTypeLabel(e);

      const typePass =
        activeTypeFilters.length === 0 ||
        activeTypeFilters.includes(typeLabel) ||
        (activeTypeFilters.includes('Lent') && hasLentData(e));

      const tagPass =
        activeTagFilters.length === 0 ||
        activeTagFilters.some(t => {
            const tl = t.toLowerCase();
            if (tl === 'sip' && e.type === 'sip') return true;
            if (tl === 'recurring' && e.type === 'recurring') return true;
            if (tl === 'emi' && e.type === 'emi') return true;
            return (getTableTagLabel(e).toLowerCase() === tl) || ((e.subCategory || '').toLowerCase() === tl);
        });

      return typePass && tagPass;
    });

    const sortedRows = filteredRows
      .map((e, index) => ({ e, index }))
      .sort((a, b) => {
        const cmp = compareTableRows(a.e, b.e, currentSort.key);

        if (cmp === 0) return a.index - b.index;

        return currentSort.asc ? cmp : -cmp;
      })
      .map(({ e }) => e);

    const dateStreakCounts = new Map();
    const firstDateRows = new Set();

    for (let i = 0; i < sortedRows.length;) {
      let j = i + 1;

      while (
        j < sortedRows.length &&
        sortedRows[j].date === sortedRows[i].date
      ) {
        j++;
      }

      dateStreakCounts.set(i, j - i);
      firstDateRows.add(i);

      i = j;
    }

    const rowsHtml = sortedRows.map((e, index) =>
      renderRow(
        e,
        monthKey,
        dateStreakCounts.get(index) || 1,
        firstDateRows.has(index)
      )
    ).join('');

    const neutralTableTypes = new Set(['cardcharge', 'cashpayment']);

    const tableNetTotal = sortedRows.reduce((total, e) => {
      if (!deductCcCash && neutralTableTypes.has(e.type)) return total;

      if (['spend', 'investment', 'sip', 'recurring', 'emi'].includes(e.type) || (deductCcCash && neutralTableTypes.has(e.type))) {
        return total - Math.abs(Number(e.amount) || 0);
      }

      if (['income', 'payback', 'owed'].includes(e.type)) {
        return total + Math.abs(Number(e.amount) || 0);
      }

      return total;
    }, 0);

    const tableSortOptions = [
      ['date', 'Date'],
      ['amount', 'Amount'],
      ['type', 'Type'],
      ['tag', 'Tag'],
    ]
      .map(([key, label]) =>
        `<option value="${key}" ${currentSort.key === key ? 'selected' : ''}>${label}</option>`
      )
      .join('');

    const tableTypeOptions = typeOptions
      .map(type =>
        `<option value="${escapeHtml(type)}" ${activeTypeFilters.includes(type) ? 'disabled' : ''}>${escapeHtml(type)}</option>`
      )
      .join('');

    const tableTagOptions = tagOptions
      .map(tag =>
        `<option value="${escapeHtml(tag)}" ${activeTagFilters.includes(tag) ? 'disabled' : ''}>${escapeHtml(tag)}</option>`
      )
      .join('');

    const activeTableFilterPills = [
      ...activeTypeFilters.map(type => ({
        category: 'type',
        name: type
      })),
      ...activeTagFilters.map(tag => ({
        category: 'tag',
        name: tag
      })),
    ]
      .map(({ category, name }) => `
        <div class="pill-btn sub-pill active chart-tag-pill">
          ${escapeHtml(name)}
          <button
            class="icon-btn chart-tag-remove"
            data-remove-table-filter="${category}|${escapeHtml(name)}"
            aria-label="Remove filter"
          >✕</button>
        </div>`
      )
      .join('');

    const tableColgroupHtml = `
      <colgroup>
        <col style="width: 110px;">
        <col style="width: 120px;">
        <col style="width: auto;">
        <col style="width: 155px;">
        <col style="width: 72px;">
      </colgroup>
    `;

  const tableHeaderHtml = `
    <div class="table-header-wrap">
      <table class="table-header-sticky">
        ${tableColgroupHtml}
        <thead>
          <tr>
            <th>Date</th>
            <th class="type-cell">Type</th>
            <th>Details</th>
            <th class="table-numeric">Amount</th>
            <th></th>
          </tr>
        </thead>
      </table>
    </div>
  `;

  const tableControlsHtml = `
    <div class="sticky-controls-wrap">
      <div
        class="table-controls"
        style="display: flex; flex-wrap: wrap; align-items: center; gap: 10px;"
      >
        <select id="table-type-filter" aria-label="Filter transactions by type">
          <option value="">All Types</option>
          ${tableTypeOptions}
        </select>

        <select id="table-tag-filter" aria-label="Filter transactions by tag">
          <option value="">All Tags</option>
          ${tableTagOptions}
        </select>

        <select id="table-sort-control" aria-label="Sort transactions">
          ${tableSortOptions}
        </select>

        <button
          id="table-sort-direction"
          class="btn small"
          type="button"
          aria-label="Toggle sort direction"
          style="min-height: 0px;"
        >
          ${currentSort.asc ? '↑' : '↓'}
          ${getTableSortDirectionLabel(currentSort.key, currentSort.asc)}
        </button>
      </div>

      ${
        activeTableFilterPills
          ? `<div class="pill-grid" style="margin-top: 10px; margin-bottom: 12px; padding: 0 14px;">${activeTableFilterPills}</div>`
          : ''
      }

      ${tableHeaderHtml}
    </div>`;

    const emiCardsHtml = emiRows.length ? `<div class="emi-list" style="margin-bottom: 20px;">` + emiRows.map(e => {
      const totalBill = e.amount * e.totalMonths;
      const totalPaid = e.amount * e.installment;
      const left = e.totalMonths - e.installment;
      const pct = totalBill > 0 ? Math.min(100, (totalPaid / totalBill) * 100) : 0;
      const dayNum = e.dayOfMonth || 1;
      return `
      <div class="emi-card">
        <div style="flex: 1; min-width: 0;">
          <h4><span class="tag emi">EMI</span> ${escapeHtml(e.description)}</h4>
          <div class="emi-stats" style="margin-bottom: 6px;">
            Paid ${fmtINR(totalPaid)} of ${fmtINR(totalBill)}
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <div style="flex: 1; height: 4px; background: var(--hair); border-radius: 2px; overflow: hidden; position: relative;">
              <div style="position: absolute; left: 0; top: 0; bottom: 0; width: ${pct}%; background: var(--blue); border-radius: 2px;"></div>
            </div>
            <span style="font-size: 0.72rem; color: var(--muted); font-family: 'IBM Plex Mono', monospace; white-space: nowrap;">${left} left</span>
          </div>
          <div class="emi-stats" style="margin-top: 8px; display: flex; align-items: center; gap: 4px;">
            Next deduction: ${dayNum}${ordinalSuffix(dayNum)}
            <button class="icon-btn" data-edit-emi-day="${e.seriesId}" title="Edit date" style="padding: 2px;"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg></button>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 16px; align-self: flex-start;">
          <div class="num amt-debit recurring-card">-${fmtINR(e.amount)}</div>
          <button class="icon-btn" data-popover-trigger data-del-emi-series="${e.seriesId}" title="Delete EMI series entirely">✕</button>
        </div>
      </div>`;
    }).join('') + `</div>` : '';

    let sipCardsHtml = '';
    let sipFilterHtml = '';

    if (sipRows.length) {
      let sortedSips = [...sipRows].sort((a, b) => (a.description || '').localeCompare(b.description || ''));

      const categories = ['All', 'Mutual Fund', 'ETF', 'Stock'];
      const displayNames = { 'All': 'All', 'Mutual Fund': 'Mutual Funds', 'ETF': 'ETFs', 'Stock': 'Stocks' };

      sipFilterHtml = `
      <div class="pill-grid sip-filter-grid">
        ${categories.map(cat => `
          <button class="pill-btn sub-pill ${currentSipFilter === cat ? 'active' : ''}" 
                  data-sip-filter="${cat}" type="button">
            ${displayNames[cat]}
          </button>
        `).join('')}
      </div>`;

      if (currentSipFilter !== 'All') {
        sortedSips = sortedSips.filter(s => (s.category || 'Mutual Fund') === currentSipFilter);
      }

      if (sortedSips.length) {
        const catConfig = {
          'mutual fund': { label: 'MF', cls: 'mf' },
          'etf': { label: 'ETF', cls: 'etf' },
          'stock': { label: 'STOCK', cls: 'stock' }
        };
        const cardsHtml = sortedSips.map(e => {
          const dayNum = new Date(e.date + 'T00:00:00').getDate();
          const cat = catConfig[(e.category || '').toLowerCase()] || { label: 'MF', cls: 'mf' };
          return `
          <div class="month-sip-card">
            <div class="month-sip-card-header">
              <div style="width: 100%;">
                <h4 style="margin-bottom: 0; font-weight: 600; color: var(--navy); font-family: 'Fraunces', serif; font-size: 1.05rem; display: flex; flex-direction: column; align-items: flex-start; gap: 6px;">
                  <span style="word-break: break-word;">${escapeHtml(e.description)}</span>
                  <span style="display: inline-flex; gap: 4px; align-items: center; flex-shrink: 0;">
                    <span class="src-badge ${cat.cls}">${cat.label}</span>
                    <span class="src-badge sip">SIP</span>
                  </span>
                </h4>
              </div>
            </div>
            <div class="emi-stats" style="font-size: 0.8rem; color: var(--muted); font-family: 'IBM Plex Mono', monospace; margin-top: auto; margin-bottom: 4px;">
              Next deduction: ${dayNum}${ordinalSuffix(dayNum)}
            </div>
            <div class="month-sip-card-footer" style="margin-top: 0;">
              <div class="num recurring-card" style="font-size: 1.15rem; font-weight: 600; color: var(--blue);">
                -${fmtINR(e.amount)}
              </div>
              <button class="icon-btn" data-popover-trigger data-skip-sip="${monthKey}|${e.seriesId}" title="Skip this month" style="background: var(--ice-2); border-radius: 8px; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; transition: all 0.2s ease;">
                ⤵
              </button>
            </div>
          </div>`;
        }).join('');

        sipCardsHtml = `<div class="month-sip-grid">${cardsHtml}</div>`;
      } else {
        sipCardsHtml = `<div class="empty-chart" style="margin-top: 20px;">No ${displayNames[currentSipFilter]} SIPs running this month.</div>`;
      }
    }

    const recurringCardsHtml = recurringRows.length ? `<div class="month-sip-grid">` + recurringRows.map(e => {
      const dayNum = new Date(e.date + 'T00:00:00').getDate();
      let modeText = 'Bank Transfer';
      let modeBadge = 'SPEND';
      let modeBadgeBg = 'var(--debit-bg)';
      let modeBadgeColor = 'var(--debit)';
      
      if (e.paymentMode === 'card') {
        const c = cards.find(card => card.id === e.cardId);
        modeText = c ? c.name : 'Credit Card';
        modeBadge = 'CARD SPEND';
        modeBadgeBg = '#FBF0E2';
        modeBadgeColor = '#C07A2E';
      }

      return `
      <div class="month-sip-card">
        <div class="month-sip-card-header">
          <div style="width: 100%;">
            <h4 style="margin-bottom: 0; font-weight: 600; color: var(--navy); font-family: 'Fraunces', serif; font-size: 1.05rem; display: flex; flex-direction: column; align-items: flex-start; gap: 6px;">
                  <span style="word-break: break-word;">${escapeHtml(e.description)}</span>
                  <span style="display: inline-flex; gap: 4px; align-items: center; flex-shrink: 0;">
                    <span class="src-badge" style="background: ${modeBadgeBg}; color: ${modeBadgeColor};">${modeBadge}</span>
                    <span class="src-badge" style="background: #FCE8E6; color: #B0556F;">RECURRING</span>
                  </span>
                </h4>
              </div>
            </div>
            <div class="emi-stats" style="font-size: 0.8rem; color: var(--muted); font-family: 'IBM Plex Mono', monospace; margin-top: auto; margin-bottom: 4px;">
              Next deduction: ${dayNum}${ordinalSuffix(dayNum)} via ${escapeHtml(modeText)}
            </div>
            <div class="month-sip-card-footer" style="margin-top: 0;">
          <div class="num recurring-card" style="font-size: 1.15rem; font-weight: 600; color: var(--blue);">
            -${fmtINR(e.amount)}
          </div>
          <button class="icon-btn" data-popover-trigger data-skip-recurring="${monthKey}|${e.seriesId}" title="Skip this month" style="background: var(--ice-2); border-radius: 8px; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; transition: all 0.2s ease;">
            ⤵
          </button>
        </div>
      </div>`;
    }).join('') + `</div>` : '';

    // Only debts genuinely incurred THIS month's own entries count towards
    // this month's Lent segment — split-page and historical-month debts are
    // never injected here. They live exclusively in the global "Owed to you"
    // total (stats.owed / computeGlobalOwed), so a past month's chart never
    // gets today's numbers grafted onto it, and the current month's chart
    // never gets debts that actually originated earlier.
    let unsettledConsumptionLent = 0, settledConsumptionLent = 0, settledCardLent = 0;
    for (const e of data.entries) {
      if (!Array.isArray(e.lent)) continue;
      if (e.type === 'spend' || e.type === 'cardcharge' || e.type === 'cashpayment') {
        unsettledConsumptionLent += e.lent.reduce((s, l) => !l.settled ? s + (Number(l.amount) || 0) : s, 0);
        // Settled lent has been paid back — deduct it entirely, it's no
        // longer part of this month's spend at all (personal or lent).
        settledConsumptionLent += e.lent.reduce((s, l) => l.settled ? s + (Number(l.amount) || 0) : s, 0);
      }
      if (e.type === 'cardcharge') {
        // Credit-card dues still need the full charge paid off via the card
        // bill, but a settled lent portion has already been reimbursed to
        // you — net it out of Personal Expense so it isn't double-counted
        // as an out-of-pocket cost in the Cashflow Overview.
        settledCardLent += e.lent.reduce((s, l) => l.settled ? s + (Number(l.amount) || 0) : s, 0);
      }
    }
    const emiTotal = monthTotals.emi || 0;
    // Personal spend = total consumption minus unsettled lent, settled
    // credit-card lent, and EMI.
    const rawPersonalExpense = Math.max(0, monthTotals.totalConsumption - unsettledConsumptionLent - settledCardLent - emiTotal);
    const personalExpense = rawPersonalExpense;
    const lentSegmentValue = unsettledConsumptionLent;

    // Requirement 2: Income Segments
    const incomeCategories = {};
    for (const e of data.entries) {
      if (e.type === 'income') {
        const cat = e.category || 'Uncategorized';
        incomeCategories[cat] = (incomeCategories[cat] || 0) + (Number(e.amount) || 0);
      }
    }
    const incomeColors = ['var(--credit)', 'var(--sky)', 'var(--blue-soft)', '#C98A3C', '#8E6FB0'];
    let colorIdx = 0;
    const incomeSegments = Object.entries(incomeCategories)
      .filter(([, val]) => val > 0)
      .map(([cat, val]) => ({ label: cat, value: val, color: incomeColors[colorIdx++ % incomeColors.length] }));

    // Requirement 3: Investment Segments
    const investBuckets = { 'MF': 0, 'ETF': 0, 'Stock': 0, 'Bond': 0, 'FD': 0 };
    for (const e of data.entries) {
      if (e.type === 'investment') {
        const amt = Number(e.amount) || 0;
        const cat = e.category || 'Fixed Deposit';
        if (cat === 'Lump-sum MF') investBuckets['MF'] += amt;
        else if (cat === 'Stock') investBuckets['Stock'] += amt;
        else if (cat === 'Bond') investBuckets['Bond'] += amt;
        else investBuckets['FD'] += amt;
      }
    }
    for (const s of sipRowsFiltered) {
      const amt = Number(s.amount) || 0;
      const cat = s.category || 'Mutual Fund';
      if (cat === 'Mutual Fund') investBuckets['MF'] += amt;
      else if (cat === 'ETF') investBuckets['ETF'] += amt;
      else if (cat === 'Stock') investBuckets['Stock'] += amt;
      else investBuckets['MF'] += amt;
    }
    const investColors = { 'MF': 'var(--blue)', 'ETF': 'var(--amber)', 'Stock': '#5B4B9E', 'Bond': '#2E7D6B', 'FD': '#C98A3C' };
    const investSegments = Object.entries(investBuckets)
      .filter(([, val]) => val > 0)
      .map(([cat, val]) => ({ label: cat, value: val, color: investColors[cat] }));

    const tb = document.getElementById('global-topbar');
    if (tb) tb.style.display = '';

    markRendered(root);
    root.innerHTML = `
    <div class="section">
      <div class="month-header">
        <h1>${monthKeyLabel(monthKey)}</h1>
        <h3 style="margin-bottom: 2px;">Starting balance: ${fmtINR(displayedStarting)}</h3>
      </div>
      <div class="balance-box">
        <div class="balance-set">
          <div class="balance-set-input">
            Set starting balance:
            <input type="number" step="0.01" id="starting-balance-manual" value="${Number(data.startingBalance) || 0}" ${mode === 'auto' ? 'disabled' : ''} style="opacity: ${mode === 'auto' ? '0.5' : '1'}; transition: opacity 0.2s ease;" />
          </div>
          <button class="pill-btn ${mode === 'manual' ? '' : 'active'}" id="toggle-manual-balance-btn" type="button">${mode === 'manual' ? 'Custom starting balance' : 'Carry from last month'}</button>
        </div>
      </div>
    </div>

    <div class="section">
      ${renderAddEntryPanel()}
    </div>
    <div class="section">
      <div class="section-title" style="margin-bottom: 12px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="color: var(--blue); display: flex;">
            <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 17 9 11 13 15 21 7"></polyline>
              <circle cx="3" cy="17" r="1.5" fill="currentColor"></circle>
              <circle cx="9" cy="11" r="1.5" fill="currentColor"></circle>
              <circle cx="13" cy="15" r="1.5" fill="currentColor"></circle>
              <circle cx="21" cy="7" r="1.5" fill="currentColor"></circle>
            </svg>
          </span>
          <h2 style="margin: 0;">This month's finances, at a glance</h2>
        </div>
        <span class="hint">Hover a card for the breakdown</span>
      </div>
      ${renderStatCards(stats)}
    </div>
    <div class="section">
      <div class="section-title" style="margin-bottom: 12px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="color: var(--blue); display: flex;">
            <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="16" width="4" height="6"></rect>
              <rect x="10" y="10" width="4" height="12"></rect>
              <rect x="18" y="4" width="4" height="18"></rect>
            </svg>
          </span>
          <h2 style="margin: 0;">This month's charts</h2>
        </div>
        <span class="hint">${monthKeyLabel(monthKey)} only</span>
      </div>
      <div class="charts-grid">
        <div class="chart-card" style="min-width: 0; overflow-x: auto;">
          <h4>Spending Breakdown</h4>
          ${donutChart([
            { label: 'Regular debit', value: monthTotals.regularDebit, color: 'var(--debit)' },
            { label: 'Credit card spends', value: monthTotals.ccSpends, color: '#8E6FB0' },
            { label: 'Cash payments', value: monthTotals.cashPayments, color: '#C98A3C' },
            { label: 'EMI', value: monthTotals.emi, color: '#5B4B9E' },
            { label: 'Recurring', value: monthTotals.recurring, color: '#B0556F' },
            { label: 'SIP', value: monthTotals.sip, color: '#2E8B77' },
            { label: 'Investment', value: monthTotals.invest, color: 'var(--blue)' },
          ])}
        </div>

        <div class="chart-card" style="min-width: 0; overflow-x: auto;">
          <h4>Cashflow Overview</h4>
          <p class="hint" style="margin: 4px 0 12px; font-size: 0.8rem;">Hover over a stack to check amount and subcategory</p>
          ${barChart([
            { label: 'Income', segments: incomeSegments.length ? incomeSegments : [{ label: 'Income', value: 0, color: 'var(--credit)' }] },
            {
              label: 'Expense',
              segments: [
                { label: 'Personal', value: personalExpense, color: 'var(--debit)' },
                { label: 'Lent (unsettled)', value: lentSegmentValue, color: '#E03131' },
              ],
            },
            ...(emiTotal > 0 ? [{ label: 'EMI', value: emiTotal, color: '#5B4B9E' }] : []),
            { label: 'Invested', segments: investSegments.length ? investSegments : [{ label: 'Invested', value: 0, color: 'var(--blue)' }] },
            ...(stats.owed.total > 0 ? [{ label: 'Owed', value: stats.owed.total, color: 'var(--amber)' }] : []),
          ])}
          ${lentSegmentValue > 0 ? `
          <div class="shared-chart-legend" style="border-top: none; padding-top: 0; margin-top: 0;">
            <div class="shared-chart-legend-item"><span class="shared-chart-legend-dot" style="background:var(--debit);"></span><span>Personal Expense</span></div>
            <div class="shared-chart-legend-item"><span class="shared-chart-legend-dot" style="background:#E03131;"></span><span>Lent (unsettled)</span></div>
          </div>` : ''}
        </div>
        <div class="chart-card" style="grid-column:1/-1;">
          <h4>Running balance through the month</h4>
          ${lineChart(displayedStarting, data, emiRowsFiltered.concat(sipRowsFiltered))}
        </div>
        <div style="grid-column: 1 / -1;">
          ${(() => {
            const subCategoryMap = {};
            for (const cat of budgetData) {
              for (const sub of (cat.subcategories || [])) {
                subCategoryMap[sub.name.toLowerCase()] = cat.name;
              }
            }
            const TAG_WIDE_THRESHOLD = 5;
            const tagCharts = [
              { title: 'Debit by tag', data: tagsBarChart(data.entries, 'spend', { subCategoryMap }) },
              { title: 'Credit card spends by tag', data: tagsBarChart(data.entries, 'cardcharge', { subCategoryMap }) },
              { title: 'Cash spends by tag', data: tagsBarChart(data.entries, 'cashpayment', { subCategoryMap }) },
            ];
            const cardsHtml = tagCharts.map(({ title, data: { html, count } }) => `
              <div class="chart-card tag-chart-card ${count > TAG_WIDE_THRESHOLD ? 'tag-chart-card--wide' : ''}">
                <h4>${title}</h4>
                ${html}
              </div>`).join('');
            return `<div class="tags-charts-row">${cardsHtml}</div>`;
          })()}
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title" style="margin-bottom: 12px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="color: var(--blue); display: flex;">
            <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 8h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4V8z"></path>
              <path d="M20 12h-5a2 2 0 0 0 0 4h5"></path>
              <rect x="14" y="13" width="2" height="2" fill="currentColor" stroke="none"></rect>
              <path d="M6 8L11 3l5 5"></path>
            </svg>
          </span>
          <h2 style="margin: 0;">Transactions</h2>
        </div>
        <span class="hint">
          ${
            activeTypeFilters.length || activeTagFilters.length
              ? `${filteredRows.length} of ${allRows.length} entries`
              : `${filteredRows.length} entries`
          }
        </span>
      </div>

      ${emiCardsHtml}

    <div class="transactions-container">
      ${tableControlsHtml}

      <div class="table-wrap">
        <table class="divisions-table table-body-sticky" ${filteredRows.length ? '' : 'style="width: 100%;"'}>
          ${tableColgroupHtml}
          <tbody>
            ${
              filteredRows.length
                ? rowsHtml
                : (
                    allRows.length
                      ? `<tr class="empty-row"><td colspan="5">No transactions match the selected filters.</td></tr>`
                      : `<tr class="empty-row"><td colspan="5">No entries yet — add your first spend or income above.</td></tr>`
                  )
            }

            ${
              filteredRows.length
                ? `
                  <tr class="table-total-row">
                    <td colspan="3">
                      <div style="font-family: 'Source Serif 4', Georgia, serif; font-size:1.1rem; display: flex; align-items: center; gap: 6px;">
                        Total <span style="font-size:0.78rem; color: var(--muted);"> [Credit minus Debit]</span>
                      </div>
                      <label class="toggle-switch" style="margin-top: 8px; justify-content: flex-start;">
                        <input type="checkbox" id="deduct-cc-cash-toggle" ${deductCcCash ? 'checked' : ''} />
                        <span class="meta-text" style="color: var(--muted);">Deduct CC & cash payments</span>
                      </label>
                    </td>
                    <td class="num table-total-amount ${tableNetTotal >= 0 ? 'amt-credit' : 'amt-debit'}">
                      ${tableNetTotal >= 0 ? '+' : '-'}${fmtINR(Math.abs(tableNetTotal))}
                    </td>
                    <td></td>
                  </tr>
                `
                : ''
            }
          </tbody>
        </table>
      </div>
    </div>
  </div>
  ${sipRows.length ? `
    <div class="section">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; gap: 10px;">
        <h2>SIPs</h2>
        <a href="/sips" class="pill-btn sub-pill active hyperlink" style="text-decoration: none; white-sace: nowrap; pflex-shrink: 0; margin-right: 4px;">Manage SIPs</a>
      </div>
      <span class="hint" style="display: block; font-size: 0.82rem; color: var(--muted); margin-bottom: 12px;">${sipRows.length} running this month</span>
      ${sipFilterHtml}
      ${sipCardsHtml}
    </div>` : ''}
    ${recurringRows.length ? `
    <div class="section">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; gap: 8px;">
        <h2 style="min-width: 0; margin: 0;">Recurring Expenses</h2>
        <a href="/subscriptions" class="pill-btn sub-pill active hyperlink" style="text-decoration: none; white-space: nowrap !important; flex-shrink: 0; display: inline-flex; align-items: center; line-height: 1; height: fit-content; margin-right: 4px;">Manage Recurring</a>
      </div>
      <span class="hint" style="display: block; font-size: 0.82rem; color: var(--muted); margin-bottom: 12px;">${recurringRows.length} deducted this month</span>
      ${recurringCardsHtml}
    </div>` : ''}
    `;

    appendPageChrome(root);
    setupScrollWrappers(root);
    setupTableScrollIndicators(root);

    // Sync horizontal scrolling and EXACT table widths between the body and sticky header
    const tableWrapEl = root.querySelector('.transactions-container .table-wrap');
    const headerWrapEl = root.querySelector('.transactions-container .table-header-wrap');
    
    if (tableWrapEl && headerWrapEl) {
      const bodyTable = tableWrapEl.querySelector('table');
      const headerTable = headerWrapEl.querySelector('table');

      if (bodyTable && headerTable) {
        const syncTableWidth = () => {
          if (headerTable && bodyTable) {
            headerTable.style.width = bodyTable.offsetWidth + 'px';
          }
        };
        
        // Sync exactly once after rendering. Avoids ResizeObserver layout-thrashing on mobile scrolls.
        // A tiny timeout ensures the browser has finished computing the table's contents.
        setTimeout(syncTableWidth, 10);
        
        // Only re-sync on actual device rotations/resizes, safely debounced
        let resizeTimer;
        window.addEventListener('resize', () => {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(syncTableWidth, 150);
        });
      }

      tableWrapEl.addEventListener('scroll', () => {
        headerWrapEl.scrollLeft = tableWrapEl.scrollLeft;
      }, { passive: true });
    }

    if (scrollToTransactions) {
      setTimeout(() => {
        const txns = root.querySelector('.transactions-container');
        if (txns) {
          const yOffset = -70;
          const y = txns.getBoundingClientRect().top + window.scrollY + yOffset;
          window.scrollTo({ top: y, behavior: 'smooth' });
        }
      }, 100);
    }
  } catch (err) {
    showToast("Oops! We had trouble securely grabbing this month's numbers. Please refresh the page.");
    
    root.innerHTML = `
      <div class="section">
        <div class="empty-chart" style="margin-top: 40px; padding: 40px; border: 1px dashed var(--debit); border-radius: var(--radius); color: var(--debit);">
          <strong style="font-size: 1.1rem;">Connection Issue</strong><br/><br/>
          We stopped loading this page to keep your previous data safe.<br/>
          Please make sure you have internet access and refresh the page.
        </div>
      </div>
    `;
    appendPageChrome(root);
  }
}

async function syncToPriceTracker(name, amount, date, tag) {
  const syncBtn = $('#f-price-track-btn');
  if (!syncBtn || !syncBtn.classList.contains('active')) return;
  let item = priceItems.find(i => i.name.toLowerCase() === name.toLowerCase() && !i.meta);
  if (!item) {
    item = { id: uid(), name, category: tag, history: [], meta: null };
    priceItems.push(item);
  }
  item.history.push({ id: uid(), date, price: amount, note: 'Synced from Spends' });
  await Store.set('price-items', priceItems);
}

/* ---------- Submit handler ---------- */
async function handleSubmit(kind) {
  const data = await loadMonth(monthKey);
  const desc = ($('#f-desc')?.value || '').trim();
  const amount = Number($('#f-amount')?.value);
  const date = $('#f-date')?.value || todayStr();

  function collectLent() {
    let lent = [];
    if ($('#f-lent-toggle') && $('#f-lent-toggle').checked) {
      $$('.lent-row').forEach(row => {
        const person = row.querySelector('.lent-person').value.trim();
        const amt = Number(row.querySelector('.lent-amount').value);
        if (person && amt > 0) lent.push({ id: uid(), person, amount: amt, settled: false });
      });
    }
    return lent;
  }

  if (kind === 'spend') {
    const modeBtn = document.querySelector('[data-spend-mode].active');
    const uimode = modeBtn ? modeBtn.dataset.spendMode : 'regular';

    let spendDesc = '', tag = '', mode = 'cash', cardId = null;
    if (uimode === 'regular') {
      spendDesc = ($('#f-desc')?.value || '').trim();
      tag = await resolveTagFromForm();
    } else if (uimode === 'atm') {
      spendDesc = 'Cash Withdrawal';
      tag = 'ATM';
    } else if (uimode === 'card') {
      cardId = $('#f-card').value;
      const c = cardById(cards, cardId);
      if (!c) { showToast('Add a credit card first'); return; }
      spendDesc = c.name + ' Bill Payment';
      tag = 'CC due';
      mode = 'card';
    }
    if (!spendDesc || !amount || amount <= 0) { showToast('Enter a spend description and amount'); return; }

    const subCategory = await resolveSubCategoryFromForm(tag);

    let meta = null;
    if (uimode === 'regular') {
      const catLower = (tag || '').toLowerCase();
      if (['groceries', 'transport', 'fuel', 'rent'].includes(catLower)) {
        meta = {};
        if (catLower === 'groceries') meta.quantity = $('#sp-quantity')?.value || '';
        if (catLower === 'transport') { meta.source = $('#sp-source')?.value || ''; meta.destination = $('#sp-destination')?.value || ''; }
        if (catLower === 'fuel') { meta.quantity = $('#sp-quantity')?.value || ''; meta.location = $('#sp-location')?.value || ''; }
        if (catLower === 'rent') meta.location = $('#sp-location')?.value || '';
      }

      const syncBtn = $('#f-price-track-btn');
      if (syncBtn && syncBtn.classList.contains('active')) {
        const isSameMeta = (a, b) => {
          return (a?.source || '') === (b?.source || '') &&
                 (a?.destination || '') === (b?.destination || '') &&
                 (a?.quantity || '') === (b?.quantity || '') &&
                 (a?.location || '') === (b?.location || '');
        };

        // Find an existing Price Track item matching BOTH description and exact route/metadata
        let item = priceItems.find(i => i.name.toLowerCase() === spendDesc.toLowerCase() && isSameMeta(i.meta, meta));
        if (!item) {
          item = { id: uid(), name: spendDesc, category: tag, history: [], meta };
          priceItems.push(item);
        }
        item.history.push({ id: uid(), date, price: amount, note: 'Synced from Spends' });
        await Store.set('price-items', priceItems);
      }
    }
    data.entries.push({ id: uid(), type: 'spend', description: spendDesc, amount, date, paymentMode: mode, cardId, tag, subCategory, lent: collectLent(), meta });
 } else if (kind === 'cardcharge') {
    if (!desc || !amount || amount <= 0) { showToast('Enter a spend description and amount'); return; }
    const cardId = $('#f-card').value;
    const c = cardById(cards, cardId);
    if (!c) { showToast('Add a credit card first'); return; }
    const tag = await resolveTagFromForm();
    const subCategory = await resolveSubCategoryFromForm(tag);
    await syncToPriceTracker(desc, amount, date, tag);
    data.entries.push({ id: uid(), type: 'cardcharge', description: desc, amount, date, cardId, tag, subCategory, lent: collectLent() });
  } else if (kind === 'cashpayment') {
    if (!desc || !amount || amount <= 0) { showToast('Enter a spend description and amount'); return; }
    const tag = await resolveTagFromForm();
    const subCategory = await resolveSubCategoryFromForm(tag);
    await syncToPriceTracker(desc, amount, date, tag);
    data.entries.push({ id: uid(), type: 'cashpayment', description: desc, amount, date, tag, subCategory, lent: collectLent() });
  } else if (kind === 'income') {
    if (!desc || !amount || amount <= 0) { showToast('Enter a source and amount'); return; }
    const category = $('#f-income-category')?.value || '';
    data.entries.push({ id: uid(), type: 'income', description: desc, amount, date, category });
  } else if (kind === 'owed') {
    if (!desc || !amount || amount <= 0) { showToast('Enter a person and amount'); return; }
    const owedPurpose = ($('#f-owed-purpose')?.value || '').trim();
    data.entries.push({ id: uid(), type: 'owed', description: desc, amount, date, settled: false, meta: owedPurpose ? { purpose: owedPurpose } : null });
  } else if (kind === 'invest') {
    if (!desc || !amount || amount <= 0) { showToast('Enter a description and amount'); return; }
    const category = $('#f-invest-category')?.value || 'Fixed Deposit';
    data.entries.push({ id: uid(), type: 'investment', description: desc, amount, date, category });
  } else if (kind === 'emi') {
    const months = Number($('#f-months')?.value);
    const startMonth = $('#f-emi-start')?.value || monthKey;
    const dayOfMonth = Number($('#f-emi-day')?.value);
    if (!desc || !amount || amount <= 0 || !months || months < 1 || !dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31) { showToast('Fill in description, amount, number of months, and a valid date (1-31)'); return; }
    const elapsed = diffMonths(startMonth, currentMonthKey());
    if (elapsed >= months) { showToast('Invalid: EMI is already complete based on the starting month.'); return; }
    const tag = await resolveTagFromForm();
    emiSeries.push({ id: uid(), description: desc, monthlyAmount: amount, totalMonths: months, startMonth, dayOfMonth, tag });
    await Store.set('emiseries', emiSeries);
  } else if (kind === 'recurring') {
    const dayOfMonth = Number($('#f-recurring-day')?.value);
    if (!desc || !amount || amount <= 0 || !dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31) { showToast('Fill in details, amount and a valid date of deduction (1-31)'); return; }
    
    const modeBtn = document.querySelector('[data-recurring-mode].active');
    const paymentMode = modeBtn ? modeBtn.dataset.recurringMode : 'bank';
    let cardId = null;
    if (paymentMode === 'card') {
      cardId = $('#f-recurring-card').value;
      if (!cardId) { showToast('Add a credit card first'); return; }
    }

    recurringSeries.push({ id: uid(), description: desc, amount, dayOfMonth, paymentMode, cardId, startMonth: monthKey });
    await Store.set('recurringseries', recurringSeries);
    await saveMonth(monthKey);
    openForm = null;
    expenseMenuOpen = false;
    await renderMonth();
    showToast(`Recurring spend will be deducted on the ${dayOfMonth}${ordinalSuffix(dayOfMonth)} of every month`);
    return;
  }

  await saveMonth(monthKey);
  openForm = null;
  expenseMenuOpen = false;
  await renderMonth();
  showToast('Added');
}

/* Auto-distribute the "Lent" shares equally across everyone added plus
   the user themself — same split-then-manually-override pattern as
   distributeSplitShares() on the Split page. Only called on structural
   changes (amount typed, a person added/removed, the section toggled on)
   so a manual edit to one .lent-amount input isn't clobbered until the
   next structural change. */
function distributeLentShares(amount) {
  const shareInputs = $$('.lent-amount');
  if (!shareInputs.length) return;
  const n = shareInputs.length + 1; // +1 for the user's own share
  const baseCents = Math.floor((amount * 100) / n);
  let remainderCents = Math.round(amount * 100) - baseCents * n;
  shareInputs.forEach((inp) => {
    let cents = baseCents;
    if (remainderCents > 0) { cents += 1; remainderCents -= 1; }
    inp.value = (cents / 100).toFixed(2);
  });
}

/* ---------- Event wiring ---------- */
root.addEventListener('click', async (ev) => {
  const viewBudgetBtn = ev.target.closest('[data-view-budget]');
  if (viewBudgetBtn) {
      const tagName = viewBudgetBtn.dataset.viewBudget;
      sessionStorage.setItem('month-to-budget-open', JSON.stringify({ tagName, monthKey }));
      window.location.href = `/budget/${monthKey}`;
      return;
  }

  const removeTableFilter = ev.target.closest('[data-remove-table-filter]');

  if (removeTableFilter) {
    const [
      filterCategory,
      ...filterNameParts
    ] = removeTableFilter.dataset.removeTableFilter.split('|');

    const filterName = filterNameParts.join('|');

    if (filterCategory === 'type') {
      activeTypeFilters = activeTypeFilters.filter(
        value => value !== filterName
      );
    } else if (filterCategory === 'tag') {
      activeTagFilters = activeTagFilters.filter(
        value => value !== filterName
      );
    }

    await renderMonth();
    return;
  }

  const sortDirectionBtn = ev.target.closest('#table-sort-direction');

  if (sortDirectionBtn) {
    currentSort.asc = !currentSort.asc;
    await renderMonth();
    return;
  }

  const qaToggle = ev.target.closest('[data-qa-toggle="expense"]');
  if (qaToggle) {
    if (animTimeout) clearTimeout(animTimeout);
    
    const expenseSubTypes = ['spend', 'cardcharge', 'cashpayment', 'recurring', 'emi'];
    const wasOtherActionOpen = openForm && !expenseSubTypes.includes(openForm);

    expenseMenuOpen = !expenseMenuOpen;
    
    if (!expenseMenuOpen) {
      if (expenseSubTypes.includes(openForm)) {
        openForm = null;
        const formWrap = $('#form-panel-anim-inner');
        if (formWrap) formWrap.classList.remove('expanded');
      }
      const qaWrap = $('#qa-sub-anim-inner');
      if (qaWrap) qaWrap.classList.remove('expanded');
      
      qaToggle.classList.remove('active');
      animTimeout = setTimeout(async () => { await renderMonth(); }, 250);
      return;
    } else {
      if (wasOtherActionOpen) {
        openForm = null;
        await renderMonth();
        return;
      }
      
      isExpenseMenuOpening = true;
      await renderMonth();
      isExpenseMenuOpening = false;

      const qaWrap = $('#qa-sub-anim-inner');
      if (qaWrap) {
        void qaWrap.offsetWidth;
        qaWrap.classList.add('expanded');
      }
      return;
    }
  }

  const toggleManualBtn = ev.target.closest('#toggle-manual-balance-btn');
  if (toggleManualBtn) {
    const data = await loadMonth(monthKey);
    data.startingBalanceMode = data.startingBalanceMode === 'manual' ? 'auto' : 'manual';
    await saveMonth(monthKey);
    await renderMonth();
    if (data.startingBalanceMode === 'manual') setTimeout(() => $('#starting-balance-manual')?.focus(), 50);
    return;
  }

  const spendModeBtn = ev.target.closest('[data-spend-mode]');
  if (spendModeBtn) {
    if (spendModeBtn.disabled) return;
    const wrap = spendModeBtn.closest('#f-spend-mode-selector');
    wrap.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
    spendModeBtn.classList.add('active');

    const mode = spendModeBtn.dataset.spendMode;
    const descWrap = $('#f-desc-wrap');
    const cardWrap = $('#f-card-wrap');
    const tagRow = $('#f-tag-row');
    const infoBox = $('#f-mode-info');
    const lentContainer = $('#f-lent-container');
    const lentWrap = $('#f-lent-wrap');
    const lentToggle = $('#f-lent-toggle');
    const priceTrackWrap = $('#f-price-track-wrap');

    if (mode === 'regular') {
      if (priceTrackWrap) priceTrackWrap.style.display = 'block';
      descWrap.style.display = 'block'; cardWrap.style.display = 'none'; tagRow.style.display = 'contents';
      infoBox.textContent = 'Add regular spends with tag for instant transfer modes like UPI.';
      if (lentContainer) lentContainer.style.display = 'flex';
    } else if (mode === 'atm') {
      if (priceTrackWrap) priceTrackWrap.style.display = 'none';
      descWrap.style.display = 'none'; cardWrap.style.display = 'none'; tagRow.style.display = 'none';
      infoBox.textContent = 'Note down debit from bank account upon cash withdrawal.';
      if (lentContainer) lentContainer.style.display = 'none';
      if (lentWrap) lentWrap.style.display = 'none';
      if (lentToggle) lentToggle.checked = false;
    } else if (mode === 'card') {
      if (priceTrackWrap) priceTrackWrap.style.display = 'none';
      descWrap.style.display = 'none'; cardWrap.style.display = 'block'; tagRow.style.display = 'none';
      infoBox.textContent = 'Pays down your credit card dues and reduces overall balance.';
      if (lentContainer) lentContainer.style.display = 'none';
      if (lentWrap) lentWrap.style.display = 'none';
      if (lentToggle) lentToggle.checked = false;
    }
    return;
  }

  const recurringModeBtn = ev.target.closest('[data-recurring-mode]');
  if (recurringModeBtn) {
    if (recurringModeBtn.disabled) return;
    const wrap = recurringModeBtn.closest('#f-recurring-mode-selector');
    wrap.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
    recurringModeBtn.classList.add('active');

    const mode = recurringModeBtn.dataset.recurringMode;
    const cardRow = $('#f-recurring-card-row');
    if (mode === 'card') {
      if (cardRow) cardRow.style.display = 'contents';
    } else {
      if (cardRow) cardRow.style.display = 'none';
    }
    return;
  }

  const priceTrackBtn = ev.target.closest('#f-price-track-btn');
  if (priceTrackBtn) {
    priceTrackBtn.classList.toggle('active');
    priceTrackBtn.textContent = priceTrackBtn.classList.contains('active') ? '✓ Added to Price Tracker' : '+ Add to Price Tracker';
    return;
  }

  const formBtn = ev.target.closest('[data-form]');
  if (formBtn) {
    const newForm = formBtn.dataset.form;
    const oldForm = openForm;

    const expenseSubTypes = ['spend', 'cardcharge', 'cashpayment', 'recurring', 'emi'];
    const isExpenseSubForm = expenseSubTypes.includes(newForm);
    const wasExpenseMenuOpen = expenseMenuOpen;

    if (!isExpenseSubForm) {
      expenseMenuOpen = false;
    } else {
      expenseMenuOpen = true;
    }

    if (animTimeout) clearTimeout(animTimeout);
    if (oldForm === newForm) {
      openForm = null;
      formBtn.classList.remove('active');
      const wrap = $('#form-panel-anim-inner');
      if (wrap) wrap.classList.remove('expanded');
      animTimeout = setTimeout(async () => { await renderMonth(); }, 250);
      return;
    }
    
    if (oldForm || (wasExpenseMenuOpen && !isExpenseSubForm)) {
      openForm = newForm;
      await renderMonth();
      setTimeout(() => $('#form-panel-anim-inner')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
      return;
    }
    
    isFormOpening = true;
    openForm = newForm;
    await renderMonth();
    isFormOpening = false;
    
    const wrap = $('#form-panel-anim-inner');
    if (wrap) {
      void wrap.offsetWidth;
      wrap.classList.add('expanded');
      setTimeout(() => wrap.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200);
    }
    return;
  }

  const closeForm = ev.target.closest('[data-close-form]');
  if (closeForm) {
    if (animTimeout) clearTimeout(animTimeout);
    openForm = null;
    const wrap = $('#form-panel-anim-inner');
    if (wrap) wrap.classList.remove('expanded');
    
    document.querySelectorAll('[data-form], [data-qa-toggle]').forEach(btn => btn.classList.remove('active'));
    
    animTimeout = setTimeout(async () => { await renderMonth(); }, 250);
    return;
  }

  const addLentRow = ev.target.closest('[data-add-lent-row]');
  if (addLentRow) {
    const wrap = $('#lent-rows');
    const row = document.createElement('div');
    row.className = 'lent-row';
    row.innerHTML = `
      <div class="field"><label>Person</label><input class="lent-person" type="text" placeholder="Name" /></div>
      <div class="field"><label>Amount (₹)</label><input class="lent-amount" type="number" step="0.01" placeholder="0.00" /></div>
      <button class="btn small ghost" data-remove-lent-row type="button">Remove</button>`;
    wrap.appendChild(row);
    distributeLentShares(Number($('#f-amount')?.value) || 0);
    return;
  }
  const removeLentRow = ev.target.closest('[data-remove-lent-row]');
  if (removeLentRow) {
    removeLentRow.closest('.lent-row').remove();
    distributeLentShares(Number($('#f-amount')?.value) || 0);
    return;
  }

  const submitBtn = ev.target.closest('[data-submit]');
  if (submitBtn) { await handleSubmit(submitBtn.dataset.submit); return; }

  const editEntry = ev.target.closest('[data-edit-entry]');
  if (editEntry) {
    const [mk, id] = editEntry.dataset.editEntry.split('|');
    const data = await loadMonth(mk);
    const entryToEdit = data.entries.find(e => e.id === id);
    if (!entryToEdit) return;

    const tr = editEntry.closest('tr');
    
    const tds = Array.from(tr.children);
    tds.forEach(td => { if (!td.classList.contains('dv-date')) td.style.display = 'none'; });
    
    const editTd = document.createElement('td');
    editTd.colSpan = tds.length - (tr.querySelector('.dv-date') ? 1 : 0);
    editTd.className = 'edit-td';
    editTd.style.padding = '0';
    editTd.innerHTML = renderInlineEdit(entryToEdit, mk);
    
    tr.appendChild(editTd);
    tr.classList.add('is-editing');
    return;
  }

  const saveEntry = ev.target.closest('[data-save-entry]');
  if (saveEntry) {
    const [mk, id] = saveEntry.dataset.saveEntry.split('|');
    const container = saveEntry.closest('.inline-edit-container');
    const newDesc = container.querySelector('.ie-desc').value.trim();
    const newAmt = Number(container.querySelector('.ie-amount').value);

    if (!newDesc || isNaN(newAmt) || newAmt <= 0) {
      showToast("Invalid description or amount.");
      return;
    }

    let newTag = container.querySelector('.ie-tag')?.value || '';
    if (newTag === '__custom__') {
        newTag = container.querySelector('.ie-tag-custom')?.value.trim() || '';
        if (newTag && !allSpendTags(DEFAULT_TAGS, customTags).some(t => t.toLowerCase() === newTag.toLowerCase())) {
            customTags.push(newTag);
            await Store.set('custom-spend-tags', customTags);
        }
    }
    
    let newSubcat = '';
    const subcatSel = container.querySelector('.ie-subcat-select');
    if (subcatSel) {
        newSubcat = subcatSel.value;
        if (newSubcat === '__custom__') {
            newSubcat = container.querySelector('.ie-subcat-custom')?.value.trim() || '';
        }
        if (newSubcat && newTag) {
            const catIdx = budgetData.findIndex(c => c.name.toLowerCase() === newTag.toLowerCase());
            if (catIdx > -1) {
                const cat = budgetData[catIdx];
                cat.subcategories = cat.subcategories || [];
                if (!cat.subcategories.some(s => s.name.toLowerCase() === newSubcat.toLowerCase())) {
                    cat.subcategories.push({ id: uid(), name: newSubcat, budget: 0 });
                    await Store.set(`budget-data:${mk}`, budgetData);
                }
            } else {
                budgetData.push({
                    id: uid(), name: newTag, budget: 0, expanded: true,
                    subcategories: [{ id: uid(), name: newSubcat, budget: 0 }]
                });
                await Store.set(`budget-data:${mk}`, budgetData);
            }
        }
    }

    let meta = null;
    const tLow = (newTag || '').toLowerCase();
    if (tLow === 'transport') {
        meta = {
            source: container.querySelector('.ie-meta-1')?.value || '',
            destination: container.querySelector('.ie-meta-2')?.value || ''
        };
    } else if (tLow === 'groceries' || tLow === 'rent') {
        meta = {
            [tLow === 'rent' ? 'location' : 'quantity']: container.querySelector('.ie-meta-1')?.value || ''
        };
    } else if (tLow === 'fuel') {
        meta = {
            quantity: container.querySelector('.ie-meta-1')?.value || '',
            location: container.querySelector('.ie-meta-2')?.value || ''
        };
    }

    const data = await loadMonth(mk);
    const entryToEdit = data.entries.find(e => e.id === id);
    if (entryToEdit) {
      entryToEdit.description = newDesc;
      entryToEdit.amount = newAmt;
      entryToEdit.tag = newTag;
      if (entryToEdit.type === 'income' || entryToEdit.type === 'investment') {
        entryToEdit.category = newTag;
        entryToEdit.subCategory = '';
        entryToEdit.meta = null;
      } else {
        entryToEdit.subCategory = newSubcat;
        entryToEdit.meta = meta;
      }
      await saveMonth(mk);
      await renderMonth();
      showToast("Entry updated");
    }
    return;
  }

  const cancelEdit = ev.target.closest('[data-cancel-edit]');
  if (cancelEdit) {
    await renderMonth();
    return;
  }

  const editEmiDay = ev.target.closest('[data-edit-emi-day]');
  if (editEmiDay) {
    const seriesId = editEmiDay.dataset.editEmiDay;
    const series = emiSeries.find(s => s.id === seriesId);
    if (!series) return;
    
    const container = editEmiDay.closest('.emi-stats');
    container.innerHTML = `
      <span>Next deduction:</span>
      <input type="number" min="1" max="31" class="inline-edit-emi-day" value="${series.dayOfMonth || 1}" style="width: 45px; padding: 2px 4px; border: 1px solid var(--sky); border-radius: 4px; font-family: inherit; font-size: 0.8rem;" />
      <button class="icon-btn" data-save-emi-day="${seriesId}" title="Save" style="color: var(--credit); padding: 2px;">✓</button>
      <button class="icon-btn" data-cancel-edit-emi title="Cancel" style="color: var(--debit); padding: 2px;">✕</button>
    `;
    
    // Focus the input automatically
    container.querySelector('.inline-edit-emi-day').focus();
    return;
  }

  const saveEmiDay = ev.target.closest('[data-save-emi-day]');
  if (saveEmiDay) {
    const seriesId = saveEmiDay.dataset.saveEmiDay;
    const container = saveEmiDay.closest('.emi-stats');
    const newDay = Number(container.querySelector('.inline-edit-emi-day').value);
    
    if (!newDay || newDay < 1 || newDay > 31) {
      showToast("Enter a valid day (1-31).");
      return;
    }
    
    const series = emiSeries.find(s => s.id === seriesId);
    if (series) {
      series.dayOfMonth = newDay;
      await Store.set('emiseries', emiSeries);
      await renderMonth();
      showToast("Deduction date updated");
    }
    return;
  }

  const cancelEditEmi = ev.target.closest('[data-cancel-edit-emi]');
  if (cancelEditEmi) {
    await renderMonth();
    return;
  }

  const ieAddSubcatBtn = ev.target.closest('.ie-add-subcat-btn');
  if (ieAddSubcatBtn) {
     const container = ieAddSubcatBtn.closest('.inline-edit-container');
     const tag = container.querySelector('.ie-tag').value;
     let existingSubs = [];
     if (tag && tag !== '__custom__') {
       const cat = budgetData.find(c => c.name.toLowerCase() === tag.toLowerCase());
       if (cat && cat.subcategories) existingSubs = cat.subcategories.map(s => s.name);
     }
     const subOpts = existingSubs.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
     
     const subcatSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><defs><mask id="subtag-hole"><rect width="24" height="24" fill="white"/><rect x="6" y="7" width="12" height="2" fill="black"/><rect x="10" y="11" width="8" height="2" fill="black"/><rect x="10" y="15" width="8" height="2" fill="black"/></mask></defs><rect x="3" y="3" width="18" height="18" rx="2" mask="url(#subtag-hole)"/></svg>`;
     const zone = container.querySelector('.ie-subcat-zone');
     zone.innerHTML = `
       <div class="ie-input-group" style="flex:1; min-width:140px;">
         ${subcatSvg}
         <select class="ie-subcat-select field-input">
             <option value="" disabled selected>Subcategory...</option>
             ${subOpts}
             <option value="__custom__">+ Add custom</option>
         </select>
         <input type="text" class="ie-subcat-custom field-input" style="display:none;" placeholder="Name">
       </div>
     `;
     return;
  }

  const addSubcatBtn = ev.target.closest('#f-add-subcat-btn');
  if (addSubcatBtn) {
     if (addSubcatBtn.disabled) return;
     
     addSubcatBtn.classList.toggle('active');
     const selectWrap = $('#f-subcat-select-wrap');
     const customInput = $('#f-subcat-custom');
     
     if (addSubcatBtn.classList.contains('active')) {
         addSubcatBtn.textContent = '- Subcategory';
         addSubcatBtn.style.color = '#fff';
         addSubcatBtn.style.background = 'var(--blue)';
         addSubcatBtn.style.borderColor = 'var(--blue)';
         
         let catName = $('#f-tag').value;
         if (catName === '__custom__') catName = $('#f-tag-custom').value.trim();

         let existingSubs = [];
         if (catName) {
           const cat = budgetData.find(c => c.name.toLowerCase() === catName.toLowerCase());
           if (cat && cat.subcategories) existingSubs = cat.subcategories.map(s => s.name);
         }
         
         const subOptions = existingSubs.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
         const sel = $('#f-subcat-select');
         if (sel) sel.innerHTML = `<option value="" disabled selected>Select...</option>${subOptions}<option value="__custom__">+ Add custom</option>`;
         
         if (selectWrap) selectWrap.style.display = 'block';
     } else {
         addSubcatBtn.textContent = '+ Add Subcategory';
         addSubcatBtn.style.color = 'var(--blue)';
         addSubcatBtn.style.background = 'transparent';
         if (selectWrap) selectWrap.style.display = 'none';
         const sel = $('#f-subcat-select');
         if (sel) sel.value = '';
         if (customInput) {
             customInput.style.display = 'none';
             customInput.value = '';
         }
     }
     return;
  }

  const delEntry = ev.target.closest('[data-del-entry]');
  if (delEntry) {
    const [mk, id] = delEntry.dataset.delEntry.split('|');
    const data = await loadMonth(mk);
    const entryToDel = data.entries.find(e => e.id === id);
    if (entryToDel && entryToDel.linkedLent) {
      const { spendMonthKey, spendId, lentId } = entryToDel.linkedLent;
      // Deleting a Payback un-settles its original "Lent" chip, even if
      // that spend lives in a different (earlier) month than this Payback
      // entry. Prefer the stored month reference; fall back to scanning
      // every indexed month for older data that predates it.
      const candidateKeys = spendMonthKey ? [spendMonthKey] : monthsIndex;
      for (const sk of candidateKeys) {
        const spendMonthData = sk === mk ? data : await loadMonth(sk);
        const originalSpend = spendMonthData.entries.find(e => e.id === spendId);
        if (originalSpend) {
          if (originalSpend.lent) {
            const lentChip = originalSpend.lent.find(x => x.id === lentId);
            if (lentChip) lentChip.settled = false;
          }
          if (sk !== mk) await saveMonth(sk);
          break;
        }
      }
    }
    if (entryToDel && entryToDel.linkedOwed) {
      const { entryMonthKey, entryId } = entryToDel.linkedOwed;
      // Same idea for a standalone "Owed to you" entry: it has no lent
      // chips of its own, just a top-level `settled` flag to flip back.
      const candidateKeys = entryMonthKey ? [entryMonthKey] : monthsIndex;
      for (const sk of candidateKeys) {
        const owedMonthData = sk === mk ? data : await loadMonth(sk);
        const originalOwed = owedMonthData.entries.find(e => e.id === entryId);
        if (originalOwed) {
          originalOwed.settled = false;
          if (sk !== mk) await saveMonth(sk);
          break;
        }
      }
    }
    data.entries = data.entries.filter(e => e.id !== id);
    await saveMonth(mk);
    await renderMonth();
    showToast('Entry removed');
    return;
  }

  const delEmiSeriesBtn = ev.target.closest('[data-del-emi-series]');
  if (delEmiSeriesBtn) {
    ev.stopPropagation();
    const { showDeleteCallout } = await import('../components/delete-popover.js');
    showDeleteCallout(delEmiSeriesBtn, 'confirm-del-emi-series', delEmiSeriesBtn.dataset.delEmiSeries);
    return;
  }
  const confirmDelEmiSeries = ev.target.closest('[data-confirm-del-emi-series]');
  if (confirmDelEmiSeries) {
    ev.stopPropagation();
    const { hideDeleteCallout } = await import('../components/delete-popover.js');
    const seriesId = confirmDelEmiSeries.dataset.confirmDelEmiSeries;
    emiSeries = emiSeries.filter(s => s.id !== seriesId);
    await Store.set('emiseries', emiSeries);
    hideDeleteCallout();
    await renderMonth();
    showToast('EMI deleted entirely');
    return;
  }

  const skipRecurringBtn = ev.target.closest('[data-skip-recurring]');
  if (skipRecurringBtn) {
    ev.stopPropagation();
    const { showDeleteCallout } = await import('../components/delete-popover.js');
    showDeleteCallout(skipRecurringBtn, 'confirm-skip-recurring', skipRecurringBtn.dataset.skipRecurring, 'Confirm skip');
    return;
  }
  const confirmSkipRecurring = ev.target.closest('[data-confirm-skip-recurring]');
  if (confirmSkipRecurring) {
    ev.stopPropagation();
    const { hideDeleteCallout } = await import('../components/delete-popover.js');
    const [mk, seriesId] = confirmSkipRecurring.dataset.confirmSkipRecurring.split('|');
    const data = await loadMonth(mk);
    data.deletedRecurring = data.deletedRecurring || [];
    if (!data.deletedRecurring.includes(seriesId)) data.deletedRecurring.push(seriesId);
    await saveMonth(mk);
    hideDeleteCallout();
    await renderMonth();
    showToast("Skipped this month's recurring expense — balance updated");
    return;
  }

  const sipFilterBtn = ev.target.closest('[data-sip-filter]');
  if (sipFilterBtn) {
    currentSipFilter = sipFilterBtn.dataset.sipFilter;
    await renderMonth();
    return;
  }

  const skipSipBtn = ev.target.closest('[data-skip-sip]');
  if (skipSipBtn) {
    ev.stopPropagation();
    const { showDeleteCallout } = await import('../components/delete-popover.js');
    showDeleteCallout(skipSipBtn, 'confirm-skip-sip', skipSipBtn.dataset.skipSip, 'Confirm skip');
    return;
  }
  const confirmSkipSip = ev.target.closest('[data-confirm-skip-sip]');
  if (confirmSkipSip) {
    ev.stopPropagation();
    const { hideDeleteCallout } = await import('../components/delete-popover.js');
    const [mk, seriesId] = confirmSkipSip.dataset.confirmSkipSip.split('|');
    const data = await loadMonth(mk);
    data.deletedSip = data.deletedSip || [];
    if (!data.deletedSip.includes(seriesId)) data.deletedSip.push(seriesId);
    await saveMonth(mk);

    const sip = sipSeries.find(s => s.id === seriesId);
    if (sip) {
      sip.skipMonths = sip.skipMonths || [];
      if (!sip.skipMonths.includes(mk)) sip.skipMonths.push(mk);
      await Store.set('sipseries', sipSeries);
    }

    hideDeleteCallout();
    await renderMonth();
    showToast("Skipped this month's SIP — balance updated");
    return;
  }

  const settleOwed = ev.target.closest('[data-settle-owed]');
  if (settleOwed) {
    const [mk, id] = settleOwed.dataset.settleOwed.split('|');
    const data = await loadMonth(mk);
    const entry = data.entries.find(e => e.id === id);
    if (entry && !entry.settled) {
      // Same treatment as a Lent chip: the owed entry itself is left
      // alone (still `settled: true`) and the money-back is recorded as
      // its own Payback transaction in the real current month, so it
      // restores balance without inflating the Income stat.
      entry.settled = true;
      await saveMonth(mk);

      const paybackKey = currentMonthKey();
      await ensureMonthIndexed(paybackKey, monthsIndex);
      const paybackData = await loadMonth(paybackKey);
      paybackData.entries.push({
        id: uid(),
        type: 'payback',
        description: `Payback @${entry.description}`,
        amount: Number(entry.amount) || 0,
        date: todayStr(),
        linkedOwed: { entryMonthKey: mk, entryId: entry.id },
      });
      await saveMonth(paybackKey);

      await renderMonth();
      showToast('Marked as paid back');
      return;
    }
    await saveMonth(mk);
    await renderMonth();
    return;
  }

  const toggleLent = ev.target.closest('[data-toggle-lent]');
  if (toggleLent) {
    const [entryId, lentId] = toggleLent.dataset.toggleLent.split('|');
    const data = await loadMonth(monthKey); // already in monthCache — resolves instantly, no network
    const entry = data.entries.find(e => e.id === entryId);
    const l = entry && (entry.lent || []).find(x => x.id === lentId);
    if (!l) return;

    if (!l.settled) {
      // Settle, optimistically: flip the in-memory state, push the new
      // Payback/Income entry into the already-loaded month data if it lands
      // on the page we're viewing, then re-render immediately. The actual
      // PUT(s) to the backend happen afterwards, in the background, so
      // the click never waits on a network round trip.
      //
      // Same-month payback (spend and payback both land in the month
      // that's actually "now") stays a `payback` entry, offsetting this
      // month's cash outflow exactly as before. A cross-month payback
      // (the spend/cardcharge lives in an earlier month) instead posts as
      // fresh "Friends" income in the current month, so a historical
      // month's chart is never rewritten by today's settlement.
      const spendMonthKey = monthKey;
      const isCrossMonth = spendMonthKey !== currentMonthKey();
      const paybackId = uid();
      const paybackKey = currentMonthKey();
      const paybackEntry = isCrossMonth ? {
        id: paybackId,
        type: 'income',
        category: 'Friends',
        description: `Payback @${entry.description} (${l.person})`,
        amount: Number(l.amount) || 0,
        date: todayStr(),
        linkedLent: { spendMonthKey, spendId: entry.id, lentId: l.id },
      } : {
        id: paybackId,
        type: 'payback',
        description: `Payback @${entry.description} (${l.person})`,
        amount: Number(l.amount) || 0,
        date: todayStr(),
        linkedLent: { spendMonthKey, spendId: entry.id, lentId: l.id },
      };
      l.settled = true;
      l.paybackRef = { monthKey: paybackKey, id: paybackId };
      if (paybackKey === monthKey) data.entries.push(paybackEntry);

      await renderMonth();
      showToast('Marked as paid back');

      (async () => {
        try {
          if (!monthsIndex.includes(paybackKey)) {
            monthsIndex.push(paybackKey);
            monthsIndex.sort();
            await Store.set('months-index', monthsIndex);
          }
          if (paybackKey === monthKey) {
            await saveMonth(monthKey);
          } else {
            const paybackData = await loadMonth(paybackKey);
            paybackData.entries.push(paybackEntry);
            await Promise.all([saveMonth(monthKey), saveMonth(paybackKey)]);
          }
        } catch (err) {
          showToast("Your payback was saved locally, but we couldn't sync it to the server. Check your connection.");
        }
      })();
    } else {
      // Undo, optimistically: flip the chip back and strip the Payback
      // from the in-memory data we already have on hand, re-render right
      // away, then reconcile the backend in the background. Prefer the
      // stored reference; fall back to a full scan for chips settled
      // before that field existed.
      const ref = l.paybackRef;
      l.settled = false;
      delete l.paybackRef;
      if (ref && ref.monthKey === monthKey) {
        data.entries = data.entries.filter(pe => pe.id !== ref.id);
      } else if (!ref) {
        data.entries = data.entries.filter(pe => !(
          (pe.type === 'payback' || pe.type === 'income') && pe.linkedLent &&
          pe.linkedLent.spendId === entry.id && pe.linkedLent.lentId === l.id
        ));
      }

      await renderMonth();
      showToast('Marked as unpaid');

      (async () => {
        try {
          await saveMonth(monthKey);
          if (!(ref && ref.monthKey === monthKey)) {
            const candidateKeys = ref ? [ref.monthKey] : monthsIndex;
            for (const sk of candidateKeys) {
              if (sk === monthKey) continue;
              const pbData = await loadMonth(sk);
              const before = pbData.entries.length;
              pbData.entries = pbData.entries.filter(pe => !(
                (pe.type === 'payback' || pe.type === 'income') && pe.linkedLent &&
                pe.linkedLent.spendId === entry.id && pe.linkedLent.lentId === l.id
              ));
              if (pbData.entries.length !== before) { await saveMonth(sk); break; }
            }
          }
        } catch (err) {
          showToast("Your change was saved locally, but we couldn't sync it to the server. Check your connection.");
        }
      })();
    }
    return;
  }
});

root.addEventListener('change', async (ev) => {
  if (ev.target.classList.contains('ie-subcat-select')) {
     const val = ev.target.value;
     const customInput = ev.target.nextElementSibling;
     if (customInput && customInput.classList.contains('ie-subcat-custom')) {
       customInput.style.display = val === '__custom__' ? 'inline-block' : 'none';
       if (val === '__custom__') customInput.focus();
     }
     return;
  }

  if (ev.target.classList.contains('ie-tag')) {
    const val = ev.target.value;
    const container = ev.target.closest('.inline-edit-container');
    const entryType = container?.dataset.entryType;
    if (entryType === 'income' || entryType === 'investment') {
      return;
    }

    const customTag = container.querySelector('.ie-tag-custom');
    if (customTag) customTag.style.display = val === '__custom__' ? 'inline-block' : 'none';
    
    const zone = container.querySelector('.ie-subcat-zone');
    if (val) {
        zone.innerHTML = `<button class="pill-btn sub-pill ie-add-subcat-btn" type="button" style="border: 1px dashed var(--sky); padding: 5px 12px; font-size: 0.72rem; background: transparent; color: var(--muted); cursor: pointer; text-transform: uppercase; margin-top: 2px;">+ Add Subcategory</button>`;
    } else {
        zone.innerHTML = `<button class="pill-btn sub-pill ie-add-subcat-btn" type="button" disabled style="border: 1px dashed var(--sky); padding: 5px 12px; font-size: 0.72rem; background: transparent; color: var(--muted); cursor: not-allowed; opacity: 0.5; text-transform: uppercase; margin-top: 2px;">+ Add Subcategory</button>`;
    }
    
    const meta1Svg = `<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="10" fill="currentColor"/><text x="12" y="16.5" font-size="12" font-family="sans-serif" font-weight="bold" fill="var(--paper)" text-anchor="middle">1</text></svg>`;
    const meta2Svg = `<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="10" fill="currentColor"/><text x="12" y="16.5" font-size="12" font-family="sans-serif" font-weight="bold" fill="var(--paper)" text-anchor="middle">2</text></svg>`;

    const metaZone = container.querySelector('.ie-meta-zone');
    let metaHtml = '';
    const tLow = val.toLowerCase();
    if (tLow === 'transport') {
        metaHtml = `<div class="ie-input-group" style="flex:1; min-width:120px;">${meta1Svg}<input type="text" class="ie-meta-1 field-input" placeholder="Source"></div><div class="ie-input-group" style="flex:1; min-width:120px;">${meta2Svg}<input type="text" class="ie-meta-2 field-input" placeholder="Destination"></div>`;
    } else if (tLow === 'groceries') {
        metaHtml = `<div class="ie-input-group" style="flex:1; min-width:120px;">${meta1Svg}<input type="text" class="ie-meta-1 field-input" placeholder="Quantity"></div>`;
    } else if (tLow === 'fuel') {
        metaHtml = `<div class="ie-input-group" style="flex:1; min-width:120px;">${meta1Svg}<input type="text" class="ie-meta-1 field-input" placeholder="Quantity"></div><div class="ie-input-group" style="flex:1; min-width:120px;">${meta2Svg}<input type="text" class="ie-meta-2 field-input" placeholder="Location"></div>`;
    } else if (tLow === 'rent') {
        metaHtml = `<div class="ie-input-group" style="flex:1; min-width:120px;">${meta2Svg}<input type="text" class="ie-meta-1 field-input" placeholder="Location"></div>`;
    }
    if (metaZone) {
      metaZone.innerHTML = metaHtml;
      metaZone.style.display = metaHtml ? 'flex' : 'none';
    }
    return;
  }

  if (ev.target.id === 'deduct-cc-cash-toggle') {
    deductCcCash = ev.target.checked;
    setTimeout(async () => {
      await renderMonth();
    }, 200);
    return;
  }

  if (ev.target.id === 'table-type-filter') {
    const value = ev.target.value;

    if (value && !activeTypeFilters.includes(value)) {
      activeTypeFilters.push(value);
    }

    ev.target.value = '';
    await renderMonth();
    return;
  }

  if (ev.target.id === 'table-tag-filter') {
    const value = ev.target.value;

    if (value && !activeTagFilters.includes(value)) {
      activeTagFilters.push(value);
    }

    ev.target.value = '';
    await renderMonth();
    return;
  }

  if (ev.target.id === 'table-sort-control') {
    const key = ev.target.value;

    if (!key) return;

    if (key === currentSort.key) {
      currentSort.asc = !currentSort.asc;
    } else {
      currentSort.key = key;
    }

    await renderMonth();
    return;
  }

  if (ev.target.id === 'f-subcat-select') {
    const val = ev.target.value;
    const customInput = $('#f-subcat-custom');
    if (customInput) {
       customInput.style.display = val === '__custom__' ? 'block' : 'none';
       if (val === '__custom__') customInput.focus();
    }
  }

  if (ev.target.id === 'f-tag') {
    const val = ev.target.value;
    const customWrap = $('#f-tag-custom-wrap');
    if (customWrap) customWrap.style.display = val === '__custom__' ? 'block' : 'none';

    const subcatBtn = $('#f-add-subcat-btn');
    const subcatSelWrap = $('#f-subcat-select-wrap');
    const customInput = $('#f-subcat-custom');
    
    if (subcatBtn) {
       subcatBtn.disabled = !val;
       subcatBtn.style.opacity = val ? '1' : '0.5';
       subcatBtn.style.cursor = val ? 'pointer' : 'not-allowed';
       subcatBtn.style.color = val ? 'var(--blue)' : 'var(--muted)';
       subcatBtn.style.borderColor = val ? 'var(--blue)' : 'var(--sky)';
       subcatBtn.style.background = 'transparent';
       subcatBtn.style.display = 'inline-block';
       
       subcatBtn.classList.remove('active');
       subcatBtn.textContent = '+ Add Subcategory';
       
       if (subcatSelWrap) subcatSelWrap.style.display = 'none';
       if (customInput) {
           customInput.style.display = 'none';
           customInput.value = '';
       }
       const sel = $('#f-subcat-select');
       if (sel) sel.value = '';
    }

    const ptDynamicWrap = $('#pt-dynamic-fields');
    if (ptDynamicWrap) {
      const vLow = val.toLowerCase();
      if (vLow === 'groceries') ptDynamicWrap.innerHTML = `<div class="field"><label>Quantity</label><input id="pt-quantity" type="text" placeholder="e.g. 1kg or 1L" /></div>`;
      else if (vLow === 'transport') ptDynamicWrap.innerHTML = `<div class="field"><label>Source</label><input id="pt-source" type="text" placeholder="e.g. Home" /></div><div class="field"><label>Destination</label><input id="pt-destination" type="text" placeholder="e.g. Office" /></div>`;
      else if (vLow === 'fuel') ptDynamicWrap.innerHTML = `<div class="field"><label>Quantity</label><input id="pt-quantity" type="text" placeholder="e.g. 5L" /></div><div class="field"><label>Location</label><input id="pt-location" type="text" placeholder="e.g. IOCL Bengaluru" /></div>`;
      else if (vLow === 'rent') ptDynamicWrap.innerHTML = `<div class="field"><label>Location</label><input id="pt-location" type="text" placeholder="e.g. Sunflower Heights Whitefield" /></div>`;
      else ptDynamicWrap.innerHTML = '';
      
      ptDynamicWrap.style.display = ptDynamicWrap.innerHTML ? 'grid' : 'none';
    }

    const spendDynamicWrap = $('#spend-dynamic-fields');
    if (spendDynamicWrap) {
      const vLow = val.toLowerCase();
      if (vLow === 'groceries') spendDynamicWrap.innerHTML = `<div class="field"><label>Quantity</label><input id="sp-quantity" type="text" placeholder="e.g. 1kg or 1L" /></div>`;
      else if (vLow === 'transport') spendDynamicWrap.innerHTML = `<div class="field"><label>Source</label><input id="sp-source" type="text" placeholder="e.g. Home" /></div><div class="field"><label>Destination</label><input id="sp-destination" type="text" placeholder="e.g. Office" /></div>`;
      else if (vLow === 'fuel') spendDynamicWrap.innerHTML = `<div class="field"><label>Quantity</label><input id="sp-quantity" type="text" placeholder="e.g. 5L" /></div><div class="field"><label>Location</label><input id="sp-location" type="text" placeholder="e.g. IOCL Bengaluru" /></div>`;
      else if (vLow === 'rent') spendDynamicWrap.innerHTML = `<div class="field"><label>Location</label><input id="sp-location" type="text" placeholder="e.g. Sunflower Heights Whitefield" /></div>`;
      else spendDynamicWrap.innerHTML = '';
      
      spendDynamicWrap.style.display = spendDynamicWrap.innerHTML ? 'grid' : 'none';
    }
  }
  if (ev.target.id === 'f-lent-toggle') {
    const lentWrap = $('#f-lent-wrap');
    if (lentWrap) lentWrap.style.display = ev.target.checked ? 'block' : 'none';
    if (ev.target.checked) distributeLentShares(Number($('#f-amount')?.value) || 0);
  }
  if (ev.target.id === 'starting-balance-manual') {
    const data = await loadMonth(monthKey);
    data.startingBalance = Number(ev.target.value) || 0;
    await saveMonth(monthKey);
    await renderMonth();
  }
});

root.addEventListener('input', (ev) => {
  if (ev.target.id === 'f-amount') {
    const lentToggle = $('#f-lent-toggle');
    if (lentToggle && lentToggle.checked) distributeLentShares(Number(ev.target.value) || 0);
  }
});

import('../components/delete-popover.js').then(({ wireDeletePopoverDismiss }) => wireDeletePopoverDismiss(root));
wireStatCardFlip(root);
window.addEventListener('auth:signed-in', renderMonth);
window.addEventListener('auth:checked', renderMonth);
// Wait for the first /api/auth/me round trip so we never flash the
// signed-out login hero for an already-authenticated visitor.
authReady.then(renderMonth);
wireChartTooltips(root);
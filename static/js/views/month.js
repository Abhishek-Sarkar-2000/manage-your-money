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
import { computeSplitPageData } from '../core/split-domain.js';
import { donutChart } from '../components/charts/donut.js';
import { barChart, tagsBarChart } from '../components/charts/bar-chart.js';
import { lineChart, wireChartTooltips } from '../components/charts/line-chart.js';
import { scrollWrapper, setupScrollWrappers, setupTableScrollIndicators } from '../components/scroll-wrapper.js';
import { appendPageChrome } from '../components/page-chrome.js';
import { showToast } from '../components/toast.js';
import { markRendered } from '../components/render-guard.js';

const root = document.getElementById('month-root');
const monthKey = root.dataset.monthKey;

const DEFAULT_TAGS = ['Groceries', 'Dining', 'Food', 'Fuel', 'Transport', 'Rent', 'Utility', 'Shopping', 'Recharge', 'Medicine'];

let cards = [];
let emiSeries = [];
let sipSeries = [];
let recurringSeries = [];
let monthsIndex = [];
let customTags = [];
let priceTrackDictionary = {};
let priceItems = [];
let existingInvestments = 0;
let splitsIndex = [];
let openForm = null;
let isMenuOpen = false;
let isMoreOpen = false;
let formSlideDirection = '';
let animTimeout = null;
let domainLoaded = false;
let currentSipFilter = 'All';

const PILL_ORDER = ['spend', 'cardcharge', 'cashpayment', 'recurring', 'income', 'owed', 'emi', 'invest'];

// Fetched once. renderMonth() is called on almost every interaction on
// this page (add/delete an entry, toggle starting balance, settle a debt,
// skip a SIP...) — without this guard every one of those was doing 7
// network round trips before rebuilding the DOM. Every mutation below
// (EMI series, custom tags, price-tracker items, etc.) already updates
// these arrays/objects in place before calling Store.set(), so the cache
// stays correct without a refetch.
async function loadDomain() {
  if (domainLoaded) return;
  [cards, emiSeries, sipSeries, monthsIndex, customTags, priceTrackDictionary, priceItems, existingInvestments, splitsIndex, recurringSeries] = await Promise.all([
    Store.get('creditcards', []),
    Store.get('emiseries', []),
    Store.get('sipseries', []),
    Store.get('months-index', []),
    Store.get('custom-spend-tags', []),
    Store.get('price-track-dict', {}),
    Store.get('price-items', []),
    Store.get('existinginvestments', 0),
    Store.get('splits-index', []),
    Store.get('recurringseries', []),
  ]);
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
    const dateLabel = e.date ? new Date(e.date + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—';
    dateCell = `<td class="dv-date num" rowspan="${rowspan}">${dateLabel}</td>`;
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
        <td class="type-cell"><span class="tag payback">Payback</span></td>
        <td class="desc-cell">
          <strong>${escapeHtml(e.description)}</strong>${e.tag ? ` <span class="src-badge">${escapeHtml(e.tag)}</span>` : ''}${metaHtml}
          <div class="subnote">Cash / debit</div>
          ${lentChips ? `<div class="chip-row">${lentChips}</div>` : ''}
        </td>
        <td class="num amt-credit">+${fmtINR(displayAmount)}</td>
        <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-del-entry="${key}|${e.id}" title="Delete">✕</button></span></td>
      </tr>`;
    }

    return `<tr>
      ${dateCell}
      <td class="type-cell"><span class="tag spend">Spend</span></td>
      <td class="desc-cell">
        <strong>${escapeHtml(e.description)}</strong>${e.tag ? ` <span class="src-badge">${escapeHtml(e.tag)}</span>` : ''}${metaHtml}
        <div class="subnote">${card ? 'Paid for ' + escapeHtml(card.name) + ' — reduces card dues' : 'Cash / debit'}</div>
        ${lentChips ? `<div class="chip-row">${lentChips}</div>` : ''}
      </td>
      <td class="num amt-debit">-${fmtINR(displayAmount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-edit-entry="${key}|${e.id}" title="Edit">✎</button><button class="icon-btn" data-del-entry="${key}|${e.id}" title="Delete">✕</button></span></td>
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
      <td class="type-cell"><span class="tag cardcharge">Card spend</span></td>
      <td class="desc-cell">
        <strong>${escapeHtml(e.description)}</strong>${e.tag ? ` <span class="src-badge">${escapeHtml(e.tag)}</span>` : ''}${metaHtml}
        <div class="subnote">On ${card ? escapeHtml(card.name) : 'a removed card'} — adds to card dues</div>
        ${lentChips ? `<div class="chip-row">${lentChips}</div>` : ''}
      </td>
      <td class="num amt-neutral">${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-edit-entry="${key}|${e.id}" title="Edit">✎</button><button class="icon-btn" data-del-entry="${key}|${e.id}" title="Delete">✕</button></span></td>
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
      <td class="type-cell"><span class="tag cashpayment">Cash spend</span></td>
      <td class="desc-cell">
        <strong>${escapeHtml(e.description)}</strong>${e.tag ? ` <span class="src-badge">${escapeHtml(e.tag)}</span>` : ''}${metaHtml}
        <div class="subnote">Physical cash spent — already accounted for via withdrawal</div>
        ${lentChips ? `<div class="chip-row">${lentChips}</div>` : ''}
      </td>
      <td class="num amt-neutral">${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-edit-entry="${key}|${e.id}" title="Edit">✎</button><button class="icon-btn" data-del-entry="${key}|${e.id}" title="Delete">✕</button></span></td>
    </tr>`;
  }
  if (e.type === 'income') {
    return `<tr>
      ${dateCell}
      <td class="type-cell"><span class="tag income">Income</span></td>
      <td class="desc-cell"><strong>${escapeHtml(e.description)}</strong>${e.category ? ` <span class="src-badge">${escapeHtml(e.category)}</span>` : ''}</td>
      <td class="num amt-credit">+${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-edit-entry="${key}|${e.id}" title="Edit">✎</button><button class="icon-btn" data-del-entry="${key}|${e.id}" title="Delete">✕</button></span></td>
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
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-del-entry="${key}|${e.id}" title="Delete">✕</button></span></td>
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
          <button class="icon-btn" data-edit-entry="${key}|${e.id}" title="Edit">✎</button>
          <button class="icon-btn" data-del-entry="${key}|${e.id}" title="Delete">✕</button>
        </span>
      </td>
    </tr>`;
  }
  if (e.type === 'investment') {
    return `<tr>
      ${dateCell}
      <td class="type-cell"><span class="tag invest">Investment</span></td>
      <td class="desc-cell"><strong>${escapeHtml(e.description)}</strong></td>
      <td class="num amt-debit">-${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-edit-entry="${key}|${e.id}" title="Edit">✎</button><button class="icon-btn" data-del-entry="${key}|${e.id}" title="Delete">✕</button></span></td>
    </tr>`;
  }
  return '';
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
      <div class="form-row">
        <div class="field" id="f-card-wrap" style="display:none;">
          <label>Card being paid off</label>
          <select id="f-card">${cardOptions || '<option value="">No cards added</option>'}</select>
        </div>
        <div id="f-tag-row" style="display:contents;">
          ${renderTagField()}
        </div>
        <div id="spend-dynamic-fields" style="display:contents;"></div>
      </div>
      <div id="f-price-track-wrap" style="margin-bottom: 14px;">
        <button class="pill-btn sub-pill" id="f-price-track-btn" type="button">+ Add to Price Tracker</button>
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
      <div class="form-note" style="margin-top:0;margin-bottom:14px;"></div>
      <div class="form-row">
        <div class="field"><label>Spend</label><input id="f-desc" type="text" placeholder="e.g. Dinner out" /></div>
        <div class="field"><label>Amount (₹)</label><input id="f-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div class="field"><label>Date</label><input id="f-date" type="date" value="${todayStr()}" /></div>
      </div>
      <div class="form-row">
        <div class="field">
          <label>Card</label>
          <select id="f-card">${cardOptions || '<option value="">No cards added — add one first</option>'}</select>
        </div>
        <div id="f-tag-row" style="display:contents;">
          ${renderTagField()}
        </div>
      </div>
      <div id="f-price-track-wrap" style="margin-bottom: 14px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <button class="pill-btn sub-pill" id="f-price-track-btn" type="button">+ Add to Price Tracker</button>
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
      <div class="form-row">
        <div id="f-tag-row" style="display:contents;">
          ${renderTagField()}
        </div>
      </div>
      <div id="f-price-track-wrap" style="margin-bottom: 14px;">
        <button class="pill-btn sub-pill" id="f-price-track-btn" type="button">+ Add to Price Tracker</button>
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
    title: 'Recurring Expense', desc: 'Subscriptions, bills', tone: 'amber' 
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

const TXN_PRIMARY_ORDER = ['spend', 'income', 'cardcharge', 'cashpayment', 'recurring', 'invest'];
const TXN_MORE_ORDER = ['owed', 'emi'];

// On mobile, move cardcharge & cashpayment to the "More" section to reduce clutter
const TXN_PRIMARY_MOBILE = ['spend', 'cardcharge', 'income'];
const TXN_MORE_MOBILE = ['cashpayment', 'recurring', 'invest', 'owed', 'emi'];

function isMobileViewport() {
  return window.innerWidth < 640;
}

function getTxnPrimaryOrder() {
  return isMobileViewport() ? TXN_PRIMARY_MOBILE : TXN_PRIMARY_ORDER;
}

function getTxnMoreOrder() {
  return isMobileViewport() ? TXN_MORE_MOBILE : TXN_MORE_ORDER;
}

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
  const primaryOrder = getTxnPrimaryOrder();
  const moreOrder = getTxnMoreOrder();
  const primaryHtml = primaryOrder.map(renderTxnOptionCard).join('');
  const moreHtml = moreOrder.map(renderTxnOptionCard).join('');
  const isMobile = isMobileViewport();
  const moreToggleHtml = `
    <button class="txn-option-card txn-option-more" data-toggle-more type="button">
      <span class="txn-option-icon txn-option-icon--muted">⋯</span>
      <span class="txn-option-text">
        <span class="txn-option-title">${isMoreOpen ? 'Show less' : 'More…'}</span>
        <span class="txn-option-desc">${isMoreOpen ? 'Hide extra options' : isMobile ? 'Cash, invest & more' : 'Owed, EMI & more'}</span>
      </span>
    </button>`;

  return `
  <div class="add-entry-panel">
    <button class="add-entry-trigger ${isMenuOpen ? 'active' : ''}" id="add-entry-trigger" type="button" aria-expanded="${isMenuOpen}">
      <span class="add-entry-trigger-icon">+</span>
      <span class="add-entry-trigger-text">
        <span class="add-entry-trigger-title">Add transaction</span>
        <span class="add-entry-trigger-sub">Log any income, expense or payment</span>
      </span>
      <span class="add-entry-trigger-chevron">›</span>
    </button>
    ${isMenuOpen ? `
    <div class="txn-menu">
      <div class="txn-option-grid">
        ${primaryHtml}
        ${isMoreOpen ? moreHtml : ''}
        ${moreToggleHtml}
      </div>
      ${openForm ? `
      <div id="form-panel-anim-inner" class="${formSlideDirection || ''}">
        ${renderForm(openForm)}
      </div>` : ''}
    </div>` : ''}
  </div>`;
}


/* ---------- Main render ---------- */
async function renderMonth() {
  await loadDomain();

  // First-touch: mirrors the old openMonth()'s one-time carry/manual decision.
  await ensureMonthIndexed(monthKey, monthsIndex);
  const data = await loadMonth(monthKey);
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

  const allRows = [...data.entries].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
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

  const dateCounts = {};
  for (const e of allRows) dateCounts[e.date] = (dateCounts[e.date] || 0) + 1;
  const seenDates = new Set();
  const rowsHtml = allRows.map(e => {
    let isFirst = false;
    if (!seenDates.has(e.date)) { seenDates.add(e.date); isFirst = true; }
    return renderRow(e, monthKey, dateCounts[e.date], isFirst);
  }).join('');

  const emiCardsHtml = emiRows.length ? `<div class="emi-list" style="margin-bottom: 20px;">` + emiRows.map(e => {
    const totalBill = e.amount * e.totalMonths;
    const totalPaid = e.amount * e.installment;
    const left = e.totalMonths - e.installment;
    return `
    <div class="emi-card">
      <div>
        <h4><span class="tag emi">EMI</span> ${escapeHtml(e.description)}</h4>
        <div class="emi-stats">
          Instalment ${e.installment}/${e.totalMonths}(${left} left) <span style="opacity:0.5; margin:0 4px;"></span></br>Paid ${fmtINR(totalPaid)} of ${fmtINR(totalBill)}
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 16px;">
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
              <h4 style="margin-bottom: 6px; font-weight: 600; color: var(--navy); font-family: 'Fraunces', serif; font-size: 1.05rem; display: flex; flex-direction: column; align-items: flex-start; gap: 6px;">
                <span style="word-break: break-word;">${escapeHtml(e.description)}</span>
                <span style="display: inline-flex; gap: 4px; align-items: center; flex-shrink: 0;">
                  <span class="src-badge ${cat.cls}">${cat.label}</span>
                  <span class="src-badge sip">SIP</span>
                </span>
              </h4>
              <div class="emi-stats" style="font-size: 0.8rem; color: var(--muted); font-family: 'IBM Plex Mono', monospace;">
                Next deduction: ${dayNum}${ordinalSuffix(dayNum)}
              </div>
            </div>
          </div>
          <div class="month-sip-card-footer">
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
          <h4 style="margin-bottom: 6px; font-weight: 600; color: var(--navy); font-family: 'Fraunces', serif; font-size: 1.05rem; display: flex; flex-direction: column; align-items: flex-start; gap: 6px;">
            <span style="word-break: break-word;">${escapeHtml(e.description)}</span>
            <span style="display: inline-flex; gap: 4px; align-items: center; flex-shrink: 0;">
              <span class="src-badge" style="background: ${modeBadgeBg}; color: ${modeBadgeColor};">${modeBadge}</span>
              <span class="src-badge" style="background: #FCE8E6; color: #B0556F;">RECURRING</span>
            </span>
          </h4>
          <div class="emi-stats" style="font-size: 0.8rem; color: var(--muted); font-family: 'IBM Plex Mono', monospace;">
            Next deduction: ${dayNum}${ordinalSuffix(dayNum)} via ${escapeHtml(modeText)}
          </div>
        </div>
      </div>
      <div class="month-sip-card-footer">
        <div class="num recurring-card" style="font-size: 1.15rem; font-weight: 600; color: var(--blue);">
          -${fmtINR(e.amount)}
        </div>
        <button class="icon-btn" data-popover-trigger data-skip-recurring="${monthKey}|${e.seriesId}" title="Skip this month" style="background: var(--ice-2); border-radius: 8px; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; transition: all 0.2s ease;">
          ⤵
        </button>
      </div>
    </div>`;
  }).join('') + `</div>` : '';

  let unsettledConsumptionLent = 0, settledConsumptionLent = 0;
  for (const e of data.entries) {
    if (!Array.isArray(e.lent)) continue;
    if (e.type === 'spend' || e.type === 'cardcharge' || e.type === 'cashpayment') {
      unsettledConsumptionLent += e.lent.reduce((s, l) => !l.settled ? s + (Number(l.amount) || 0) : s, 0);
      // Settled lent has been paid back — deduct it entirely, it's no
      // longer part of this month's spend at all (personal or lent).
      settledConsumptionLent += e.lent.reduce((s, l) => l.settled ? s + (Number(l.amount) || 0) : s, 0);
    }
  }
  const emiTotal = monthTotals.emi || 0;
  // Personal spend = total consumption minus unsettled lent minus EMI.
  // Settled lent is explicitly deducted from the spend's amount when checked,
  // so totalConsumption only contains Personal + Unsettled.
  const rawPersonalExpense = Math.max(0, monthTotals.totalConsumption - unsettledConsumptionLent - emiTotal);

  // Split-page balances aren't tied to any one month's entries — they're a
  // live, running "who owes who" ledger — so we only fold them into the
  // month that's actually current. Viewing a past month shouldn't have
  // today's split debts injected into its historical chart.
  let splitOwedToYou = 0;
  if (monthKey === currentMonthKey()) {
    const { owedToYou } = await computeSplitPageData(false, null, splitsIndex);
    splitOwedToYou = Object.values(owedToYou).reduce((s, v) => s + (Number(v) || 0), 0);
  }
  // The owed amount is money already inside this month's spend, not new
  // spend on top of it — carve it out of personal (never past zero) and
  // move it into the lent segment so the overall Expense total is unchanged.
  const splitCarve = Math.min(splitOwedToYou, rawPersonalExpense);
  const personalExpense = rawPersonalExpense - splitCarve;
  const lentSegmentValue = unsettledConsumptionLent + splitOwedToYou;

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
    <div class="section-title"><h2>Add an entry</h2><span class="hint">Log every credit and debit</span></div>
    ${renderAddEntryPanel()}
  </div>
  <div class="section">
    <div class="section-title"><h2>This month's finances, at a glance</h2><span class="hint">Hover a card for the breakdown</span></div>
    ${renderStatCards(stats)}
  </div>
  <div class="section">
    <div class="section-title"><h2>This month's charts</h2><span class="hint">${monthKeyLabel(monthKey)} only</span></div>
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
        ${barChart([
          { label: 'Income', value: monthTotals.income, color: 'var(--credit)' },
          {
            label: 'Expense',
            segments: [
              { label: 'Personal', value: personalExpense, color: 'var(--debit)' },
              { label: 'Lent (unsettled)', value: lentSegmentValue, color: '#E03131' },
            ],
          },
          ...(emiTotal > 0 ? [{ label: 'EMI', value: emiTotal, color: '#5B4B9E' }] : []),
          { label: 'Invested', value: monthTotals.invest + monthTotals.sip, color: 'var(--blue)' },
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
      <div style="grid-column: 1 / -1; margin-top: 8px;">
        <h3 style="font-size: 1.15rem; margin-bottom: 12px; font-weight: 600; font-family: 'Fraunces', serif;">Spends by Tags</h3>
        ${(() => {
          const TAG_WIDE_THRESHOLD = 5;
          const tagCharts = [
            { title: 'Debit by tag', data: tagsBarChart(data.entries, 'spend', { splitAdjustment: splitOwedToYou, splitTagName: 'Split' }) },
            { title: 'Credit card spends by tag', data: tagsBarChart(data.entries, 'cardcharge') },
            { title: 'Cash spends by tag', data: tagsBarChart(data.entries, 'cashpayment') },
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
    <div class="section-title"><h2>Transactions</h2><span class="hint">${allRows.length} entries</span></div>
    ${emiCardsHtml}
    <div class="table-wrap">
      <table ${allRows.length ? '' : 'style="width: 100%;"'}>
        <thead><tr><th>Date</th><th class="type-cell">Type</th><th>Details</th><th class="table-numeric">Amount</th><th></th></tr></thead>
        <tbody>
          ${allRows.length ? rowsHtml : `<tr class="empty-row"><td colspan="5">No entries yet — add your first spend or income above.</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>
  ${sipRows.length ? `
  <div class="section">
    <div class="section-title" style="margin-bottom: 8px;">
      <h2>SIPs</h2>
      <span class="hint">${sipRows.length} running this month</span>
    </div>
    ${sipFilterHtml}
    ${sipCardsHtml}
  </div>` : ''}
  ${recurringRows.length ? `
  <div class="section">
    <div class="section-title"><h2>Recurring Expenses</h2><span class="hint">${recurringRows.length} deducted this month</span></div>
    ${recurringCardsHtml}
  </div>` : ''}
  `;

  appendPageChrome(root);
  setupScrollWrappers(root);
  setupTableScrollIndicators(root);
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
    data.entries.push({ id: uid(), type: 'spend', description: spendDesc, amount, date, paymentMode: mode, cardId, tag, lent: collectLent(), meta });
 } else if (kind === 'cardcharge') {
    if (!desc || !amount || amount <= 0) { showToast('Enter a spend description and amount'); return; }
    const cardId = $('#f-card').value;
    const c = cardById(cards, cardId);
    if (!c) { showToast('Add a credit card first'); return; }
    const tag = await resolveTagFromForm();
    await syncToPriceTracker(desc, amount, date, tag);
    data.entries.push({ id: uid(), type: 'cardcharge', description: desc, amount, date, cardId, tag, lent: collectLent() });
  } else if (kind === 'cashpayment') {
    if (!desc || !amount || amount <= 0) { showToast('Enter a spend description and amount'); return; }
    const tag = await resolveTagFromForm();
    await syncToPriceTracker(desc, amount, date, tag);
    data.entries.push({ id: uid(), type: 'cashpayment', description: desc, amount, date, tag, lent: collectLent() });
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
    data.entries.push({ id: uid(), type: 'investment', description: desc, amount, date });
  } else if (kind === 'emi') {
    const months = Number($('#f-months')?.value);
    const startMonth = $('#f-emi-start')?.value || monthKey;
    if (!desc || !amount || amount <= 0 || !months || months < 1) { showToast('Fill in description, amount and number of months'); return; }
    const elapsed = diffMonths(startMonth, currentMonthKey());
    if (elapsed >= months) { showToast('Invalid: EMI is already complete based on the starting month.'); return; }
    emiSeries.push({ id: uid(), description: desc, monthlyAmount: amount, totalMonths: months, startMonth });
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
    isMenuOpen = false;
    isMoreOpen = false;
    await renderMonth();
    showToast(`Recurring spend will be deducted on the ${dayOfMonth}${ordinalSuffix(dayOfMonth)} of every month`);
    return;
  }

  await saveMonth(monthKey);
  openForm = null;
  isMenuOpen = false;
  isMoreOpen = false;
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
  const addEntryTrigger = ev.target.closest('#add-entry-trigger');
  if (addEntryTrigger) {
    if (animTimeout) clearTimeout(animTimeout);
    isMenuOpen = !isMenuOpen;
    if (!isMenuOpen) { openForm = null; isMoreOpen = false; }
    formSlideDirection = '';
    await renderMonth();
    return;
  }

  const toggleMoreBtn = ev.target.closest('[data-toggle-more]');
  if (toggleMoreBtn) {
    isMoreOpen = !isMoreOpen;
    await renderMonth();
    return;
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
    if (animTimeout) clearTimeout(animTimeout);
    if (oldForm === newForm) { openForm = null; await renderMonth(); return; }
    if (oldForm) {
      // Get indices from the visual menu order (primary + more), dynamically based on viewport
      const primaryOrder = getTxnPrimaryOrder();
      const moreOrder = getTxnMoreOrder();
      const allTxnOrder = [...primaryOrder, ...moreOrder];
      const oldIdx = allTxnOrder.indexOf(oldForm);
      const newIdx = allTxnOrder.indexOf(newForm);
      const isRight = newIdx > oldIdx;
      const inner = $('#form-panel-anim-inner');
      if (inner) {
        inner.className = isRight ? 'slide-out-left' : 'slide-out-right';
        animTimeout = setTimeout(async () => { openForm = newForm; formSlideDirection = isRight ? 'slide-in-right' : 'slide-in-left'; await renderMonth(); }, 300);
      } else { openForm = newForm; formSlideDirection = ''; await renderMonth(); }
      return;
    }
    openForm = newForm; formSlideDirection = '';
    await renderMonth();
    return;
  }

  const closeForm = ev.target.closest('[data-close-form]');
  if (closeForm) {
    if (animTimeout) clearTimeout(animTimeout);
    openForm = null;
    await renderMonth();
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
    const descStrong = tr.querySelector('.desc-cell strong');
    const amountTd = tr.querySelector('td.num:not(.dv-date)');
    const actionsSpan = tr.querySelector('.row-actions');

    descStrong.innerHTML = `<input type="text" class="inline-edit-desc" value="${escapeHtml(entryToEdit.description)}" style="width: 100%; padding: 4px 6px; border: 1px solid var(--sky); border-radius: 4px; font-family: inherit; font-size: 0.9rem;" />`;
    amountTd.innerHTML = `<input type="number" step="0.01" class="inline-edit-amount" value="${entryToEdit.amount}" style="width: 85px; padding: 4px 6px; border: 1px solid var(--sky); border-radius: 4px; font-family: inherit; font-size: 0.9rem;" />`;
    
    actionsSpan.innerHTML = `
      <button class="icon-btn" data-save-entry="${mk}|${id}" title="Save" style="color: var(--credit);">✓</button>
      <button class="icon-btn" data-cancel-edit title="Cancel" style="color: var(--debit);">✕</button>
    `;
    
    tr.querySelector('.inline-edit-desc').focus();
    return;
  }

  const saveEntry = ev.target.closest('[data-save-entry]');
  if (saveEntry) {
    const [mk, id] = saveEntry.dataset.saveEntry.split('|');
    const tr = saveEntry.closest('tr');
    const newDesc = tr.querySelector('.inline-edit-desc').value.trim();
    const newAmt = Number(tr.querySelector('.inline-edit-amount').value);

    if (!newDesc || isNaN(newAmt) || newAmt <= 0) {
      showToast("Invalid description or amount.");
      return;
    }

    const data = await loadMonth(mk);
    const entryToEdit = data.entries.find(e => e.id === id);
    if (entryToEdit) {
      entryToEdit.description = newDesc;
      entryToEdit.amount = newAmt;
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
      // Payback entry into the already-loaded month data if it lands on
      // the page we're viewing, then re-render immediately. The actual
      // PUT(s) to the backend happen afterwards, in the background, so
      // the click never waits on a network round trip.
      const paybackId = uid();
      const paybackKey = currentMonthKey();
      const paybackEntry = {
        id: paybackId,
        type: 'payback',
        description: `Payback @${entry.description} (${l.person})`,
        amount: Number(l.amount) || 0,
        date: todayStr(),
        linkedLent: { spendMonthKey: monthKey, spendId: entry.id, lentId: l.id },
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
          console.error('Failed to persist payback', err);
          showToast('Saved locally but failed to sync — check your connection');
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
          pe.type === 'payback' && pe.linkedLent &&
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
                pe.type === 'payback' && pe.linkedLent &&
                pe.linkedLent.spendId === entry.id && pe.linkedLent.lentId === l.id
              ));
              if (pbData.entries.length !== before) { await saveMonth(sk); break; }
            }
          }
        } catch (err) {
          console.error('Failed to persist undo', err);
          showToast('Saved locally but failed to sync — check your connection');
        }
      })();
    }
    return;
  }
});

root.addEventListener('change', async (ev) => {
  if (ev.target.id === 'f-tag') {
    const val = ev.target.value.toLowerCase();
    const customWrap = $('#f-tag-custom-wrap');
    if (customWrap) customWrap.style.display = val === '__custom__' ? 'block' : 'none';

    const ptDynamicWrap = $('#pt-dynamic-fields');
    if (ptDynamicWrap) {
      if (val === 'groceries') ptDynamicWrap.innerHTML = `<div class="field"><label>Quantity</label><input id="pt-quantity" type="text" placeholder="e.g. 1kg or 1L" /></div>`;
      else if (val === 'transport') ptDynamicWrap.innerHTML = `<div class="field"><label>Source</label><input id="pt-source" type="text" placeholder="e.g. Home" /></div><div class="field"><label>Destination</label><input id="pt-destination" type="text" placeholder="e.g. Office" /></div>`;
      else if (val === 'fuel') ptDynamicWrap.innerHTML = `<div class="field"><label>Quantity</label><input id="pt-quantity" type="text" placeholder="e.g. 5L" /></div><div class="field"><label>Location</label><input id="pt-location" type="text" placeholder="e.g. IOCL Bengaluru" /></div>`;
      else if (val === 'rent') ptDynamicWrap.innerHTML = `<div class="field"><label>Location</label><input id="pt-location" type="text" placeholder="e.g. Sunflower Heights Whitefield" /></div>`;
      else ptDynamicWrap.innerHTML = '';
    }

    const spendDynamicWrap = $('#spend-dynamic-fields');
    if (spendDynamicWrap) {
      if (val === 'groceries') spendDynamicWrap.innerHTML = `<div class="field"><label>Quantity</label><input id="sp-quantity" type="text" placeholder="e.g. 1kg or 1L" /></div>`;
      else if (val === 'transport') spendDynamicWrap.innerHTML = `<div class="field"><label>Source</label><input id="sp-source" type="text" placeholder="e.g. Home" /></div><div class="field"><label>Destination</label><input id="sp-destination" type="text" placeholder="e.g. Office" /></div>`;
      else if (val === 'fuel') spendDynamicWrap.innerHTML = `<div class="field"><label>Quantity</label><input id="sp-quantity" type="text" placeholder="e.g. 5L" /></div><div class="field"><label>Location</label><input id="sp-location" type="text" placeholder="e.g. IOCL Bengaluru" /></div>`;
      else if (val === 'rent') spendDynamicWrap.innerHTML = `<div class="field"><label>Location</label><input id="sp-location" type="text" placeholder="e.g. Sunflower Heights Whitefield" /></div>`;
      else spendDynamicWrap.innerHTML = '';
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
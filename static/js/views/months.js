/* ---------- /months ---------- */
import { Store } from '../core/store.js';
import { escapeHtml } from '../core/dom.js';
import { fmtINR, fmtINRShort, monthKeyLabel, monthKeyShort } from '../core/format.js';
import { authReady } from '../core/auth.js';
import { emiRowsForMonth, sipRowsForMonth, computeMonthTotals, allSpendTags } from '../core/domain.js';
import { setupScrollWrappers, setupTableScrollIndicators } from '../components/scroll-wrapper.js';
import { showDeleteCallout, hideDeleteCallout, wireDeletePopoverDismiss } from '../components/delete-popover.js';
import { appendPageChrome } from '../components/page-chrome.js';
import { showToast } from '../components/toast.js';
import { markRendered } from '../components/render-guard.js';

const root = document.getElementById('months-root');
const DEFAULT_TAGS = ['Groceries', 'Dining', 'Food', 'Fuel', 'Subscription', 'Rent', 'Utility', 'Recharge', 'Transport', 'Gift'];

let monthsIndex = [];
let emiSeries = [];
let sipSeries = [];
let customTags = [];
let domainLoaded = false;
let bulkDataCache = null;
let chartRangeMonths = 6;
let selectedTag = '';

// Fetched once per page load; deleteMonth() mutates monthsIndex in memory
// and persists it, so later re-renders never need to refetch it.
async function loadDomain() {
  if (domainLoaded) return;
  [monthsIndex, emiSeries, sipSeries, customTags] = await Promise.all([
    Store.get('months-index', []),
    Store.get('emiseries', []),
    Store.get('sipseries', []),
    Store.get('custom-spend-tags', []),
  ]);
  domainLoaded = true;
}

async function deleteMonth(key) {
  monthsIndex = monthsIndex.filter(k => k !== key);
  await Store.set('months-index', monthsIndex);
  
  // Wipe from the new SessionStorage cache so the UI doesn't resurrect it
  sessionStorage.removeItem('month:' + key);
  if (bulkDataCache) delete bulkDataCache['month:' + key];
  
  await Store.set('month:' + key, { startingBalanceMode: 'manual', startingBalance: 0, entries: [], deletedEmi: [] });
  await Store.remove('month:' + key);
}

// ---------------------------------------------------------
// NEW: Localized, bulk-fetch optimized breakdown calculator
// This entirely replaces the imported domain.js version that 
// was causing the N+1 network queries.
// ---------------------------------------------------------
function computeMonthlyBreakdownFromBulk(keysAscending, bulkData) {
  const rows = [];
  let prevEnding = null;

  for (const k of keysAscending) {
    // Read strictly from our pre-fetched bulk object
    const data = bulkData['month:' + k] || { startingBalanceMode: 'manual', startingBalance: 0, entries: [], deletedEmi: [], deletedSip: [] };

    if (!data.startingBalanceMode) data.startingBalanceMode = 'manual';
    if (!data.deletedSip) data.deletedSip = [];

    const emiRows = emiRowsForMonth(emiSeries, k, data.deletedEmi);
    const sipRows = sipRowsForMonth(sipSeries, k, data.deletedSip);
    const totals = computeMonthTotals(data.entries.concat(emiRows, sipRows));

    let starting;
    if (data.startingBalanceMode === 'auto' && prevEnding !== null) {
      starting = prevEnding;
    } else {
      starting = Number(data.startingBalance) || 0;
    }

    const outflow = totals.cashSpend + totals.cardPaymentSpend + totals.emi + totals.invest + totals.sip;
    const ending = starting + totals.income - outflow;
    
    rows.push({ monthKey: k, starting, income: totals.income, outflow, ending, totals });
    prevEnding = ending;
  }
  return rows;
}

function monthKeysForChartRange(n) {
  const cur = currentMonthKey();
  const keys = [];
  for (let i = n - 1; i >= 0; i--) keys.push(addMonths(cur, -i));
  return keys;
}

// Union of every tag actually used across all loaded months, merged with
// DEFAULT_TAGS + customTags — same dedupe rule used elsewhere in the app.
function collectTagOptions(bulkData, keys) {
  const found = [];
  for (const k of keys) {
    const data = bulkData['month:' + k];
    if (!data || !data.entries) continue;
    for (const e of data.entries) {
      if (CHART_SPEND_TYPES.includes(e.type) && e.tag) found.push(e.tag);
    }
  }
  return allSpendTags([...DEFAULT_TAGS, ...found], customTags);
}

function computeTagSeries(bulkData, keys, tag) {
  return keys.map(k => {
    const data = bulkData['month:' + k];
    let total = 0;
    if (data && data.entries) {
      for (const e of data.entries) {
        if (CHART_SPEND_TYPES.includes(e.type) && e.tag === tag) total += Number(e.amount) || 0;
      }
    }
    return { key: k, value: total };
  });
}

function renderTagBarChart(series, tag) {
  const totalSum = series.reduce((s, p) => s + p.value, 0);
  if (totalSum === 0) {
    return `<div class="empty-chart">No spends tagged under "${escapeHtml(tag)}" in this period.</div>`;
  }
  const max = Math.max(1, ...series.map(p => p.value));
  const cols = series.map(p => `
    <div class="bar-col">
      <div class="bval num">${fmtINRShort(p.value)}</div>
      <div class="bar" style="height:${Math.max(4, (p.value / max * 140))}px; background: var(--blue);"></div>
      <div class="blabel">${monthKeyShort(p.key)}</div>
    </div>`).join('');
  return `<div class="bars">${cols}</div>`;
}

function renderMonthlyChartsSection(bulkData, allMonthKeys) {
  const tagOptions = collectTagOptions(bulkData, allMonthKeys);
  if (!selectedTag || !tagOptions.includes(selectedTag)) selectedTag = tagOptions[0] || '';

  const rangeKeys = monthKeysForChartRange(chartRangeMonths);
  const series = selectedTag ? computeTagSeries(bulkData, rangeKeys, selectedTag) : [];
  const chartHtml = selectedTag
    ? renderTagBarChart(series, selectedTag)
    : `<div class="empty-chart">Add a tagged spend to see this chart.</div>`;

  const optionsHtml = tagOptions
    .map(t => `<option value="${escapeHtml(t)}" ${t === selectedTag ? 'selected' : ''}>${escapeHtml(t)}</option>`)
    .join('');

  return `
  <div class="section">
    <div class="section-title"><h2>Monthly Charts</h2><span class="hint">Tag spend over time</span></div>
    <div class="chart-card">
      <div class="chart-toolbar chart-toolbar--split">
        <div style="display:flex; flex-wrap: wrap; gap: 8px; justify-content: space-between;">
          <select id="tag-chart-select" class="tag-select" ${tagOptions.length ? '' : 'disabled'}>${optionsHtml}</select>
          <div class="range-toggle">
            <button class="range-btn ${chartRangeMonths === 6 ? 'active' : ''}" data-chart-range="6" type="button">6M</button>
            <button class="range-btn ${chartRangeMonths === 9 ? 'active' : ''}" data-chart-range="9" type="button">9M</button>
            <button class="range-btn ${chartRangeMonths === 12 ? 'active' : ''}" data-chart-range="12" type="button">1Y</button>
          </div>
        </div>
      </div>
      ${chartHtml}
    </div>
  </div>`;
}

// Re-renders only the chart card from data already cached in memory —
// no Store.get/bulkGet call, so range/tag switches never hit the network.
function refreshChartSection() {
  const container = document.getElementById('monthly-charts-section');
  if (!container || !lastBulkData) return;
  container.innerHTML = renderMonthlyChartsSection(lastBulkData, allMonthKeysAsc);
}

async function renderMonths() {
  await loadDomain();
  
  const keysDesc = [...monthsIndex].sort().reverse();
  const keysAsc = [...monthsIndex].sort(); // Required for chronological carry-over math
  
  // 1. Perform ONE bulk fetch for every month in the index and cache it
  if (!bulkDataCache) {
    const keysToFetch = keysDesc.map(k => 'month:' + k);
    const result = await Store.bulkGet(keysToFetch);
    if (result) {
      bulkDataCache = result;
    }
    // else: leave bulkDataCache null so the next renderMonths() call retries
  }
  const bulkData = bulkDataCache || {};

  // 2. Compute the breakdown entirely from memory
  const breakdown = computeMonthlyBreakdownFromBulk(keysAsc, bulkData);
  const byKey = Object.fromEntries(breakdown.map(b => [b.monthKey, b]));

  let rows = '';
  for (const k of keysDesc) {
    // 3. Render rows entirely from memory, avoiding individual network calls
    const data = bulkData['month:' + k] || { entries: [] };
    const b = byKey[k] || { ending: 0 };
    
    rows += `
      <a class="month-row" href="/month/${k}">
        <div>
          <div class="mr-name">${monthKeyLabel(k)}</div>
          <div class="mr-sub">${data.entries.length} ${data.entries.length === 1 ? 'entry' : 'entries'} logged</div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px;">
          <div class="mr-val num" style="color:${b.ending >= 0 ? 'var(--navy)' : 'var(--debit)'}">${fmtINR(b.ending)}</div>
          <button class="icon-btn" data-popover-trigger data-del-month="${k}" title="Delete month" type="button">✕</button>
        </div>
      </a>`;
  }
  
  if (!rows) rows = `<div class="empty-chart">No months recorded yet. Add your first month from the home screen.</div>`;

  let chartHtml = '';
  if (keysAsc.length > 0) {
      const tags = allSpendTags(DEFAULT_TAGS, customTags);
      if (!selectedTag && tags.length) selectedTag = tags[0];

      const latestMonth = keysAsc[keysAsc.length - 1];
      const [ly, lm] = latestMonth.split('-').map(Number);
      const rangeKeys = [];
      for (let i = chartRangeMonths - 1; i >= 0; i--) {
          let y = ly, m = lm - i;
          while (m <= 0) { m += 12; y -= 1; }
          rangeKeys.push(`${y}-${String(m).padStart(2, '0')}`);
      }

      let totalRangeSpend = 0;
      const pairs = rangeKeys.map(k => {
          const data = bulkData['month:' + k] || { entries: [] };
          let sum = 0;
          for (const e of data.entries) {
              if (['spend', 'cardcharge', 'cashpayment'].includes(e.type)) {
                  const t = (e.tag || 'Untagged').trim().toLowerCase();
                  if (t === selectedTag.toLowerCase()) sum += (Number(e.amount) || 0);
              }
          }
          totalRangeSpend += sum;
          return { label: monthKeyShort(k), value: sum, color: 'var(--blue)' };
      });

      const tagOptions = tags.map(t => `<option value="${escapeHtml(t)}" ${t.toLowerCase() === selectedTag.toLowerCase() ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');

      let chartContent = `<div class="empty-chart">No spends tagged under "${escapeHtml(selectedTag)}" in this period.</div>`;
      if (totalRangeSpend > 0) {
          const maxVal = Math.max(1, ...pairs.map(p => p.value));
          const cols = pairs.map(p => `
            <div class="bar-col">
              <div class="bval num" style="font-size: 0.68rem;">${fmtINRShort(p.value)}</div>
              <div class="bar" style="height:${Math.max(4, (p.value / maxVal * 130))}px; background:${p.color};"></div>
              <div class="blabel">${p.label}</div>
            </div>`).join('');
          chartContent = `<div class="bars">${cols}</div>`;
      }

      chartHtml = `
      <div class="section-title"><h2>Monthly Charts</h2><span class="hint">Tag spending over time</span></div>
      <div class="chart-card">
        <div class="chart-toolbar" style="gap: 8px; flex-wrap: nowrap; align-items: stretch;">
          <select id="tag-chart-select" style="padding: 4px 12px; border: 1px solid var(--hair); border-radius: 999px; background: var(--ice-2); font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; color: var(--muted); cursor: pointer; outline: none; flex: 1 1 0%; min-width: 0; max-width: 200px; text-overflow: ellipsis; white-space: nowrap; overflow: hidden;">
            ${tagOptions}
          </select>
          <div class="range-toggle" style="flex-shrink: 0; margin: 0;">
            <button class="range-btn ${chartRangeMonths === 6 ? 'active' : ''}" data-tag-range="6" type="button">6M</button>
            <button class="range-btn ${chartRangeMonths === 9 ? 'active' : ''}" data-tag-range="9" type="button">9M</button>
            <button class="range-btn ${chartRangeMonths === 12 ? 'active' : ''}" data-tag-range="12" type="button">1Y</button>
          </div>
        </div>
        ${chartContent}
      </div>`;
  }

  const tb = document.getElementById('global-topbar');
  if (tb) tb.style.display = '';

  markRendered(root);
  root.innerHTML = `
  <div class="section">
    <div class="section-title"><h2>Previous months</h2><span class="hint">Tap a month to open it</span></div>
    <div class="months-list">${rows}</div>
  </div>
  <div class="section">
    ${chartHtml}
  </div>
  `;

  appendPageChrome(root);
  setupScrollWrappers(root);
  setupTableScrollIndicators(root);
}

root.addEventListener('change', async (ev) => {
  if (ev.target.id === 'tag-chart-select') {
    selectedTag = ev.target.value;
    await renderMonths();
  }
});

root.addEventListener('click', async (ev) => {
  const rangeBtn = ev.target.closest('[data-tag-range]');
  if (rangeBtn) {
    chartRangeMonths = Number(rangeBtn.dataset.tagRange);
    await renderMonths();
    return;
  }

  const delMonthBtn = ev.target.closest('[data-del-month]');
  if (delMonthBtn) {
    ev.preventDefault();
    ev.stopPropagation();
    showDeleteCallout(delMonthBtn, 'confirm-del-month', delMonthBtn.dataset.delMonth);
    return;
  }
  
  const confirmDelMonth = ev.target.closest('[data-confirm-del-month]');
  if (confirmDelMonth) {
    ev.preventDefault();
    ev.stopPropagation();
    const key = confirmDelMonth.dataset.confirmDelMonth;
    const label = monthKeyLabel(key);
    await deleteMonth(key);
    hideDeleteCallout();
    await renderMonths();
    showToast(`${label} deleted`);
  }
});

wireDeletePopoverDismiss(root);

root.addEventListener('change', (ev) => {
  const tagSelect = ev.target.closest('#tag-chart-select');
  if (tagSelect) {
    selectedTag = tagSelect.value;
    refreshChartSection();
  }
});

window.addEventListener('auth:signed-in', () => { bulkDataCache = null; renderMonths(); });
window.addEventListener('auth:checked', renderMonths);

// Wait for the first /api/auth/me round trip so we never flash the
// signed-out login hero for an already-authenticated visitor.
authReady.then(renderMonths);
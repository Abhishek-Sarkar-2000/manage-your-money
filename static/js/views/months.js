/* ---------- /months ---------- */
import { Store } from '../core/store.js';
import { escapeHtml } from '../core/dom.js';
import { fmtINR, fmtINRShort, monthKeyLabel, monthKeyShort, currentMonthKey, addMonths, todayStr } from '../core/format.js';
import { authReady } from '../core/auth.js';
import { emiRowsForMonth, sipRowsForMonth, recurringRowsForMonth, computeMonthTotals, allSpendTags } from '../core/domain.js';
import { SPLIT_PALETTE } from '../components/charts/split-charts.js';
import { wireChartTooltips } from '../components/charts/line-chart.js';
import { setupScrollWrappers, setupTableScrollIndicators } from '../components/scroll-wrapper.js';
import { showDeleteCallout, hideDeleteCallout, wireDeletePopoverDismiss } from '../components/delete-popover.js';
import { appendPageChrome } from '../components/page-chrome.js';
import { showToast } from '../components/toast.js';
import { markRendered } from '../components/render-guard.js';

const root = document.getElementById('months-root');
const DEFAULT_TAGS = ['Groceries', 'Dining', 'Food', 'Fuel', 'Transport', 'Rent', 'Utility', 'Shopping', 'Recharge', 'Medicine', 'Gift', 'EMI', 'SIP', 'RECURRING'];

let monthsIndex = [];
let emiSeries = [];
let sipSeries = [];
let recurringSeries = [];
let customTags = [];
let domainLoaded = false;
let bulkDataCache = null;
let chartRangeMonths = 6;
let selectedTags = [];
let currentKeysAsc = [];

// Fetched once per page load; deleteMonth() mutates monthsIndex in memory
// and persists it, so later re-renders never need to refetch it.
async function loadDomain() {
  if (domainLoaded) return;
  [monthsIndex, emiSeries, sipSeries, recurringSeries, customTags] = await Promise.all([
    Store.get('months-index', []),
    Store.get('emiseries', []),
    Store.get('sipseries', []),
    Store.get('recurringseries', []),
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
    if (!data.deletedRecurring) data.deletedRecurring = [];

    const emiRows = emiRowsForMonth(emiSeries, k, data.deletedEmi).filter(r => r.date <= todayStr());
    const sipRows = sipRowsForMonth(sipSeries, k, data.deletedSip).filter(r => r.date <= todayStr());
    const recurringRows = recurringRowsForMonth(recurringSeries, k, data.deletedRecurring).filter(r => r.date <= todayStr());
    const totals = computeMonthTotals(data.entries.concat(emiRows, sipRows, recurringRows));

    let starting;
    if (data.startingBalanceMode === 'auto' && prevEnding !== null) {
      starting = prevEnding;
    } else {
      starting = Number(data.startingBalance) || 0;
    }

    const outflow = totals.cashSpend + totals.cardPaymentSpend + totals.emi + totals.invest + totals.sip + totals.recurring;
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

function collectTagOptions(bulkData, keys) {
  const found = [];
  for (const k of keys) {
    const data = bulkData['month:' + k];
    if (!data || !data.entries) continue;
    for (const e of data.entries) {
      if (['spend', 'cardcharge', 'cashpayment'].includes(e.type) && e.tag) found.push(e.tag);
    }
  }
  return allSpendTags([...DEFAULT_TAGS, ...found], customTags);
}

function renderMonthlyChartsSection(bulkData, allMonthKeys) {
  const tagOptions = collectTagOptions(bulkData, allMonthKeys);
  const rangeKeys = monthKeysForChartRange(chartRangeMonths);
  
  let chartContent = `<div class="empty-chart">Select a tag to view the chart.</div>`;
  if (selectedTags.length > 0) {
      let maxVal = 0;
      const monthDataList = rangeKeys.map(k => {
          const data = bulkData['month:' + k] || { entries: [], deletedEmi: [], deletedSip: [], deletedRecurring: [] };
          const allRows = data.entries.concat(
                  emiRowsForMonth(emiSeries, k, data.deletedEmi).filter(r => r.date <= todayStr()),
                  sipRowsForMonth(sipSeries, k, data.deletedSip).filter(r => r.date <= todayStr()),
                  recurringRowsForMonth(recurringSeries, k, data.deletedRecurring).filter(r => r.date <= todayStr())
          );
          let monthTotal = 0;
          const tagSums = {};
          selectedTags.forEach(t => tagSums[t] = 0);

          for (const e of allRows) {
              let tagValue = null;
              if (['spend', 'cardcharge', 'cashpayment'].includes(e.type)) {
                  tagValue = (e.tag || 'Untagged').trim();
              } else if (e.type === 'emi') {
                  tagValue = 'EMI';
              } else if (e.type === 'sip') {
                  tagValue = 'SIP';
              } else if (e.type === 'recurring') {
                  tagValue = 'RECURRING';
              }

              if (tagValue) {
                  const matchedTag = selectedTags.find(st => st.toLowerCase() === tagValue.toLowerCase());
                  if (matchedTag) {
                      const amt = Number(e.amount) || 0;
                      tagSums[matchedTag] += amt;
                      monthTotal += amt;
                  }
              }
          }
          
          monthTotal = Math.max(0, monthTotal);
          selectedTags.forEach(t => tagSums[t] = Math.max(0, tagSums[t]));

          if (monthTotal > maxVal) maxVal = monthTotal;
          return { label: monthKeyShort(k), monthTotal, tagSums };
      });

      if (maxVal === 0) {
          chartContent = `<div class="empty-chart">No spends found for the selected tags in this period.</div>`;
      } else {
          const cols = monthDataList.map(md => {
              const colHeightRatio = maxVal > 0 ? (md.monthTotal / maxVal) : 0;
              
              const segmentsHtml = selectedTags.map((tag, i) => {
                  const val = md.tagSums[tag];
                  if (val <= 0) return '';
                  const color = SPLIT_PALETTE[i % SPLIT_PALETTE.length];
                  const segmentHeightPct = (val / md.monthTotal) * 100;
                  return `<div class="stacked-segment" data-val="${fmtINR(val)}" data-label="${escapeHtml(tag)}" style="height: ${segmentHeightPct}%; background: ${color}; width: 100%; transition: opacity 0.15s ease;"></div>`;
              }).join('');

              return `
              <div class="bar-col">
                <div class="bval num" style="font-size: 0.68rem;">${fmtINRShort(md.monthTotal)}</div>
                <div class="bar stacked-bar" style="height:${Math.max(4, colHeightRatio * 130)}px; background: transparent; display: flex; flex-direction: column-reverse; justify-content: flex-start; overflow: hidden; border-radius: 6px 6px 0 0;">
                  ${segmentsHtml}
                </div>
                <div class="blabel">${md.label}</div>
              </div>`;
          }).join('');

          const legendHtml = selectedTags.map((tag, i) => {
            const color = SPLIT_PALETTE[i % SPLIT_PALETTE.length];
            return `<div class="shared-chart-legend-item"><span class="shared-chart-legend-dot" style="background:${color};"></span><span>${escapeHtml(tag)}</span></div>`;
          }).join('');

          chartContent = `
            <div class="bars">${cols}</div>
            <div class="shared-chart-legend" style="border-top: none; margin-top: 40px; padding-top: 0;">${legendHtml}</div>
          `;
      }
  }

  const optionsHtml = tagOptions
    .map(t => `<option value="${escapeHtml(t)}" ${selectedTags.includes(t) ? 'disabled' : ''}>${escapeHtml(t)}</option>`)
    .join('');
    
  const pillsHtml = selectedTags.length ? `<div class="pill-grid" style="margin-top: 12px; margin-bottom: 4px;">${selectedTags.map(t => `<div class="pill-btn sub-pill active chart-tag-pill">${escapeHtml(t)} <button class="icon-btn chart-tag-remove" data-remove-tag="${escapeHtml(t)}" aria-label="Remove tag">✕</button></div>`).join('')}</div>` : '';

  return `
  <div class="section-title"><h2>Monthly Charts</h2><span class="hint">Tag spend over time</span></div>
  <div class="chart-card">
    <div class="chart-toolbar chart-toolbar--split">
      <div style="display:flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; width: 100%;">
        <select id="tag-chart-select" class="tag-select" style="min-width: 180px;" ${tagOptions.length ? '' : 'disabled'}>
          <option value="" disabled selected>Add a tag...</option>
          ${optionsHtml}
        </select>
        <div class="range-toggle">
          <button class="range-btn ${chartRangeMonths === 6 ? 'active' : ''}" data-chart-range="6" type="button">6M</button>
          <button class="range-btn ${chartRangeMonths === 9 ? 'active' : ''}" data-chart-range="9" type="button">9M</button>
          <button class="range-btn ${chartRangeMonths === 12 ? 'active' : ''}" data-chart-range="12" type="button">1Y</button>
        </div>
      </div>
    </div>
    ${pillsHtml}
    ${chartContent}
  </div>`;
}

// Re-renders only the chart card from data already cached in memory —
// no Store.get/bulkGet call, so range/tag switches never hit the network.
function refreshChartSection() {
  const container = document.getElementById('monthly-charts-section');
  if (!container || !bulkDataCache) return;
  container.innerHTML = renderMonthlyChartsSection(bulkDataCache, currentKeysAsc);
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
  currentKeysAsc = keysAsc;
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
      chartHtml = `
      <div id="monthly-charts-section" class="section">
        ${renderMonthlyChartsSection(bulkData, keysAsc)}
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
  ${chartHtml}
  `;

  appendPageChrome(root);
  setupScrollWrappers(root);
  setupTableScrollIndicators(root);
}

root.addEventListener('click', async (ev) => {
  const rangeBtn = ev.target.closest('[data-chart-range]');
  if (rangeBtn) {
    chartRangeMonths = Number(rangeBtn.dataset.chartRange);
    refreshChartSection();
    return;
  }
  
  const removeTagBtn = ev.target.closest('[data-remove-tag]');
  if (removeTagBtn) {
    const tag = removeTagBtn.dataset.removeTag;
    selectedTags = selectedTags.filter(t => t !== tag);
    refreshChartSection();
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
    const val = tagSelect.value;
    if (val && !selectedTags.includes(val)) {
        selectedTags.push(val);
        refreshChartSection();
    }
    tagSelect.value = '';
  }
});

window.addEventListener('auth:signed-in', () => { bulkDataCache = null; renderMonths(); });
window.addEventListener('auth:checked', renderMonths);

// Wait for the first /api/auth/me round trip so we never flash the
// signed-out login hero for an already-authenticated visitor.
authReady.then(renderMonths);
wireChartTooltips(root);
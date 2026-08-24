/* ---------- /months ---------- */
import { Store } from '../core/store.js';
import { fmtINR, monthKeyLabel } from '../core/format.js';
import { currentUser, authReady } from '../core/auth.js';
import { emiRowsForMonth, sipRowsForMonth, computeMonthTotals } from '../core/domain.js';
import { setupScrollWrappers, setupTableScrollIndicators } from '../components/scroll-wrapper.js';
import { showDeleteCallout, hideDeleteCallout, wireDeletePopoverDismiss } from '../components/delete-popover.js';
import { mountLoginHero } from '../components/login-hero.js';
import { appendPageChrome } from '../components/page-chrome.js';
import { showToast } from '../components/toast.js';
import { markRendered } from '../components/render-guard.js';

const root = document.getElementById('months-root');
let monthsIndex = [];
let emiSeries = [];
let sipSeries = [];
let domainLoaded = false;

// Fetched once per page load; deleteMonth() mutates monthsIndex in memory
// and persists it, so later re-renders never need to refetch it.
async function loadDomain() {
  if (domainLoaded) return;
  [monthsIndex, emiSeries, sipSeries] = await Promise.all([
    Store.get('months-index', []),
    Store.get('emiseries', []),
    Store.get('sipseries', []),
  ]);
  domainLoaded = true;
}

async function deleteMonth(key) {
  monthsIndex = monthsIndex.filter(k => k !== key);
  await Store.set('months-index', monthsIndex);
  
  // Wipe from the new SessionStorage cache so the UI doesn't resurrect it
  sessionStorage.removeItem('month:' + key);
  
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

async function renderMonths() {
  if (!currentUser) {
    markRendered(root);
    mountLoginHero(root);
    return;
  }

  await loadDomain();
  
  const keysDesc = [...monthsIndex].sort().reverse();
  const keysAsc = [...monthsIndex].sort(); // Required for chronological carry-over math
  
  // 1. Perform ONE bulk fetch for every month in the index
  const keysToFetch = keysDesc.map(k => 'month:' + k);
  const bulkData = await Store.bulkGet(keysToFetch);

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
          <div class="mr-val num" style="color:${b.ending >= 0 ? 'var(--credit)' : 'var(--debit)'}">${fmtINR(b.ending)}</div>
          <button class="icon-btn" data-popover-trigger data-del-month="${k}" title="Delete month" type="button">✕</button>
        </div>
      </a>`;
  }
  
  if (!rows) rows = `<div class="empty-chart">No months recorded yet. Add your first month from the home screen.</div>`;

  markRendered(root);
  root.innerHTML = `
  <div class="topbar">
    <a class="brand" href="/home"><span class="mark">₹</span> LedgerNote</a>
  </div>
  <div class="section">
    <div class="section-title"><h2>Previous months</h2><span class="hint">Tap a month to open it</span></div>
    <div class="months-list">${rows}</div>
  </div>
  `;

  appendPageChrome(root);
  setupScrollWrappers(root);
  setupTableScrollIndicators(root);
}

root.addEventListener('click', async (ev) => {
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
window.addEventListener('auth:signed-in', renderMonths);
window.addEventListener('auth:checked', renderMonths);

// Wait for the first /api/auth/me round trip so we never flash the
// signed-out login hero for an already-authenticated visitor.
authReady.then(renderMonths);
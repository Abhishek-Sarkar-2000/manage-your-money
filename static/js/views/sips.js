/* ---------- /sips ---------- */
import { Store } from '../core/store.js';
import { $, uid, escapeHtml } from '../core/dom.js';
import { fmtINR, monthKeyLabel, currentMonthKey } from '../core/format.js';
import { authReady } from '../core/auth.js';
import { appendPageChrome } from '../components/page-chrome.js';
import { showToast } from '../components/toast.js';
import { showDeleteCallout, hideDeleteCallout, wireDeletePopoverDismiss } from '../components/delete-popover.js';
import { markRendered } from '../components/render-guard.js';

const root = document.getElementById('sips-root');
let sipSeries = [];
let existingInvestments = 0;
let domainLoaded = false;

async function renderSips() {
  if (!domainLoaded) {
    [sipSeries, existingInvestments] = await Promise.all([
      Store.get('sipseries', []),
      Store.get('existinginvestments', 0),
    ]);
    domainLoaded = true;
  }

  const rows = sipSeries.map(s => `
    <div class="cc-item">
      <div>
        <div class="cc-name">${escapeHtml(s.description)}</div>
        <div class="cc-cycle">${fmtINR(s.amount)} / month · deducted on the ${s.dayOfMonth || 1}${ordinalSuffix(s.dayOfMonth || 1)} · started ${monthKeyLabel(s.startMonth)}</div>
      </div>
      <button class="icon-btn" data-popover-trigger data-del-sip-series="${s.id}" title="Delete SIP">✕</button>
    </div>
  `).join('') || `<div class="empty-chart">No SIPs added yet — add one below.</div>`;

  const tb = document.getElementById('global-topbar');
  if (tb) tb.style.display = '';

  markRendered(root);
  root.innerHTML = `
  <div class="section">
    <div class="card">
      <div class="section-title"><h2>Existing Investments</h2><span class="hint">Base portfolio built prior to this ledger</span></div>
      <div class="form-panel" style="margin-top:0;">
        <div class="form-row" style="align-items: end;">
          <div class="field"><label>Total Existing Amount (₹)</label><input id="ext-invest-amount" type="number" step="0.01" min="0" value="${existingInvestments || 0}" /></div>
          <div class="form-actions" style="margin-top:0; margin-bottom:2px;"><button class="btn" id="ext-invest-save">Save Amount</button></div>
        </div>
        <div class="form-note" style="margin-top:8px; margin-bottom:0; border:none;">This amount serves as your base and will be dynamically added to your total investments along with manual entries and SIPs.</div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="card">
      <div class="section-title"><h2>SIPs</h2><span class="hint">Recurring investments, tracked every month automatically</span></div>
        <div class="cc-list">${rows}</div>
        <div class="form-panel">
          <div class="form-note" style="margin-top:0;">Starts this month (${monthKeyLabel(currentMonthKey())}) and recurs every month until you delete it.</div>
          <div class="form-row">
            <div class="field"><label>Description</label><input id="sip-desc" type="text" placeholder="e.g. Nifty Index Fund" /></div>
            <div class="field"><label>Amount (₹ / month)</label><input id="sip-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
            <div class="field"><label>Date of deduction</label><input id="sip-day" type="number" step="1" min="1" max="31" placeholder="e.g. 5" /></div>
          </div>
          <div class="form-actions"><button class="btn" id="sip-add">Add SIP</button></div>
        </div>
    </div>
  </div>
  `;

  appendPageChrome(root);
}

root.addEventListener('click', async (ev) => {
  const extInvestSaveBtn = ev.target.closest('#ext-invest-save');
  if (extInvestSaveBtn) {
    existingInvestments = Number($('#ext-invest-amount')?.value) || 0;
    await Store.set('existinginvestments', existingInvestments);
    await renderSips();
    showToast('Base investment amount saved');
    return;
  }
  const addSip = ev.target.closest('#sip-add');
  if (addSip) {
    ev.preventDefault(); // Prevents page refresh
    const desc = $('#sip-desc').value.trim();
    const amount = Number($('#sip-amount').value);
    const dayOfMonth = Number($('#sip-day').value);
    if (!desc || !amount || amount <= 0 || !dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31) { showToast('Enter details, a valid amount and a date of deduction (1-31)'); return; }
    sipSeries.push({ id: uid(), description: desc, amount, dayOfMonth, startMonth: currentMonthKey() });
    await Store.set('sipseries', sipSeries);
    await renderSips();
    showToast(`SIP will be deducted on the ${dayOfMonth}${ordinalSuffix(dayOfMonth)} of every month`);
  }
  const delSipSeriesBtn = ev.target.closest('[data-del-sip-series]');
  if (delSipSeriesBtn) {
    ev.stopPropagation();
    showDeleteCallout(delSipSeriesBtn, 'confirm-del-sip-series', delSipSeriesBtn.dataset.delSipSeries);
    return;
  }
  const confirmDelSipSeries = ev.target.closest('[data-confirm-del-sip-series]');
  if (confirmDelSipSeries) {
    ev.stopPropagation();
    const seriesId = confirmDelSipSeries.dataset.confirmDelSipSeries;
    sipSeries = sipSeries.filter(s => s.id !== seriesId);
    await Store.set('sipseries', sipSeries);
    hideDeleteCallout();
    await renderSips();
    showToast('SIP deleted entirely');
  }
});

wireDeletePopoverDismiss(root);
window.addEventListener('auth:signed-in', renderSips);
window.addEventListener('auth:checked', renderSips);
// Wait for the first /api/auth/me round trip so we never flash the
// signed-out login hero for an already-authenticated visitor.
authReady.then(renderSips);

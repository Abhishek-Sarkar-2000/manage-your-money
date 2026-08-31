/* ---------- /subscriptions ---------- */
import { Store } from '../core/store.js';
import { $, uid, escapeHtml } from '../core/dom.js';
import { fmtINR, ordinalSuffix, currentMonthKey } from '../core/format.js';
import { authReady } from '../core/auth.js';
import { appendPageChrome } from '../components/page-chrome.js';
import { showToast } from '../components/toast.js';
import { showDeleteCallout, hideDeleteCallout, wireDeletePopoverDismiss } from '../components/delete-popover.js';
import { markRendered } from '../components/render-guard.js';

const root = document.getElementById('subscriptions-root');
let recurringSeries = [];
let cards = [];
let domainLoaded = false;

async function renderSubscriptions() {
  if (!domainLoaded) {
    const [rs, c] = await Promise.all([
      Store.get('recurringseries', []),
      Store.get('creditcards', [])
    ]);
    recurringSeries = rs;
    cards = c;
    domainLoaded = true;
  }

  const cardOptions = cards.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');

  const rows = recurringSeries.map(s => {
    let modeText = 'Bank Transfer';
    if (s.paymentMode === 'card') {
      const c = cards.find(card => card.id === s.cardId);
      modeText = c ? c.name : 'Credit Card';
    }
    return `
    <div class="cc-item">
      <div>
        <div class="cc-name">${escapeHtml(s.description)}</div>
        <div class="cc-cycle">${fmtINR(s.amount)} / month · deducted on the ${s.dayOfMonth}${ordinalSuffix(s.dayOfMonth)} via ${escapeHtml(modeText)}</div>
      </div>
      <button class="icon-btn" data-popover-trigger data-del-recurring-series="${s.id}" title="Delete recurring expense">✕</button>
    </div>
    `;
  }).join('') || `<div class="empty-chart">No recurring expenses added yet — add one below.</div>`;

  const tb = document.getElementById('global-topbar');
  if (tb) tb.style.display = '';

  markRendered(root);
  root.innerHTML = `
  <div class="section">
    <div class="card">
      <div class="section-title"><h2>Recurring Expenses</h2><span class="hint">Bills and subscriptions, auto-deducted every month automatically</span></div>
        <div class="cc-list">${rows}</div>
        <div class="form-panel">
          <div class="form-note" style="margin-top:0;">Deducted every month on the date you choose — clamped to the last day of the month when it doesn't have that many days.</div>
          
          <div class="pill-grid" style="margin-bottom: 12px;" id="sub-mode-selector">
            <button class="pill-btn sub-pill active" data-sub-mode="bank" type="button">Bank Transfer</button>
            <button class="pill-btn sub-pill" data-sub-mode="card" type="button" ${cards.length ? '' : 'disabled'}>Credit Card</button>
          </div>

          <div class="form-row">
            <div class="field"><label>Details</label><input id="recurring-desc" type="text" placeholder="e.g. Netflix" /></div>
            <div class="field"><label>Amount (₹ / month)</label><input id="recurring-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
            <div class="field"><label>Date of deduction</label><input id="recurring-day" type="number" step="1" min="1" max="31" placeholder="e.g. 5" /></div>
          </div>
          
          <div class="form-row" id="sub-card-row" style="display:none;">
            <div class="field">
              <label>Card</label>
              <select id="recurring-card">${cardOptions || '<option value="">No cards added</option>'}</select>
            </div>
          </div>
          
          <div class="form-actions"><button class="btn" id="recurring-add">Add Recurring Expense</button></div>
        </div>
    </div>
  </div>
  `;

  appendPageChrome(root);
}

root.addEventListener('click', async (ev) => {
  const subModeBtn = ev.target.closest('[data-sub-mode]');
  if (subModeBtn) {
    if (subModeBtn.disabled) return;
    const wrap = subModeBtn.closest('#sub-mode-selector');
    wrap.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
    subModeBtn.classList.add('active');

    const mode = subModeBtn.dataset.subMode;
    const cardRow = $('#sub-card-row');
    if (mode === 'card') {
      if (cardRow) cardRow.style.display = 'contents';
    } else {
      if (cardRow) cardRow.style.display = 'none';
    }
    return;
  }

  const addRecurring = ev.target.closest('#recurring-add');
  if (addRecurring) {
    ev.preventDefault(); // Prevents page refresh
    const desc = $('#recurring-desc').value.trim();
    const amount = Number($('#recurring-amount').value);
    const dayOfMonth = Number($('#recurring-day').value);
    if (!desc || !amount || amount <= 0 || !dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31) { showToast('Enter details, a valid amount and a date of deduction (1-31)'); return; }
    
    const modeBtn = document.querySelector('[data-sub-mode].active');
    const paymentMode = modeBtn ? modeBtn.dataset.subMode : 'bank';
    let cardId = null;
    if (paymentMode === 'card') {
      cardId = $('#recurring-card').value;
      if (!cardId) { showToast('Add a credit card first'); return; }
    }

    recurringSeries.push({ id: uid(), description: desc, amount, dayOfMonth, paymentMode, cardId, startMonth: currentMonthKey() });
    await Store.set('recurringseries', recurringSeries);
    await renderSubscriptions();
    showToast(`Recurring spend will be deducted on the ${dayOfMonth}${ordinalSuffix(dayOfMonth)} of every month`);
    return;
  }
  const delRecurringSeriesBtn = ev.target.closest('[data-del-recurring-series]');
  if (delRecurringSeriesBtn) {
    ev.stopPropagation();
    showDeleteCallout(delRecurringSeriesBtn, 'confirm-del-recurring-series', delRecurringSeriesBtn.dataset.delRecurringSeries);
    return;
  }
  const confirmDelRecurringSeries = ev.target.closest('[data-confirm-del-recurring-series]');
  if (confirmDelRecurringSeries) {
    ev.stopPropagation();
    const seriesId = confirmDelRecurringSeries.dataset.confirmDelRecurringSeries;
    recurringSeries = recurringSeries.filter(s => s.id !== seriesId);
    await Store.set('recurringseries', recurringSeries);
    hideDeleteCallout();
    await renderSubscriptions();
    showToast('Recurring expense deleted entirely');
  }
});

wireDeletePopoverDismiss(root);
window.addEventListener('auth:signed-in', renderSubscriptions);
window.addEventListener('auth:checked', renderSubscriptions);
// Wait for the first /api/auth/me round trip so we never flash the
// signed-out login hero for an already-authenticated visitor.
authReady.then(renderSubscriptions);
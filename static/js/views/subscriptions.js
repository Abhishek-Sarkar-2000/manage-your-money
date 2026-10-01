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

const deleteBinSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>`;

let recurringSeries = [];
let cards = [];
let domainLoaded = false;
let recurringAddPending = false;
let editingRecurringId = null;

async function renderSubscriptions() {
  if (!domainLoaded) {
    const records = await Store.bulkGet(['recurringseries', 'creditcards'], {});
    recurringSeries = records.recurringseries || [];
    cards = records.creditcards || [];
    domainLoaded = true;
  }

  const editData = editingRecurringId
    ? recurringSeries.find(s => s.id === editingRecurringId)
    : null;

  const cardOptions = cards.map(c =>
    `<option value="${c.id}" ${editData?.cardId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
  ).join('');

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
      <div style="display:flex; align-items:center; gap:4px;">
        <button class="icon-btn" data-edit-recurring-series="${s.id}" title="Edit recurring expense" type="button">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
        </button>
        <button class="icon-btn" data-popover-trigger data-del-recurring-series="${s.id}" title="Delete recurring expense" type="button">${deleteBinSvg}</button>
      </div>
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
            <button class="pill-btn sub-pill ${!editData || editData.paymentMode !== 'card' ? 'active' : ''}" data-sub-mode="bank" type="button">Bank Transfer</button>
            <button class="pill-btn sub-pill ${editData?.paymentMode === 'card' ? 'active' : ''}" data-sub-mode="card" type="button" ${cards.length ? '' : 'disabled'}>Credit Card</button>
          </div>

          <div class="form-row">
            <div class="field"><label>Details</label><input id="recurring-desc" type="text" placeholder="e.g. Netflix" value="${editData ? escapeHtml(editData.description) : ''}" /></div>
            <div class="field"><label>Amount (₹ / month)</label><input id="recurring-amount" type="number" step="0.01" min="0" placeholder="0.00" value="${editData ? editData.amount : ''}" /></div>
            <div class="field"><label>Date of deduction</label><input id="recurring-day" type="number" step="1" min="1" max="31" placeholder="e.g. 5" value="${editData ? editData.dayOfMonth : ''}" /></div>
          </div>
          
          <div class="form-row" id="sub-card-row" style="${editData?.paymentMode === 'card' ? 'display:contents;' : 'display:none;'}">
            <div class="field">
              <label>Card</label>
              <select id="recurring-card">${cardOptions || '<option value="">No cards added</option>'}</select>
            </div>
          </div>
          
          <div class="form-actions">
            <button class="btn" id="recurring-add">${editData ? 'Save Changes' : 'Add Recurring Expense'}</button>
            ${editData ? '<button class="btn ghost" id="recurring-edit-cancel" type="button">Cancel</button>' : ''}
          </div>
        </div>
    </div>
  </div>
  `;

  appendPageChrome(root);
}

root.addEventListener('click', async (ev) => {
  const editRecurring = ev.target.closest('[data-edit-recurring-series]');
  if (editRecurring) {
    editingRecurringId = editRecurring.dataset.editRecurringSeries;
    await renderSubscriptions();

    const form = root.querySelector('.form-panel');
    if (form) {
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return;
  }

  if (ev.target.closest('#recurring-edit-cancel')) {
    editingRecurringId = null;
    await renderSubscriptions();
    return;
  }

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
    ev.preventDefault();
    if (recurringAddPending) return;

    const desc = $('#recurring-desc').value.trim();
    const amount = Number($('#recurring-amount').value);
    const dayOfMonth = Number($('#recurring-day').value);
    if (!desc || !amount || amount <= 0 || !dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31) {
      showToast('Enter details, a valid amount and a date of deduction (1-31)');
      return;
    }

    const modeBtn = document.querySelector('[data-sub-mode].active');
    const paymentMode = modeBtn ? modeBtn.dataset.subMode : 'bank';
    let cardId = null;
    if (paymentMode === 'card') {
      cardId = $('#recurring-card').value;
      if (!cardId) {
        showToast('Add a credit card first');
        return;
      }
    }

    recurringAddPending = true;
    addRecurring.disabled = true;

    try {
      if (editingRecurringId) {
        const recurring = recurringSeries.find(
          s => s.id === editingRecurringId
        );

        if (recurring) {
          recurring.description = desc;
          recurring.amount = amount;
          recurring.dayOfMonth = dayOfMonth;
          recurring.paymentMode = paymentMode;
          recurring.cardId = cardId;
        }

        editingRecurringId = null;
        await Store.set('recurringseries', recurringSeries);
        await renderSubscriptions();
        showToast('Recurring expense updated');
      } else {
        recurringSeries.push({
          id: uid(),
          description: desc,
          amount,
          dayOfMonth,
          paymentMode,
          cardId,
          startMonth: currentMonthKey()
        });

        await Store.set('recurringseries', recurringSeries);
        await renderSubscriptions();
        showToast(`Recurring spend will be deducted on the ${dayOfMonth}${ordinalSuffix(dayOfMonth)} of every month`);
      }
    } finally {
      recurringAddPending = false;
      addRecurring.disabled = false;
    }
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
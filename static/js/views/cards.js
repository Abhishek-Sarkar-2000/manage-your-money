/* ---------- /cards ---------- */
import { Store } from '../core/store.js';
import { $, uid, escapeHtml } from '../core/dom.js';
import { ordinalSuffix, fmtINR, addMonths } from '../core/format.js';
import {
  creditCardCycleLedger,
  creditCardCurrentStatementMonthKey,
  setCreditCardCycleSettled
} from '../core/domain.js';
import { authReady } from '../core/auth.js';
import { appendPageChrome } from '../components/page-chrome.js';
import { showToast } from '../components/toast.js';
import { markRendered } from '../components/render-guard.js';

const root = document.getElementById('cards-root');
let cards = [];
let recurringSeries = [];
let domainLoaded = false;
let editingCardId = null;
let selectedCardId = null;
let selectedCycleView = 'current';

function formatCardDate(dateStr) {
  if (!dateStr) return '—';

  const dt = new Date(`${dateStr}T00:00:00`);
  const day = dt.toLocaleDateString('en-IN', { day: '2-digit' });
  const month = dt.toLocaleDateString('en-IN', { month: 'short' });
  const weekday = dt.toLocaleDateString('en-IN', { weekday: 'short' });

  return `
    <div class="dv-date-badge cc-ledger-date-badge">
      <div class="dv-date-top">
        <strong class="dv-date-day">${day}</strong>
        <span class="dv-date-month">${month}</span>
      </div>
      <div class="dv-date-weekday">${weekday}</div>
    </div>
  `;
}

function formatCardFullDate(dateStr) {
  if (!dateStr) return '—';

  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function renderCardStatementExplorer(selectedCard, ledger) {
  if (!cards.length) {
    return `
      <div class="card cc-ledger-card">
        <div class="section-title">
          <div>
            <h2>Card transactions</h2>
            <span class="hint">Add a credit card to inspect its billing cycles.</span>
          </div>
        </div>
        <div class="empty-chart">No credit cards available.</div>
      </div>
    `;
  }

  const selectorOptions = cards.map(card =>
    `<option value="${card.id}" ${card.id === selectedCardId ? 'selected' : ''}>${escapeHtml(card.name)}</option>`
  ).join('');

  if (!selectedCard || !ledger) {
    return `
      <div class="card cc-ledger-card">
        <div class="empty-chart">Select a card to inspect its billing cycle.</div>
      </div>
    `;
  }

  const transactionRows = ledger.transactions.map(entry => `
    <tr>
      <td class="cc-ledger-date">${formatCardDate(entry.date)}</td>
      <td>
        <div class="cc-ledger-description">${escapeHtml(entry.description)}</div>
        ${entry.tag ? `<div class="cc-ledger-tag">${escapeHtml(entry.tag)}</div>` : ''}
      </td>
      <td class="cc-ledger-amount">${fmtINR(entry.amount)}</td>
    </tr>
  `).join('');

  const settlementControl = selectedCycleView === 'last'
    ? `
      <div class="cc-settlement-panel ${ledger.fullySettled ? 'is-settled' : ''}">
        <div class="cc-settlement-copy">
          <strong>Fully settled</strong>
          <span>Use this when the statement was completely cleared outside the recorded Month entries, such as an unlogged payment or cashback adjustment. Transaction history and spending remain unchanged.</span>
        </div>
        <label class="cc-settle-switch">
          <input type="checkbox" data-cycle-settled="${ledger.cycleEnd}" ${ledger.fullySettled ? 'checked' : ''} />
          <span class="cc-settle-slider"></span>
        </label>
      </div>
    `
    : '';

  return `
    <div class="card cc-ledger-card">
      <div class="cc-ledger-heading">
        <div>
          <div class="section-title cc-ledger-title">
            <h2>Card transactions</h2>
            <span class="hint">Review charges exactly as they appear inside each statement cycle</span>
          </div>
        </div>
      </div>

      <div class="cc-ledger-toolbar">
        <div class="field cc-ledger-card-select">
          <label>Credit card</label>
          <select data-card-ledger-select>
            ${selectorOptions}
          </select>
        </div>

        <div class="cc-cycle-toggle" role="group" aria-label="Billing cycle">
          <button type="button" data-cycle-view="last" class="${selectedCycleView === 'last' ? 'active' : ''}">Last billing cycle</button>
          <button type="button" data-cycle-view="current" class="${selectedCycleView === 'current' ? 'active' : ''}">Current billing cycle</button>
        </div>
      </div>

      <div class="cc-ledger-cycle-strip">
        <div>
          <span class="cc-ledger-eyebrow">${selectedCycleView === 'last' ? 'Previous statement' : 'Active statement cycle'}</span>
          <strong>${formatCardFullDate(ledger.cycleStart)} – ${formatCardFullDate(ledger.cycleEnd)}</strong>
        </div>
        <div class="cc-ledger-due-copy">
          <span>Payment due</span>
          <strong>${formatCardFullDate(ledger.dueDate)}</strong>
        </div>
      </div>

      <div class="cc-ledger-summary">
        <div class="cc-ledger-stat">
          <span>Cycle spend</span>
          <strong>${fmtINR(ledger.grossAmount)}</strong>
          <small>Gross card activity</small>
        </div>
        <div class="cc-ledger-stat ${ledger.fullySettled ? 'settled' : ''}">
          <span>Outstanding due</span>
          <strong>${fmtINR(ledger.dueAmount)}</strong>
          <small>${ledger.fullySettled ? 'Marked fully settled' : 'Statement liability'}</small>
        </div>
        <div class="cc-ledger-stat">
          <span>Transactions</span>
          <strong>${ledger.transactions.length}</strong>
          <small>In this billing cycle</small>
        </div>
        <div class="cc-ledger-stat">
          <span>Statement closes</span>
          <strong>${formatCardDate(ledger.cycleEnd)}</strong>
          <small>${selectedCycleView === 'current' ? `Activity through ${formatCardFullDate(ledger.effectiveEnd)}` : 'Completed cycle'}</small>
        </div>
      </div>

      ${settlementControl}

      <div class="cc-ledger-table-wrap">
        <table class="cc-ledger-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Transaction</th>
              <th class="cc-ledger-amount">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${transactionRows || `<tr><td colspan="3" class="cc-ledger-empty">No card transactions recorded in this billing cycle.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function renderCards() {
  // Fetched once; add/delete mutate `cards` in memory and persist it, so
  // later re-renders reuse the in-memory array instead of refetching.
  if (!domainLoaded) {
    [cards, recurringSeries] = await Promise.all([
      Store.get('creditcards', []),
      Store.get('recurringseries', []),
    ]);

    let migrated = false;
    cards = cards.map(card => {
      const rawDueDay = Number(card.dueDay);
      if (Number.isInteger(rawDueDay) && rawDueDay >= 1 && rawDueDay <= 31) return card;

      migrated = true;
      return { ...card, dueDay: 1 };
    });

    if (migrated) await Store.set('creditcards', cards);
    selectedCardId = cards[0]?.id || null;
    domainLoaded = true;
  }

  if (selectedCardId && !cards.some(card => card.id === selectedCardId)) {
    selectedCardId = cards[0]?.id || null;
  } else if (!selectedCardId && cards.length) {
    selectedCardId = cards[0].id;
  }

  const selectedCard = cards.find(card => card.id === selectedCardId) || null;
  let ledger = null;

  if (selectedCard) {
    const currentStatementMonth = creditCardCurrentStatementMonthKey(selectedCard);
    const statementMonth = selectedCycleView === 'last'
      ? addMonths(currentStatementMonth, -1)
      : currentStatementMonth;

    ledger = await creditCardCycleLedger(
      selectedCard,
      recurringSeries,
      statementMonth
    );
  }

  const rows = cards.map(c => {
    const isEditing = editingCardId === c.id;

    return `
      <div class="cc-item ${isEditing ? 'editing' : ''}" data-card-id="${c.id}">
        <div class="cc-item-summary">
          <div>
            <div class="cc-name">${escapeHtml(c.name)}</div>
            <div class="cc-cycle">Billing date: ${c.billingDay}${ordinalSuffix(c.billingDay)} · Due date: ${c.dueDay}${ordinalSuffix(c.dueDay)}</div>
          </div>
          <button class="icon-btn cc-edit-chevron ${isEditing ? 'expanded' : ''}" data-edit-card="${c.id}" type="button" aria-expanded="${isEditing}" title="${isEditing ? 'Close editor' : 'Edit card'}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
          </button>
        </div>

        ${isEditing ? `
          <div class="cc-card-editor">
            <div class="form-row">
              <div class="field"><label>Card description</label><input class="cc-edit-name" type="text" value="${escapeHtml(c.name)}" /></div>
              <div class="field"><label>Billing date</label><input class="cc-edit-billing" type="number" min="1" max="31" value="${c.billingDay}" /></div>
              <div class="field"><label>Due date</label><input class="cc-edit-due" type="number" min="1" max="31" value="${c.dueDay}" /></div>
            </div>
            <div class="form-actions">
              <button class="btn primary" data-save-card="${c.id}" type="button">Save</button>
              <button class="btn ghost" data-popover-trigger data-del-card="${c.id}" type="button">Delete</button>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }).join('') || `<div class="empty-chart">No cards added yet — add one below.</div>`;

  const tb = document.getElementById('global-topbar');
  if (tb) tb.style.display = '';

  markRendered(root);
  root.innerHTML = `
  <div class="section">
    <div class="card">
      <div class="section-title"><h2>Credit cards</h2><span class="hint">Card charges and payments are tracked per card</span></div>
        <div class="cc-list">${rows}</div>
        <div class="form-panel">
          <div class="form-row">
            <div class="field"><label>Card description</label><input id="cc-name" type="text" placeholder="e.g. HDFC Regalia" /></div>
            <div class="field"><label>Billing cycle (day of month bill is generated)</label><input id="cc-day" type="number" min="1" max="31" placeholder="e.g. 18" /></div>
            <div class="field"><label>Due date (day of month payment is due)</label><input id="cc-due-day" type="number" min="1" max="31" value="1" /></div>
          </div>
          <div class="form-actions"><button class="btn" id="cc-add">Add card</button></div>
        </div>
    </div>

    ${renderCardStatementExplorer(selectedCard, ledger)}
  </div>
  `;

  appendPageChrome(root);
}

root.addEventListener('click', async (ev) => {
  const cycleView = ev.target.closest('[data-cycle-view]');
  if (cycleView) {
    selectedCycleView = cycleView.dataset.cycleView === 'last' ? 'last' : 'current';
    await renderCards();
    return;
  }

  const editCard = ev.target.closest('[data-edit-card]');
  if (editCard) {
    editingCardId = editingCardId === editCard.dataset.editCard ? null : editCard.dataset.editCard;
    await renderCards();
    return;
  }

  const saveCard = ev.target.closest('[data-save-card]');
  if (saveCard) {
    const card = cards.find(c => c.id === saveCard.dataset.saveCard);
    const editor = saveCard.closest('.cc-card-editor');
    if (!card || !editor) return;

    const name = editor.querySelector('.cc-edit-name').value.trim();
    const billingDay = Number(editor.querySelector('.cc-edit-billing').value);
    const dueDay = Number(editor.querySelector('.cc-edit-due').value);

    if (!name) {
      showToast('Enter a card name');
      return;
    }
    if (!Number.isInteger(billingDay) || billingDay < 1 || billingDay > 31) {
      showToast('Enter a valid billing day (1–31)');
      return;
    }
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
      showToast('Enter a valid due day (1–31)');
      return;
    }

    card.name = name;
    card.billingDay = billingDay;
    card.dueDay = dueDay;

    await Store.set('creditcards', cards);
    editingCardId = null;
    await renderCards();
    showToast('Card updated');
    return;
  }

  const delCard = ev.target.closest('[data-del-card]');
  if (delCard) {
    cards = cards.filter(c => c.id !== delCard.dataset.delCard);
    if (editingCardId === delCard.dataset.delCard) editingCardId = null;
    if (selectedCardId === delCard.dataset.delCard) selectedCardId = cards[0]?.id || null;
    await Store.set('creditcards', cards);
    await renderCards();
    showToast('Card removed');
    return;
  }
  const addCard = ev.target.closest('#cc-add');
  if (addCard) {
    const name = $('#cc-name').value.trim();
    const day = Number($('#cc-day').value);
    const dueDay = Number($('#cc-due-day').value);

    if (!name || !Number.isInteger(day) || day < 1 || day > 31) {
      showToast('Enter a card name and a valid billing day (1–31)');
      return;
    }
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
      showToast('Enter a valid due day (1–31)');
      return;
    }

    const card = { id: uid(), name, billingDay: day, dueDay };
    cards.push(card);
    if (!selectedCardId) selectedCardId = card.id;
    await Store.set('creditcards', cards);
    await renderCards();
    showToast('Card added');
  }
});

root.addEventListener('change', async (ev) => {
  if (ev.target.matches('[data-card-ledger-select]')) {
    selectedCardId = ev.target.value || null;
    selectedCycleView = 'current';
    await renderCards();
    return;
  }

  if (ev.target.matches('[data-cycle-settled]')) {
    const selectedCard = cards.find(card => card.id === selectedCardId);
    if (!selectedCard || selectedCycleView !== 'last') return;

    const cycleEnd = ev.target.dataset.cycleSettled;
    await setCreditCardCycleSettled(
      selectedCard.id,
      cycleEnd,
      ev.target.checked
    );

    await renderCards();
    showToast(ev.target.checked ? 'Statement marked fully settled' : 'Statement settlement reopened');
  }
});

window.addEventListener('auth:signed-in', renderCards);
window.addEventListener('auth:checked', renderCards);
// Wait for the first /api/auth/me round trip so we never flash the
// signed-out login hero for an already-authenticated visitor.
authReady.then(renderCards);

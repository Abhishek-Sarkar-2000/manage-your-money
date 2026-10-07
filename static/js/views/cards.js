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
import { showDeleteCallout, hideDeleteCallout, wireDeletePopoverDismiss } from '../components/delete-popover.js';
import { markRendered } from '../components/render-guard.js';

const root = document.getElementById('cards-root');
let cards = [];
let recurringSeries = [];
let emiSeries = [];
let domainLoaded = false;
let editingCardId = null;
let selectedCardId = null;
let selectedCycleView = 'current';
let pendingCardEnterId = null;

const cardsReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function beginCardsBusy(button, label = 'Saving…') {
  if (!button) return () => {};

  const originalHtml = button.innerHTML;
  const originalDisabled = button.disabled;
  const originalMinWidth = button.style.minWidth;
  const width = button.getBoundingClientRect().width;

  button.disabled = true;
  button.style.minWidth = `${Math.ceil(width)}px`;

  const timer = setTimeout(() => {
    if (!button.isConnected) return;
    button.classList.add('is-cards-busy');
    button.innerHTML = `<span class="cards-busy-spinner" aria-hidden="true"></span><span>${escapeHtml(label)}</span>`;
  }, 140);

  return () => {
    clearTimeout(timer);
    if (!button.isConnected) return;
    button.classList.remove('is-cards-busy');
    button.innerHTML = originalHtml;
    button.disabled = originalDisabled;
    button.style.minWidth = originalMinWidth;
  };
}

function animateCardRemoval(cardEl) {
  if (!cardEl || cardsReducedMotion.matches) return Promise.resolve();
  cardEl.classList.add('cc-item-removing');
  return new Promise(resolve => setTimeout(resolve, 180));
}

async function loadSelectedCardLedger() {
  const selectedCard = cards.find(card => card.id === selectedCardId) || null;
  if (!selectedCard) return { selectedCard: null, ledger: null };

  const currentStatementMonth = creditCardCurrentStatementMonthKey(selectedCard);
  const statementMonth = selectedCycleView === 'last' ? addMonths(currentStatementMonth, -1) : currentStatementMonth;
  const ledger = await creditCardCycleLedger(selectedCard, recurringSeries, statementMonth, undefined, emiSeries);

  return { selectedCard, ledger };
}

async function refreshCardStatementExplorer({ direction = 0, settlementFlash = false } = {}) {
  const host = root.querySelector('[data-card-statement-host]');
  if (!host) return;

  const shouldAnimate = direction !== 0 && !cardsReducedMotion.matches;
  const oldContent = host.querySelector('[data-card-cycle-content]');
  const ledgerPromise = loadSelectedCardLedger();

  if (shouldAnimate && oldContent) {
    oldContent.classList.add(direction > 0 ? 'cc-cycle-fade-out-left' : 'cc-cycle-fade-out-right');
    await new Promise(resolve => setTimeout(resolve, 85));
  }

  const { selectedCard, ledger } = await ledgerPromise;
  host.innerHTML = renderCardStatementExplorer(selectedCard, ledger);

  if (shouldAnimate) {
    const newContent = host.querySelector('[data-card-cycle-content]');

    if (newContent) {
      newContent.classList.add(direction > 0 ? 'cc-cycle-fade-in-right' : 'cc-cycle-fade-in-left');
      void newContent.offsetWidth;

      requestAnimationFrame(() => {
        newContent.classList.add('is-visible');
      });

      setTimeout(() => {
        if (!newContent.isConnected) return;
        newContent.classList.remove('cc-cycle-fade-in-right', 'cc-cycle-fade-in-left', 'is-visible');
      }, 140);
    }
  }

  if (settlementFlash) {
    const outstanding = host.querySelector('.cc-ledger-summary .cc-ledger-stat:nth-child(2)');
    if (outstanding) {
      outstanding.classList.add('cc-settlement-success');
      setTimeout(() => outstanding.classList.remove('cc-settlement-success'), 380);
    }
  }
}

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
        ${entry.type === 'emi' ? `<div class="cc-ledger-tag" style="font-family: 'IBM Plex Mono', monospace;">EMI${entry.installment && entry.totalMonths ? ` - ${entry.installment}/${entry.totalMonths}` : ''}</div>` : ''}
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
        <label
          class="cc-settle-switch"
          for="cc-cycle-settled"
          aria-label="Mark this credit card statement as fully settled"
        >
          <input
            id="cc-cycle-settled"
            name="cycleSettled"
            type="checkbox"
            data-cycle-settled="${ledger.cycleEnd}"
            ${ledger.fullySettled ? 'checked' : ''}
          />
          <span class="cc-settle-slider" aria-hidden="true"></span>
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
          <label for="cc-ledger-card-select">Credit card</label>
          <select
            id="cc-ledger-card-select"
            name="ledgerCard"
            data-card-ledger-select
            autocomplete="off"
          >
            ${selectorOptions}
          </select>
        </div>

        <div class="cc-cycle-toggle" role="group" aria-label="Billing cycle">
          <button type="button" data-cycle-view="last" class="${selectedCycleView === 'last' ? 'active' : ''}">Last billing cycle</button>
          <button type="button" data-cycle-view="current" class="${selectedCycleView === 'current' ? 'active' : ''}">Current billing cycle</button>
        </div>
      </div>

      <div class="cc-ledger-cycle-content" data-card-cycle-content>
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
    </div>
  `;
}

async function renderCards() {
  try {
  // Fetched once; add/delete mutate `cards` in memory and persist it, so
  // later re-renders reuse the in-memory array instead of refetching.
  if (!domainLoaded) {
    const records = await Store.bulkGet(['creditcards', 'recurringseries', 'emiseries'], {});
    cards = records.creditcards || [];
    recurringSeries = records.recurringseries || [];
    emiSeries = records.emiseries || [];
    let migrated = false;
    cards = cards.map(card => {
      const rawDueDay = Number(card.dueDay);
      if (Number.isInteger(rawDueDay) && rawDueDay >= 1 && rawDueDay <= 31) return card;

      migrated = true;
      return { ...card, dueDay: 1 };
    });

    if (migrated) await Store.set('creditcards', cards);

    const params = new URLSearchParams(window.location.search);
    const requestedCardId = params.get('card');
    const requestedCycle = params.get('cycle');

    selectedCardId = cards.some(card => card.id === requestedCardId) ? requestedCardId : (cards[0]?.id || null);
    selectedCycleView = requestedCycle === 'last' ? 'last' : 'current';
    domainLoaded = true;
  }

  if (selectedCardId && !cards.some(card => card.id === selectedCardId)) {
    selectedCardId = cards[0]?.id || null;
  } else if (!selectedCardId && cards.length) {
    selectedCardId = cards[0].id;
  }

  const { selectedCard, ledger } = await loadSelectedCardLedger();

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

        <div class="cc-card-editor-wrap ${isEditing ? 'expanded' : ''}" data-card-editor-wrap="${c.id}">
          <div class="cc-card-editor">
            <div class="form-row">
              <div class="field">
                <label for="cc-edit-name-${c.id}">
                  Card description
                </label>
                <input
                  id="cc-edit-name-${c.id}"
                  name="cardDescription"
                  class="cc-edit-name"
                  type="text"
                  value="${escapeHtml(c.name)}"
                  autocomplete="off"
                />
              </div>

              <div class="field">
                <label for="cc-edit-billing-${c.id}">
                  Billing date
                </label>
                <input
                  id="cc-edit-billing-${c.id}"
                  name="billingDay"
                  class="cc-edit-billing"
                  type="number"
                  min="1"
                  max="31"
                  value="${c.billingDay}"
                  inputmode="numeric"
                  autocomplete="off"
                />
              </div>

              <div class="field">
                <label for="cc-edit-due-${c.id}">
                  Due date
                </label>
                <input
                  id="cc-edit-due-${c.id}"
                  name="dueDay"
                  class="cc-edit-due"
                  type="number"
                  min="1"
                  max="31"
                  value="${c.dueDay}"
                  inputmode="numeric"
                  autocomplete="off"
                />
              </div>
            </div>
            <div class="form-actions">
              <button class="btn primary" data-save-card="${c.id}" type="button">Save</button>
              <button class="btn ghost" data-popover-trigger data-del-card="${c.id}" type="button">Delete</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('') || `<div class="empty-chart">No cards added yet — add one below.</div>`;

  const tb = document.getElementById('global-topbar');
  if (tb) tb.style.display = '';

  markRendered(root);
  root.removeAttribute('data-loading');
  root.setAttribute('aria-busy', 'false');

  root.innerHTML = `
  <div class="section">
    <div class="card cards-load-stage cards-load-stage--collection">
      <div class="section-title"><h2>Credit cards</h2><span class="hint">Card charges and payments are tracked per card</span></div>
        <div class="cc-list">${rows}</div>
        <div class="form-panel">
          <div class="form-row">
            <div class="field">
              <label for="cc-name">
                Card description
              </label>
              <input
                id="cc-name"
                name="cardDescription"
                type="text"
                placeholder="e.g. HDFC Regalia"
                autocomplete="off"
              />
            </div>

            <div class="field">
              <label for="cc-day">
                Billing Date
              </label>
              <input
                id="cc-day"
                name="billingDay"
                type="number"
                min="1"
                max="31"
                placeholder="e.g. 18"
                inputmode="numeric"
                autocomplete="off"
              />
            </div>

            <div class="field">
              <label for="cc-due-day">
                Due Date
              </label>
              <input
                id="cc-due-day"
                name="dueDay"
                type="number"
                min="1"
                max="31"
                value="1"
                inputmode="numeric"
                autocomplete="off"
              />
            </div>
          </div>
          <div class="form-actions">
            <button class="btn" id="cc-add" type="button">Add card</button>
          </div>
        </div>
    </div>

    <div class="cards-load-stage cards-load-stage--ledger" data-card-statement-host>
      ${renderCardStatementExplorer(selectedCard, ledger)}
    </div>
  </div>
  `;

  appendPageChrome(root);

  if (pendingCardEnterId) {
    const addedCard = root.querySelector(`.cc-item[data-card-id="${CSS.escape(pendingCardEnterId)}"]`);
    if (addedCard) {
      addedCard.classList.add('cc-item-enter');
      setTimeout(() => addedCard.classList.remove('cc-item-enter'), 280);
    }
    pendingCardEnterId = null;
  }

  const requestedCardId = new URLSearchParams(window.location.search).get('card');
  if (requestedCardId && selectedCardId === requestedCardId) {
    setTimeout(() => {
      const explorer = root.querySelector('.cc-ledger-card-select')?.closest('.card') || root.querySelector('[data-card-ledger-select]');
      if (!explorer) return;

      explorer.scrollIntoView({ behavior: 'smooth', block: 'start' });
      explorer.setAttribute('tabindex', '-1');
      explorer.focus({ preventScroll: true });
    }, 100);
  }
  } catch (error) {
    console.error('Cards render failed:', error);
    root.removeAttribute('data-loading');
    root.setAttribute('aria-busy', 'false');
    root.innerHTML = `<div class="section"><div class="empty-chart cards-load-error">Credit-card data could not be loaded right now. Please try again.</div></div>`;
    appendPageChrome(root);
    showToast("We couldn't load your cards. Please try again.");
  }
}

root.addEventListener('click', async (ev) => {
  const cycleView = ev.target.closest('[data-cycle-view]');
  if (cycleView) {
    const nextCycle = cycleView.dataset.cycleView === 'last' ? 'last' : 'current';
    if (nextCycle === selectedCycleView) return;

    const direction = nextCycle === 'current' ? 1 : -1;
    selectedCycleView = nextCycle;
    await refreshCardStatementExplorer({ direction });
    return;
  }

  const editCard = ev.target.closest('[data-edit-card]');
  if (editCard) {
    const cardId = editCard.dataset.editCard;
    const row = editCard.closest('.cc-item');
    const editorWrap = row?.querySelector(`[data-card-editor-wrap="${CSS.escape(cardId)}"]`);
    const isOpening = editingCardId !== cardId;

    const previouslyOpenId = editingCardId;
    if (previouslyOpenId && previouslyOpenId !== cardId) {
      const previousRow = root.querySelector(`.cc-item[data-card-id="${CSS.escape(previouslyOpenId)}"]`);
      const previousButton = previousRow?.querySelector(`[data-edit-card="${CSS.escape(previouslyOpenId)}"]`);
      const previousWrap = previousRow?.querySelector(`[data-card-editor-wrap="${CSS.escape(previouslyOpenId)}"]`);

      previousRow?.classList.remove('editing');
      previousButton?.classList.remove('expanded');
      previousButton?.setAttribute('aria-expanded', 'false');
      previousButton?.setAttribute('title', 'Edit card');
      previousWrap?.classList.remove('expanded');
    }

    editingCardId = isOpening ? cardId : null;

    row?.classList.toggle('editing', isOpening);
    editCard.classList.toggle('expanded', isOpening);
    editCard.setAttribute('aria-expanded', String(isOpening));
    editCard.setAttribute('title', isOpening ? 'Close editor' : 'Edit card');
    editorWrap?.classList.toggle('expanded', isOpening);

    if (isOpening) {
      const firstInput = editorWrap?.querySelector('.cc-edit-name');
      setTimeout(() => firstInput?.focus({ preventScroll: true }), 180);
    }

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

    const stopBusy = beginCardsBusy(saveCard);

    try {
      await Store.set('creditcards', cards);
      editingCardId = null;
      await renderCards();
      showToast('Card updated');
    } finally {
      stopBusy();
    }
    return;
  }

  const delCard = ev.target.closest('[data-del-card]');
  if (delCard) {
    ev.stopPropagation();

    const card = cards.find(c => c.id === delCard.dataset.delCard);
    if (!card) return;

    showDeleteCallout(delCard, 'confirm-del-card', card.id, `Delete ${card.name}?`);
    return;
  }

  const confirmDelCard = ev.target.closest('[data-confirm-del-card]');
  if (confirmDelCard) {
    ev.stopPropagation();

    const cardId = confirmDelCard.dataset.confirmDelCard;
    const cardEl = root.querySelector(`.cc-item[data-card-id="${CSS.escape(cardId)}"]`);

    hideDeleteCallout();
    await animateCardRemoval(cardEl);

    cards = cards.filter(c => c.id !== cardId);
    if (editingCardId === cardId) editingCardId = null;
    if (selectedCardId === cardId) selectedCardId = cards[0]?.id || null;

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
    const stopBusy = beginCardsBusy(addCard, 'Adding…');

    cards.push(card);
    if (!selectedCardId) selectedCardId = card.id;

    try {
      await Store.set('creditcards', cards);
      pendingCardEnterId = card.id;
      await renderCards();
      showToast('Card added');
    } finally {
      stopBusy();
    }
  }
});

root.addEventListener('change', async (ev) => {
  if (ev.target.matches('[data-card-ledger-select]')) {
    selectedCardId = ev.target.value || null;
    selectedCycleView = 'current';
    await refreshCardStatementExplorer({ direction: 1 });
    return;
  }

  if (ev.target.matches('[data-cycle-settled]')) {
    const selectedCard = cards.find(card => card.id === selectedCardId);
    if (!selectedCard || selectedCycleView !== 'last') return;

    const toggle = ev.target;
    const checked = toggle.checked;
    const cycleEnd = toggle.dataset.cycleSettled;
    toggle.disabled = true;

    try {
      await setCreditCardCycleSettled(selectedCard.id, cycleEnd, checked);
      await refreshCardStatementExplorer({ settlementFlash: true });
      showToast(checked ? 'Statement marked fully settled' : 'Statement settlement reopened');
    } catch (error) {
      toggle.checked = !checked;
      showToast('Could not update statement settlement');
    } finally {
      if (toggle.isConnected) toggle.disabled = false;
    }
  }
});

wireDeletePopoverDismiss(root);

window.addEventListener('auth:signed-in', renderCards);
window.addEventListener('auth:checked', renderCards);
// Wait for the first /api/auth/me round trip so we never flash the
// signed-out login hero for an already-authenticated visitor.
authReady.then(renderCards);

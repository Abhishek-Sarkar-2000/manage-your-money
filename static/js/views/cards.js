/* ---------- /cards ---------- */
import { Store } from '../core/store.js';
import { $, uid, escapeHtml } from '../core/dom.js';
import { ordinalSuffix } from '../core/format.js';
import { authReady } from '../core/auth.js';
import { appendPageChrome } from '../components/page-chrome.js';
import { showToast } from '../components/toast.js';
import { markRendered } from '../components/render-guard.js';

const root = document.getElementById('cards-root');
let cards = [];
let domainLoaded = false;
let editingCardId = null;

async function renderCards() {
  // Fetched once; add/delete mutate `cards` in memory and persist it, so
  // later re-renders reuse the in-memory array instead of refetching.
  if (!domainLoaded) {
    cards = await Store.get('creditcards', []);

    let migrated = false;
    cards = cards.map(card => {
      const rawDueDay = Number(card.dueDay);
      if (Number.isInteger(rawDueDay) && rawDueDay >= 1 && rawDueDay <= 31) return card;

      migrated = true;
      return { ...card, dueDay: 1 };
    });

    if (migrated) await Store.set('creditcards', cards);
    domainLoaded = true;
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
  </div>
  `;

  appendPageChrome(root);
}

root.addEventListener('click', async (ev) => {
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

    cards.push({ id: uid(), name, billingDay: day, dueDay });
    await Store.set('creditcards', cards);
    await renderCards();
    showToast('Card added');
  }
});

window.addEventListener('auth:signed-in', renderCards);
window.addEventListener('auth:checked', renderCards);
// Wait for the first /api/auth/me round trip so we never flash the
// signed-out login hero for an already-authenticated visitor.
authReady.then(renderCards);

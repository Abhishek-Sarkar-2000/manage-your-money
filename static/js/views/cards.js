/* ---------- /cards ---------- */
import { Store } from '../core/store.js';
import { $, uid, escapeHtml } from '../core/dom.js';
import { ordinalSuffix } from '../core/format.js';
import { currentUser, authReady } from '../core/auth.js';
import { mountLoginHero } from '../components/login-hero.js';
import { appendPageChrome } from '../components/page-chrome.js';
import { showToast } from '../components/toast.js';
import { markRendered } from '../components/render-guard.js';

const root = document.getElementById('cards-root');
let cards = [];
let domainLoaded = false;

async function renderCards() {
  if (!currentUser) {
    markRendered(root);
    mountLoginHero(root);
    return;
  }

  // Fetched once; add/delete mutate `cards` in memory and persist it, so
  // later re-renders reuse the in-memory array instead of refetching.
  if (!domainLoaded) {
    cards = await Store.get('creditcards', []);
    domainLoaded = true;
  }

  const rows = cards.map(c => `
    <div class="cc-item">
      <div>
        <div class="cc-name">${escapeHtml(c.name)}</div>
        <div class="cc-cycle">Billing date: ${c.billingDay}${ordinalSuffix(c.billingDay)} of the month</div>
      </div>
      <button class="icon-btn" data-popover-trigger data-del-card="${c.id}" title="Remove card">✕</button>
    </div>
  `).join('') || `<div class="empty-chart">No cards added yet — add one below.</div>`;

  markRendered(root);
  root.innerHTML = `
  <div class="topbar">
    <a class="brand" href="/home"><span class="mark">₹</span> LedgerNote</a>
  </div>
  <div class="section">
    <div class="card">
      <div class="section-title"><h2>Credit cards</h2><span class="hint">Card charges and payments are tracked per card</span></div>
        <div class="cc-list">${rows}</div>
        <div class="form-panel">
          <div class="form-row">
            <div class="field"><label>Card description</label><input id="cc-name" type="text" placeholder="e.g. HDFC Regalia" /></div>
            <div class="field"><label>Billing cycle (day of month bill is generated)</label><input id="cc-day" type="number" min="1" max="31" placeholder="e.g. 18" /></div>
          </div>
          <div class="form-actions"><button class="btn" id="cc-add">Add card</button></div>
        </div>
    </div>
  </div>
  `;

  appendPageChrome(root);
}

root.addEventListener('click', async (ev) => {
  const delCard = ev.target.closest('[data-del-card]');
  if (delCard) {
    cards = cards.filter(c => c.id !== delCard.dataset.delCard);
    await Store.set('creditcards', cards);
    await renderCards();
    showToast('Card removed');
    return;
  }
  const addCard = ev.target.closest('#cc-add');
  if (addCard) {
    const name = $('#cc-name').value.trim();
    const day = Number($('#cc-day').value);
    if (!name || !day || day < 1 || day > 31) { showToast('Enter a card name and a valid billing day (1–31)'); return; }
    cards.push({ id: uid(), name, billingDay: day });
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

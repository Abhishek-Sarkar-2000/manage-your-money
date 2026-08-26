/* ---------- /pricetrack ---------- */
import { Store } from '../core/store.js';
import { $, uid, escapeHtml } from '../core/dom.js';
import { fmtINR } from '../core/format.js';
import { currentUser, authReady } from '../core/auth.js';
import { allSpendTags } from '../core/domain.js';
import { priceLineChart, wireChartTooltips } from '../components/charts/line-chart.js';
import { scrollWrapper, setupScrollWrappers, setupTableScrollIndicators } from '../components/scroll-wrapper.js';
import { showDeleteCallout, hideDeleteCallout, wireDeletePopoverDismiss } from '../components/delete-popover.js';
import { mountLoginHero } from '../components/login-hero.js';
import { appendPageChrome } from '../components/page-chrome.js';
import { showToast } from '../components/toast.js';
import { markRendered } from '../components/render-guard.js';

const root = document.getElementById('pricetrack-root');
const DEFAULT_TAGS = ['Groceries', 'Dining', 'Fuel', 'Subscription', 'Rent', 'Utility', 'Recharge', 'Transport', 'Gift'];

let priceItems = [];
let priceTrackDictionary = {};
let customTags = [];
let priceFormOpen = false;
let priceExpandedId = null;
let priceLogFormOpen = false;
let priceSlideDirection = '';
let animTimeout = null;
let domainLoaded = false;

// Fetched once; every mutation below updates these arrays/objects in place
// before persisting, so later re-renders never need to refetch them.
async function loadDomain() {
  if (domainLoaded) return;
  [priceItems, priceTrackDictionary, customTags] = await Promise.all([
    Store.get('price-items', []),
    Store.get('price-track-dict', {}),
    Store.get('custom-spend-tags', []),
  ]);
  domainLoaded = true;
}

function sortedPriceHistory(item) {
  return [...(item.history || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

async function resolveTagFromForm() {
  const sel = $('#f-tag');
  if (!sel) return '';
  const val = sel.value;
  if (val === '__custom__') {
    const custom = ($('#f-tag-custom')?.value || '').trim();
    if (!custom) return '';
    const exists = allSpendTags(DEFAULT_TAGS, customTags).some(t => t.toLowerCase() === custom.toLowerCase());
    if (!exists) { customTags.push(custom); await Store.set('custom-spend-tags', customTags); }
    return custom;
  }
  return val;
}

function renderTagField() {
  const tags = allSpendTags(DEFAULT_TAGS, customTags);
  const options = tags.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  return `
  <div class="field" id="f-tag-wrap">
    <label>Tag</label>
    <select id="f-tag">
      <option value="">No tag</option>
      ${options}
      <option value="__custom__">+ Add custom tag</option>
    </select>
  </div>
  <div class="field" id="f-tag-custom-wrap" style="display:none;">
    <label>New tag name</label>
    <input id="f-tag-custom" type="text" placeholder="e.g. Pets" />
  </div>`;
}

function renderPriceItemCard(item) {
  const hist = sortedPriceHistory(item);
  const latest = hist.length ? hist[hist.length - 1] : null;
  const prev = hist.length > 1 ? hist[hist.length - 2] : null;
  const active = priceExpandedId === item.id ? 'active' : '';

  let trendHtml = '';
  if (latest && prev) {
    const diff = latest.price - prev.price;
    const pct = prev.price ? (diff / prev.price * 100) : 0;
    const cls = diff === 0 ? 'flat' : (diff > 0 ? 'up' : 'down');
    const arrow = diff === 0 ? '→' : (diff > 0 ? '↑' : '↓');
    trendHtml = `<span class="price-trend ${cls}">${arrow} ${Math.abs(pct).toFixed(1)}%</span>`;
  }

  const dateLabel = latest && latest.date
    ? new Date(latest.date + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : null;

  let metaHtml = '';
  if (item.meta) {
    if (item.meta.source && item.meta.destination) metaHtml = ` <span class="meta-text">${escapeHtml(item.meta.source)} → ${escapeHtml(item.meta.destination)}</span>`;
    else if (item.meta.quantity && item.meta.location) metaHtml = `<span class="meta-text">${escapeHtml(item.meta.quantity)} @ ${escapeHtml(item.meta.location)}</span>`;
    else if (item.meta.quantity) metaHtml = ` <span class="meta-text">${escapeHtml(item.meta.quantity)}</span>`;
    else if (item.meta.location) metaHtml = ` <span class="meta-text">${escapeHtml(item.meta.location)}</span>`;
  }

  return `
  <div class="price-item-card ${active}" data-price-card="${item.id}">
    <div class="pic-actions">
      <button class="icon-btn" data-popover-trigger data-del-price-item="${item.id}" title="Remove item" type="button">✕</button>
    </div>
    <div class="pic-top">
      <h4>${escapeHtml(item.name)}</h4></br>${metaHtml}
    </div>
    <div class="pic-bottom">
      <div class="pic-price-row">
        <span class="pic-price">${latest ? fmtINR(latest.price) : '—'}</span>
        ${trendHtml}
      </div>
      <div class="pic-date">${dateLabel ? 'Updated ' + dateLabel : 'No prices logged yet'}</div>
    </div>
  </div>`;
}

function renderPriceDetailsPanel(item) {
  const hist = sortedPriceHistory(item);
  const chart = priceLineChart(hist);

  let metaHtml = '';
  if (item.meta) {
    if (item.meta.source && item.meta.destination) metaHtml = `<span class="meta-text">${escapeHtml(item.meta.source)} → ${escapeHtml(item.meta.destination)}</span>`;
    else if (item.meta.quantity && item.meta.location) metaHtml = `<span class="meta-text">${escapeHtml(item.meta.quantity)} @ ${escapeHtml(item.meta.location)}</span>`;
    else if (item.meta.quantity) metaHtml = `<span class="meta-text">${escapeHtml(item.meta.quantity)}</span>`;
    else if (item.meta.location) metaHtml = `<span class="meta-text">${escapeHtml(item.meta.location)}</span>`;
  }

  const rowsHtml = [...hist].reverse().map(h => {
    const dateLabel = h.date ? new Date(h.date + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
    return `
    <tr>
      <td>${dateLabel}</td>
      <td class="num">${fmtINR(h.price)}</td>
      <td>${h.note ? escapeHtml(h.note) : '<span class="subnote">—</span>'}</td>
      <td class="actions-cell"><button class="icon-btn" data-del-price-point="${item.id}|${h.id}" title="Remove entry">✕</button></td>
    </tr>`;
  }).join('');

  const formHtml = priceLogFormOpen ? `
  <div class="form-panel slide-down-fade" style="margin-top:14px;">
    <div class="form-row">
      <div class="field"><label>Date</label><input id="pp-date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
      <div class="field"><label>Price (₹)</label><input id="pp-price" type="number" step="0.01" min="0" placeholder="0.00" /></div>
      <div class="field"><label>Note (optional)</label><input id="pp-note" type="text" placeholder="e.g. Supermarket" /></div>
    </div>
    <div class="form-actions">
      <button class="btn primary" data-submit-price-point="${item.id}" type="button">Add price</button>
      <button class="btn ghost" data-close-price-log-form type="button">Cancel</button>
    </div>
  </div>` : '';

  const addBtnHtml = !priceLogFormOpen ? `
  <div class="pill-grid" style="margin-top:14px;">
    <button class="pill-btn" data-open-price-log-form type="button">+ Log Price</button>
  </div>` : '';

  return `
  <div class="price-details-panel" data-price-details="${item.id}" style="margin-top:2px;">
    <div class="section-title">
      <div>
        <h2>${escapeHtml(item.name)} — Price History</h2>
        ${metaHtml ? `<div style="margin-top: 4px;">${metaHtml}</div>` : ''}
      </div>
      <span class="hint">${hist.length} entr${hist.length === 1 ? 'y' : 'ies'} logged</span>
    </div>
    <div class="chart-card" style="margin-top:14px;">${chart}</div>
    ${addBtnHtml}
    ${formHtml}
    <div class="section-title"><h2>Cost Entries</h2></div>
    <div class="table-wrap">
      <table ${rowsHtml ? '' : 'style="width:100%;"'}>
        <thead><tr><th>Date</th><th class="table-numeric">Price</th><th>Note</th><th></th></tr></thead>
        <tbody>${rowsHtml || `<tr class="empty-row"><td colspan="4">No prices logged yet — add one above.</td></tr>`}</tbody>
      </table>
    </div>
  </div>`;
}

async function renderPriceTrack() {
  if (!currentUser) {
    markRendered(root);
    mountLoginHero(root);
    return;
  }
  await loadDomain();

  const items = [...priceItems].sort((a, b) => a.name.localeCompare(b.name));
  const expandedItem = priceExpandedId ? priceItems.find(i => i.id === priceExpandedId) : null;

  const addFormHtml = priceFormOpen ? `
  <div class="form-panel">
    <div class="form-row">
      <div class="field"><label>Item name</label><input id="pi-name" type="text" placeholder="e.g. Milk 1L" /></div>
      ${renderTagField()}
      <div id="pt-dynamic-fields" style="display:contents;"></div>
    </div>
    <div class="form-actions">
      <button class="btn primary" data-submit-price-item type="button">Save item</button>
      <button class="btn ghost" data-close-price-form type="button">Cancel</button>
    </div>
  </div>` : '';

  const groupedItems = {};
  for (const item of items) {
    const cat = item.category || 'Other';
    if (!groupedItems[cat]) groupedItems[cat] = [];
    groupedItems[cat].push(item);
  }

  let categoriesHtml = '';
  if (items.length === 0) {
    categoriesHtml = `<div class="empty-chart" style="grid-column:1/-1;">No items tracked yet — add one above to get started.</div>`;
  } else {
    const sortedCategories = Object.keys(groupedItems).sort((a, b) => a.localeCompare(b));
    for (const category of sortedCategories) {
      const catItems = groupedItems[category];
      const cardsHtml = catItems.map(i => renderPriceItemCard(i)).join('');
      const isExpandedInThisCategory = expandedItem && catItems.some(i => i.id === expandedItem.id);
      const detailsHtml = isExpandedInThisCategory
        ? `<div id="price-details-anim-inner" class="${priceSlideDirection || ''}">${renderPriceDetailsPanel(expandedItem)}</div>`
        : '';
      categoriesHtml += `
      <div class="price-category-section">
        <div class="price-category-title">${escapeHtml(category)}</div>
        ${scrollWrapper(cardsHtml, 'price-category-track')}
        ${detailsHtml}
      </div>`;
    }
  }

  const tb = document.getElementById('global-topbar');
  if (tb) tb.style.display = '';

  markRendered(root);
  root.innerHTML = `
  <div class="section">
    <div class="month-header"><h1>Price Tracker</h1></div>
    <p style="color:var(--muted); max-width:56ch; margin-top:6px;">Note down what things cost over time — groceries, transport, subscriptions — and watch how prices move.</p>
  </div>

  <div class="section">
    <div class="section-title"><h2>Track an item</h2><span class="hint">Add anything you want to watch the price of</span></div>
    <div class="pill-grid">
      <button class="pill-btn ${priceFormOpen ? 'active' : ''}" data-price-form-toggle type="button">+ Add New Item</button>
    </div>
    ${addFormHtml}
  </div>

  <div class="section">
    <div class="section-title"><h2>Tracked items</h2><span class="hint">Tap a card for its full price history</span></div>
    ${categoriesHtml}
  </div>
  `;

  appendPageChrome(root);
  setupScrollWrappers(root);
  setupTableScrollIndicators(root);
}

root.addEventListener('click', async (ev) => {
  const priceFormToggle = ev.target.closest('[data-price-form-toggle]');
  if (priceFormToggle) { priceFormOpen = !priceFormOpen; await renderPriceTrack(); return; }
  const closePriceForm = ev.target.closest('[data-close-price-form]');
  if (closePriceForm) { priceFormOpen = false; await renderPriceTrack(); return; }

  const submitPriceItem = ev.target.closest('[data-submit-price-item]');
  if (submitPriceItem) {
    const name = ($('#pi-name').value || '').trim();
    if (!name) { showToast('Enter an item name'); return; }
    const category = (await resolveTagFromForm()) || 'Other';
    let meta = {};
    const catLower = category.toLowerCase();
    if (catLower === 'groceries') meta.quantity = $('#pt-quantity')?.value || '';
    if (catLower === 'transport') { meta.source = $('#pt-source')?.value || ''; meta.destination = $('#pt-destination')?.value || ''; }
    if (catLower === 'fuel') { meta.quantity = $('#pt-quantity')?.value || ''; meta.location = $('#pt-location')?.value || ''; }
    if (catLower === 'rent') meta.location = $('#pt-location')?.value || '';

    priceTrackDictionary[name] = { category, meta };
    await Store.set('price-track-dict', priceTrackDictionary);
    priceItems.push({ id: uid(), name, category, history: [], meta });
    await Store.set('price-items', priceItems);
    priceFormOpen = false;
    await renderPriceTrack();
    showToast('Item added');
    return;
  }

  const delPriceItemBtn = ev.target.closest('[data-del-price-item]');
  if (delPriceItemBtn) { ev.stopPropagation(); showDeleteCallout(delPriceItemBtn, 'confirm-del-price-item', delPriceItemBtn.dataset.delPriceItem); return; }
  const confirmDelPriceItem = ev.target.closest('[data-confirm-del-price-item]');
  if (confirmDelPriceItem) {
    ev.stopPropagation();
    const id = confirmDelPriceItem.dataset.confirmDelPriceItem;
    priceItems = priceItems.filter(i => i.id !== id);
    if (priceExpandedId === id) { priceExpandedId = null; priceLogFormOpen = false; }
    await Store.set('price-items', priceItems);
    hideDeleteCallout();
    await renderPriceTrack();
    showToast('Item removed');
    return;
  }

  const priceCard = ev.target.closest('[data-price-card]');
  if (priceCard) {
    const id = priceCard.dataset.priceCard;
    if (animTimeout) clearTimeout(animTimeout);

    if (priceExpandedId === id) { priceExpandedId = null; priceLogFormOpen = false; await renderPriceTrack(); return; }
    if (priceExpandedId) {
      const cardsEls = Array.from(document.querySelectorAll('.price-item-card'));
      let oldIdx = -1, newIdx = -1;
      cardsEls.forEach((c, i) => { if (c.dataset.priceCard === priceExpandedId) oldIdx = i; if (c.dataset.priceCard === id) newIdx = i; });
      const isRight = newIdx > oldIdx;
      const inner = $('#price-details-anim-inner');
      if (inner && oldIdx !== -1 && newIdx !== -1) {
        inner.className = isRight ? 'slide-out-left' : 'slide-out-right';
        animTimeout = setTimeout(async () => {
          priceExpandedId = id; priceLogFormOpen = false;
          priceSlideDirection = isRight ? 'slide-in-right' : 'slide-in-left';
          await renderPriceTrack();
        }, 300);
      } else { priceExpandedId = id; priceLogFormOpen = false; priceSlideDirection = ''; await renderPriceTrack(); }
      return;
    }
    priceExpandedId = id; priceLogFormOpen = false; priceSlideDirection = '';
    await renderPriceTrack();
    return;
  }

  const openPriceLogForm = ev.target.closest('[data-open-price-log-form]');
  if (openPriceLogForm) { priceLogFormOpen = true; await renderPriceTrack(); return; }
  const closePriceLogForm = ev.target.closest('[data-close-price-log-form]');
  if (closePriceLogForm) { priceLogFormOpen = false; await renderPriceTrack(); return; }

  const submitPricePoint = ev.target.closest('[data-submit-price-point]');
  if (submitPricePoint) {
    const itemId = submitPricePoint.dataset.submitPricePoint;
    const item = priceItems.find(i => i.id === itemId);
    if (!item) return;
    const date = $('#pp-date').value || new Date().toISOString().slice(0, 10);
    const price = Number($('#pp-price').value);
    const note = ($('#pp-note').value || '').trim();
    if (Number.isNaN(price) || price < 0) { showToast('Enter a valid price'); return; }
    item.history.push({ id: uid(), date, price, note });
    await Store.set('price-items', priceItems);
    priceLogFormOpen = false;
    await renderPriceTrack();
    showToast('Price logged');
    return;
  }

  const delPricePoint = ev.target.closest('[data-del-price-point]');
  if (delPricePoint) {
    const [itemId, pointId] = delPricePoint.dataset.delPricePoint.split('|');
    const item = priceItems.find(i => i.id === itemId);
    if (item) {
      item.history = item.history.filter(h => h.id !== pointId);
      await Store.set('price-items', priceItems);
      await renderPriceTrack();
      showToast('Entry removed');
    }
  }
});

root.addEventListener('change', (ev) => {
  if (ev.target.id === 'f-tag') {
    const val = ev.target.value.toLowerCase();
    const customWrap = $('#f-tag-custom-wrap');
    if (customWrap) customWrap.style.display = val === '__custom__' ? 'block' : 'none';

    const ptDynamicWrap = $('#pt-dynamic-fields');
    if (ptDynamicWrap) {
      if (val === 'groceries') ptDynamicWrap.innerHTML = `<div class="field"><label>Quantity</label><input id="pt-quantity" type="text" placeholder="e.g. 1kg or 1L" /></div>`;
      else if (val === 'transport') ptDynamicWrap.innerHTML = `<div class="field"><label>Source</label><input id="pt-source" type="text" placeholder="e.g. Home" /></div><div class="field"><label>Destination</label><input id="pt-destination" type="text" placeholder="e.g. Office" /></div>`;
      else if (val === 'fuel') ptDynamicWrap.innerHTML = `<div class="field"><label>Quantity</label><input id="pt-quantity" type="text" placeholder="e.g. 5L" /></div><div class="field"><label>Location</label><input id="pt-location" type="text" placeholder="e.g. IOCL Bengaluru" /></div>`;
      else if (val === 'rent') ptDynamicWrap.innerHTML = `<div class="field"><label>Location</label><input id="pt-location" type="text" placeholder="e.g. Sunflower Heights Whitefield" /></div>`;
      else ptDynamicWrap.innerHTML = '';
    }
  }
});

wireDeletePopoverDismiss(root);
window.addEventListener('auth:signed-in', renderPriceTrack);
window.addEventListener('auth:checked', renderPriceTrack);
// Wait for the first /api/auth/me round trip so we never flash the
// signed-out login hero for an already-authenticated visitor.
authReady.then(renderPriceTrack);
wireChartTooltips(root);
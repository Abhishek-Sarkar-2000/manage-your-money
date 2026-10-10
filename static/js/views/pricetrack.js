/* ---------- /pricetrack ---------- */
import { Store } from '../core/store.js';
import { $, uid, escapeHtml } from '../core/dom.js';
import { fmtINR, fmtINRUnit } from '../core/format.js';
import { authReady } from '../core/auth.js';
import { allSpendTags, migratePriceTrackerItems, normalizePriceTrackerPoint, priceTrackerItemMeta, priceTrackerItemsMatch } from '../core/domain.js';
import { priceLineChart, wireChartTooltips } from '../components/charts/line-chart.js';
import { scrollWrapper, setupScrollWrappers, setupTableScrollIndicators } from '../components/scroll-wrapper.js';
import { showDeleteCallout, hideDeleteCallout, wireDeletePopoverDismiss } from '../components/delete-popover.js';
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

const priceFormMotionReduced = window.matchMedia('(prefers-reduced-motion: reduce)');

function revealPriceForm(type) {
  const reveal = root.querySelector(`[data-price-form-reveal="${type}"]`);
  if (!reveal) return;
  if (priceFormMotionReduced.matches) { reveal.classList.add('is-open'); return; }
  requestAnimationFrame(() => requestAnimationFrame(() => { if (reveal.isConnected) reveal.classList.add('is-open'); }));
}

function restoreOpenPriceForms() {
  if (priceFormOpen) root.querySelector('[data-price-form-reveal="item"]')?.classList.add('is-open');
  if (priceLogFormOpen) root.querySelector('[data-price-form-reveal="log"]')?.classList.add('is-open');
}

async function closePriceFormReveal(type, finalize) {
  const reveal = root.querySelector(`[data-price-form-reveal="${type}"]`);
  if (reveal && reveal.classList.contains('is-open') && !priceFormMotionReduced.matches) {
    reveal.classList.add('is-closing');
    reveal.classList.remove('is-open');
    await new Promise(resolve => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        reveal.removeEventListener('transitionend', onEnd);
        resolve();
      };
      const onEnd = event => {
        if (event.target === reveal && event.propertyName === 'grid-template-rows') done();
      };
      reveal.addEventListener('transitionend', onEnd);
      window.setTimeout(done, 340);
    });
  }
  finalize();
  await renderPriceTrack();
  restoreOpenPriceForms();
}

let priceWritePending = false;
let pendingPriceItemId = null;
let pendingPricePoint = null;
let priceChartAnimateId = null;

const priceReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function beginPriceBusy(button, label = 'Saving…') {
  if (!button) return () => {};
  const originalHtml = button.innerHTML;
  const originalDisabled = button.disabled;
  const originalMinWidth = button.style.minWidth;
  const width = button.getBoundingClientRect().width;
  button.disabled = true;
  button.style.minWidth = `${Math.ceil(width)}px`;
  const timer = setTimeout(() => {
    if (!button.isConnected) return;
    button.classList.add('is-price-busy');
    button.innerHTML = `<span class="price-busy-spinner" aria-hidden="true"></span><span>${escapeHtml(label)}</span>`;
  }, 140);
  return () => {
    clearTimeout(timer);
    if (!button.isConnected) return;
    button.classList.remove('is-price-busy');
    button.innerHTML = originalHtml;
    button.disabled = originalDisabled;
    button.style.minWidth = originalMinWidth;
  };
}

function animatePriceRemoval(element, className, duration = 180) {
  if (!element || priceReducedMotion.matches) return Promise.resolve();
  element.classList.add(className);
  return new Promise(resolve => setTimeout(resolve, duration));
}

// Fetched once; every mutation below updates these arrays/objects in place
// before persisting, so later re-renders never need to refetch them.
async function loadDomain() {
  if (domainLoaded) return;
  const records = await Store.bulkGet(['price-items', 'price-track-dict', 'custom-spend-tags'], {});
  const priceTrackerMigration = migratePriceTrackerItems(records['price-items'] || []);
  priceItems = priceTrackerMigration.items;
  priceTrackDictionary = records['price-track-dict'] || {};
  customTags = records['custom-spend-tags'] || [];

  if (priceTrackerMigration.changed) {
    await Store.set('price-items', priceItems);
  }

  let dictionaryChanged = false;
  Object.keys(priceTrackDictionary).forEach(name => {
    const config = priceTrackDictionary[name] || {};
    const cleanMeta = priceTrackerItemMeta(config.category, config.meta);
    if (JSON.stringify(config.meta || null) !== JSON.stringify(cleanMeta)) {
      priceTrackDictionary[name] = { ...config, meta: cleanMeta };
      dictionaryChanged = true;
    }
  });

  if (dictionaryChanged) {
    await Store.set('price-track-dict', priceTrackDictionary);
  }

  const requestedItemId = new URLSearchParams(window.location.search).get('item');
  if (requestedItemId && priceItems.some(item => item.id === requestedItemId)) {
    priceExpandedId = requestedItemId;
    priceChartAnimateId = requestedItemId;
  }

  domainLoaded = true;
}

function sortedPriceHistory(item) {
  return [...(item.history || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

function priceTrackerUnitFor(item, point = null) {
  return String(point?.unit || item?.unit || '').trim();
}

function formatPriceTrackerValue(value, unit = '') {
  const safeUnit = escapeHtml(String(unit || ''));
  return `${safeUnit ? fmtINRUnit(value) : fmtINR(value)}${safeUnit ? `/${safeUnit}` : ''}`;
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
        <span class="pic-price">${latest ? formatPriceTrackerValue(latest.price, priceTrackerUnitFor(item, latest)) : '—'}</span>
        ${trendHtml}
      </div>
      <div class="pic-date">${dateLabel ? 'Updated ' + dateLabel : 'No prices logged yet'}</div>
    </div>
  </div>`;
}

function renderPriceDetailsPanel(item) {
  const hist = sortedPriceHistory(item);
  const catLower = String(item.category || '').trim().toLowerCase();
  const usesUnitPrice = catLower === 'groceries' || catLower === 'fuel';
  const unit = item.unit || (hist.length ? hist[hist.length - 1].unit : '') || '';
  const chart = priceLineChart(hist, { animate: priceChartAnimateId === item.id, unit });

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
    <tr data-price-point-row="${h.id}">
      <td>${dateLabel}</td>
      <td class="num">${formatPriceTrackerValue(h.price, priceTrackerUnitFor(item, h))}${h.quantity ? `<div class="subnote">${escapeHtml(h.quantity)} · total ${fmtINR(h.rawPrice ?? h.price)}</div>` : ''}</td>
      <td>${h.note ? escapeHtml(h.note) : '<span class="subnote">—</span>'}</td>
      <td class="actions-cell">
        <button class="icon-btn" data-popover-trigger data-del-price-point="${item.id}|${h.id}" title="Remove entry" type="button">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      </td>
    </tr>`;
  }).join('');

  const quantityField = usesUnitPrice ? `<div class="field"><label>Quantity</label><input id="pp-quantity" type="text" placeholder="${catLower === 'fuel' ? 'e.g. 5L' : 'e.g. 500g, 1kg, 750ml, 1L or 12'}" /></div>` : '';

  const formHtml = priceLogFormOpen ? `
  <div class="price-form-reveal" data-price-form-reveal="log">
    <div class="price-form-reveal-inner">
      <div class="form-panel price-local-form">
        <div class="form-row">
          <div class="field"><label>Date</label><input id="pp-date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
          <div class="field"><label>${usesUnitPrice ? 'Total price (₹)' : 'Price (₹)'}</label><input id="pp-price" type="number" step="0.01" min="0" placeholder="0.00" /></div>
          ${quantityField}
          <div class="field"><label>Note (optional)</label><input id="pp-note" type="text" placeholder="e.g. Supermarket" /></div>
        </div>
        <div class="form-actions">
          <button class="btn primary" data-submit-price-point="${item.id}" type="button">Add price</button>
          <button class="btn ghost" data-close-price-log-form type="button">Cancel</button>
        </div>
      </div>
    </div>
  </div>` : '';

  const addBtnHtml = `
  <div class="pill-grid" style="margin-top:14px;">
    <button class="pill-btn ${priceLogFormOpen ? 'active' : ''}" data-open-price-log-form type="button" aria-expanded="${priceLogFormOpen ? 'true' : 'false'}">+ Log Price</button>
  </div>`;

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
        <thead><tr><th>Date</th><th class="table-numeric">${usesUnitPrice ? 'Unit price' : 'Price'}</th><th>Note</th><th></th></tr></thead>
        <tbody>${rowsHtml || `<tr class="empty-row"><td colspan="4">No prices logged yet — add one above.</td></tr>`}</tbody>
      </table>
    </div>
  </div>`;
}

async function renderPriceTrack() {
  try {
  await loadDomain();

  const items = [...priceItems].sort((a, b) => a.name.localeCompare(b.name));
  const expandedItem = priceExpandedId ? priceItems.find(i => i.id === priceExpandedId) : null;

  const addFormHtml = priceFormOpen ? `
  <div class="price-form-reveal" data-price-form-reveal="item">
    <div class="price-form-reveal-inner">
      <div class="form-panel price-local-form">
        <div class="form-row">
          <div class="field"><label>Item name</label><input id="pi-name" type="text" placeholder="e.g. Milk" /></div>
          ${renderTagField()}
          <div id="pt-dynamic-fields" style="display:contents;"></div>
        </div>
        <div class="form-actions">
          <button class="btn primary" data-submit-price-item type="button">Save item</button>
          <button class="btn ghost" data-close-price-form type="button">Cancel</button>
        </div>
      </div>
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
  root.removeAttribute('data-loading');
  root.setAttribute('aria-busy', 'false');
  root.innerHTML = `
  <div class="section pricetrack-load-stage pricetrack-load-stage--header">
    <div class="month-header"><h1>Price Tracker</h1></div>
    <p style="color:var(--muted); max-width:56ch; margin-top:6px;">Note down what things cost over time — groceries, transport, subscriptions — and watch how prices move.</p>
  </div>

  <div class="section pricetrack-load-stage pricetrack-load-stage--create">
    <div class="section-title" style="margin-bottom: 12px;">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="color: var(--blue); display: flex;">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none">
            <path d="M9 2H3a1 1 0 0 0-1 1v6a1 1 0 0 0 .29.71l7.59 7.59a2 2 0 0 0 2.83 0l4.59-4.59a2 2 0 0 0 0-2.83L9.71 2.29A1 1 0 0 0 9 2zm-3.5 5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z" fill="currentColor" fill-rule="evenodd"></path>
            <line x1="19" y1="2" x2="19" y2="8" stroke="currentColor" stroke-width="2" stroke-linecap="round"></line>
            <line x1="16" y1="5" x2="22" y2="5" stroke="currentColor" stroke-width="2" stroke-linecap="round"></line>
          </svg>
        </span>
        <h2 style="margin: 0;">Track new item</h2>
      </div>
      <span class="hint">Add anything you want to watch the price of</span>
    </div>
    <div class="pill-grid">
      <button class="pill-btn ${priceFormOpen ? 'active' : ''}" data-price-form-toggle type="button">+ Add New Item</button>
    </div>
    ${addFormHtml}
  </div>

  <div class="section pricetrack-load-stage pricetrack-load-stage--items">
    <div class="section-title" style="margin-bottom: 12px;">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="color: var(--blue); display: flex;">
          <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path>
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <path d="M16 10a4 4 0 0 1-8 0"></path>
          </svg>
        </span>
        <h2 style="margin: 0;">Tracked items</h2>
      </div>
      <span class="hint">Tap a card for its full price history</span>
    </div>
    ${categoriesHtml}
  </div>
  `;

  appendPageChrome(root);
  setupScrollWrappers(root);
  setupTableScrollIndicators(root);

  if (pendingPriceItemId) {
    const card = root.querySelector(`[data-price-card="${CSS.escape(pendingPriceItemId)}"]`);
    if (card) {
      card.classList.add('price-item-enter');
      setTimeout(() => card.classList.remove('price-item-enter'), 300);
    }
    pendingPriceItemId = null;
  }

  if (pendingPricePoint) {
    const { itemId, pointId } = pendingPricePoint;
    const row = root.querySelector(`[data-price-point-row="${CSS.escape(pointId)}"]`);
    const card = root.querySelector(`[data-price-card="${CSS.escape(itemId)}"]`);
    const dots = root.querySelectorAll('.price-linechart .linechart-dot');
    const latestDot = dots.length ? dots[dots.length - 1] : null;
    if (row) row.classList.add('price-point-row-enter');
    if (card) card.classList.add('price-value-emphasis');
    if (latestDot) latestDot.classList.add('price-point-dot-enter');
    setTimeout(() => {
      row?.classList.remove('price-point-row-enter');
      card?.classList.remove('price-value-emphasis');
      latestDot?.classList.remove('price-point-dot-enter');
    }, 650);
    pendingPricePoint = null;
  }

  priceChartAnimateId = null;

  const requestedItemId = new URLSearchParams(window.location.search).get('item');
  if (requestedItemId && priceExpandedId === requestedItemId) {
    setTimeout(() => {
      const target = root.querySelector(`[data-price-card="${CSS.escape(requestedItemId)}"]`);
      if (!target) return;

      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('dashboard-deep-link-target');
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      setTimeout(() => target.classList.remove('dashboard-deep-link-target'), 1800);
    }, 100);
  }
  } catch (error) {
    console.error('Price Tracker render failed:', error);
    root.removeAttribute('data-loading');
    root.setAttribute('aria-busy', 'false');
    root.innerHTML = `<div class="section"><div class="empty-chart">Price Tracker could not be loaded right now. Please try again.</div></div>`;
    appendPageChrome(root);
    showToast("We couldn't load Price Tracker. Please try again.");
  }
}

root.addEventListener('click', async (ev) => {
  const priceFormToggle = ev.target.closest('[data-price-form-toggle]');
  if (priceFormToggle) {
    if (priceFormOpen) {
      await closePriceFormReveal('item', () => {
        priceFormOpen = false;
      });
    } else {
      priceFormOpen = true;
      await renderPriceTrack();
      if (priceLogFormOpen) root.querySelector('[data-price-form-reveal="log"]')?.classList.add('is-open');
      revealPriceForm('item');
    }
    return;
  }
  const closePriceForm = ev.target.closest('[data-close-price-form]');
  if (closePriceForm) {
    await closePriceFormReveal('item', () => {
      priceFormOpen = false;
    });
    return;
  }

  const submitPriceItem = ev.target.closest('[data-submit-price-item]');
  if (submitPriceItem) {
    if (priceWritePending) return;
    const name = ($('#pi-name').value || '').trim();
    if (!name) { showToast('Enter an item name'); return; }
    priceWritePending = true;
    const stopBusy = beginPriceBusy(submitPriceItem, 'Saving…');
    try {
      const category = (await resolveTagFromForm()) || 'Other';
      let meta = {};
      const catLower = category.toLowerCase();

      if (catLower === 'transport') { meta.source = $('#pt-source')?.value || ''; meta.destination = $('#pt-destination')?.value || ''; }
      if (catLower === 'rent') meta.location = $('#pt-location')?.value || '';

      meta = priceTrackerItemMeta(category, meta);

      const existingItem = priceItems.find(item => priceTrackerItemsMatch(item, name, category, meta, ''));
      if (existingItem) {
        pendingPriceItemId = existingItem.id;
        await closePriceFormReveal('item', () => {
          priceFormOpen = false;
        });
        showToast('Item is already being tracked');
        return;
      }

      priceTrackDictionary[name] = { category, meta };
      await Store.set('price-track-dict', priceTrackDictionary);

      const item = { id: uid(), name, category, history: [], meta };
      priceItems.push(item);
      pendingPriceItemId = item.id;
      await Store.set('price-items', priceItems);
      await closePriceFormReveal('item', () => {
        priceFormOpen = false;
      });
      showToast('Item added');
    } catch (error) {
      console.error('Could not add price item:', error);
      showToast('Could not add this item');
    } finally {
      priceWritePending = false;
      stopBusy();
    }
    return;
  }

  const delPriceItemBtn = ev.target.closest('[data-del-price-item]');
  if (delPriceItemBtn) { ev.stopPropagation(); showDeleteCallout(delPriceItemBtn, 'confirm-del-price-item', delPriceItemBtn.dataset.delPriceItem); return; }
  const confirmDelPriceItem = ev.target.closest('[data-confirm-del-price-item]');
  if (confirmDelPriceItem) {
    ev.stopPropagation();
    const id = confirmDelPriceItem.dataset.confirmDelPriceItem;
    const card = root.querySelector(`[data-price-card="${CSS.escape(id)}"]`);
    hideDeleteCallout();
    await animatePriceRemoval(card, 'price-item-removing');
    priceItems = priceItems.filter(i => i.id !== id);
    if (priceExpandedId === id) { priceExpandedId = null; priceLogFormOpen = false; }
    await Store.set('price-items', priceItems);
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
          priceChartAnimateId = id;
          await renderPriceTrack();
        }, 300);
      } else { priceExpandedId = id; priceLogFormOpen = false; priceSlideDirection = ''; priceChartAnimateId = id; await renderPriceTrack(); }
      return;
    }
    priceExpandedId = id; priceLogFormOpen = false; priceSlideDirection = ''; priceChartAnimateId = id;
    await renderPriceTrack();
    return;
  }

  const openPriceLogForm = ev.target.closest('[data-open-price-log-form]');
  if (openPriceLogForm) {
    if (priceLogFormOpen) {
      await closePriceFormReveal('log', () => {
        priceLogFormOpen = false;
      });
    } else {
      priceLogFormOpen = true;
      await renderPriceTrack();
      if (priceFormOpen) root.querySelector('[data-price-form-reveal="item"]')?.classList.add('is-open');
      revealPriceForm('log');
    }
    return;
  }
  const closePriceLogForm = ev.target.closest('[data-close-price-log-form]');
  if (closePriceLogForm) {
    await closePriceFormReveal('log', () => {
      priceLogFormOpen = false;
    });
    return;
  }

  const submitPricePoint = ev.target.closest('[data-submit-price-point]');
  if (submitPricePoint) {
    if (priceWritePending) return;
    const itemId = submitPricePoint.dataset.submitPricePoint;
    const item = priceItems.find(i => i.id === itemId);
    if (!item) return;
    const date = $('#pp-date').value || new Date().toISOString().slice(0, 10);
    const price = Number($('#pp-price').value);
    const note = ($('#pp-note').value || '').trim();
    const catLower = String(item.category || '').trim().toLowerCase();
    const usesUnitPrice = catLower === 'groceries' || catLower === 'fuel';
    const quantity = usesUnitPrice ? ($('#pp-quantity')?.value || '').trim() : '';

    if (Number.isNaN(price) || price < 0) { showToast('Enter a valid price'); return; }

    const normalizedPoint = normalizePriceTrackerPoint(item.category, price, quantity);

    if (usesUnitPrice && !normalizedPoint) {
      showToast(catLower === 'fuel' ? 'Enter quantity as litres, for example 5L' : 'Enter quantity as weight, volume or pieces, for example 500g, 1kg, 750ml, 1L or 12');
      return;
    }

    if (item.unit && normalizedPoint?.unit && item.unit !== normalizedPoint.unit) {
      showToast(`This item is tracked per ${item.unit}; enter a compatible quantity`);
      return;
    }

    priceWritePending = true;
    const stopBusy = beginPriceBusy(submitPricePoint, 'Logging…');
    try {
      const point = usesUnitPrice
        ? { id: uid(), date, price: normalizedPoint.price, rawPrice: normalizedPoint.rawPrice, quantity: normalizedPoint.quantity, unit: normalizedPoint.unit, note }
        : { id: uid(), date, price, note };

      if (!item.unit && normalizedPoint?.unit) item.unit = normalizedPoint.unit;
      item.history.push(point);
      pendingPricePoint = { itemId, pointId: point.id };
      await Store.set('price-items', priceItems);
      await closePriceFormReveal('log', () => {
        priceLogFormOpen = false;
      });
      showToast('Price logged');
    } catch (error) {
      console.error('Could not log price:', error);
      showToast('Could not log this price');
    } finally {
      priceWritePending = false;
      stopBusy();
    }
    return;
  }

  const delPricePoint = ev.target.closest('[data-del-price-point]');
  if (delPricePoint) {
    ev.stopPropagation();
    showDeleteCallout(delPricePoint, 'confirm-del-price-point', delPricePoint.dataset.delPricePoint, 'Delete entry?');
    return;
  }

  const confirmDelPricePoint = ev.target.closest('[data-confirm-del-price-point]');
  if (confirmDelPricePoint) {
    ev.stopPropagation();
    const [itemId, pointId] = confirmDelPricePoint.dataset.confirmDelPricePoint.split('|');
    const item = priceItems.find(i => i.id === itemId);
    if (!item) return;

    const row = root.querySelector(`[data-price-point-row="${CSS.escape(pointId)}"]`);
    hideDeleteCallout();
    await animatePriceRemoval(row, 'price-point-row-removing', 160);
    item.history = item.history.filter(h => h.id !== pointId);
    await Store.set('price-items', priceItems);
    await renderPriceTrack();
    showToast('Entry removed');
    return;
  }
});

root.addEventListener('change', (ev) => {
  if (ev.target.id === 'f-tag') {
    const val = ev.target.value.toLowerCase();
    const customWrap = $('#f-tag-custom-wrap');
    if (customWrap) customWrap.style.display = val === '__custom__' ? 'block' : 'none';

    const ptDynamicWrap = $('#pt-dynamic-fields');
    if (ptDynamicWrap) {
      if (val === 'groceries') ptDynamicWrap.innerHTML = '';
      else if (val === 'transport') ptDynamicWrap.innerHTML = `<div class="field"><label>Source</label><input id="pt-source" type="text" placeholder="e.g. Home" /></div><div class="field"><label>Destination</label><input id="pt-destination" type="text" placeholder="e.g. Office" /></div>`;
      else if (val === 'fuel') ptDynamicWrap.innerHTML = '';
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
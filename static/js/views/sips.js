/* ---------- /sips ---------- */
import { Store } from '../core/store.js';
import { $, uid, escapeHtml } from '../core/dom.js';
import { fmtINR, monthKeyLabel, currentMonthKey, ordinalSuffix } from '../core/format.js';
import { authReady } from '../core/auth.js';
import { appendPageChrome } from '../components/page-chrome.js';
import { showToast } from '../components/toast.js';
import { showDeleteCallout, hideDeleteCallout, wireDeletePopoverDismiss } from '../components/delete-popover.js';
import { markRendered } from '../components/render-guard.js';

const root = document.getElementById('sips-root');
let sipSeries = [];
let existingInvestments = 0;
let domainLoaded = false;
let isSipFormOpen = false;
let editingSipId = null;
let isEditingFoundation = false;

function getAssetIcon(category) {
  const cat = (category || 'Mutual Fund').toLowerCase();
  if (cat === 'stock') {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"></polyline><polyline points="14 7 21 7 21 14"></polyline></svg>`;
  } else if (cat === 'etf') {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>`;
  } else {
    // Mutual Fund: Clean coin stack
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="7" ry="3"></ellipse><path d="M5 5v4c0 1.7 3.1 3 7 3s7-1.3 7-3V5"></path><path d="M5 9v4c0 1.7 3.1 3 7 3s7-1.3 7-3V9"></path><path d="M5 13v4c0 1.7 3.1 3 7 3s7-1.3 7-3v-4"></path></svg>`;
  }
}

// Icons for actions
const ICONS = {
  skip: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>`,
  pause: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`,
  resume: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`,
  delete: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>`
};

async function renderSips() {
  if (!domainLoaded) {
    [sipSeries, existingInvestments] = await Promise.all([
      Store.get('sipseries', []),
      Store.get('existinginvestments', 0),
    ]);
    domainLoaded = true;
  }

  const currentMonth = currentMonthKey();
  const monthData = await Store.get('month:' + currentMonth, { deletedSip: [] });
  const currentDeletedSips = monthData.deletedSip || [];
  
  // Filter into active and paused
  const activeSips = sipSeries.filter(s => (!s.endMonth || s.endMonth >= currentMonth) && s.status !== 'paused');
  const pausedSips = sipSeries.filter(s => (!s.endMonth || s.endMonth >= currentMonth) && s.status === 'paused');
  
  const totalMonthlySip = activeSips.reduce((sum, s) => sum + Number(s.amount), 0);

  const foundationContent = isEditingFoundation ? `
    <div class="ifc-edit-mode">
      <div class="field ifc-edit-field"><input id="ext-invest-amount" type="number" step="0.01" min="0" value="${existingInvestments || 0}" /></div>
      <div class="ifc-edit-actions">
        <button class="btn primary" id="ext-invest-save">Save Base</button>
        <button class="btn ghost" id="ext-invest-cancel" style="color:var(--ice)">Cancel</button>
      </div>
    </div>
  ` : `
    <div class="ifc-left">
      <div class="ifc-title">Your Investment Foundation</div>
      <div class="ifc-value-row">
        <span class="ifc-val">${fmtINR(existingInvestments)}</span>
        <svg class="ifc-sparkline" viewBox="0 0 80 24" fill="none">
          <defs>
            <linearGradient id="spark-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stop-color="var(--spark-stroke-start, var(--sky))"/>
              <stop offset="100%" stop-color="var(--spark-stroke-end, var(--blue-soft))"/>
            </linearGradient>
            <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--spark-fill-color, var(--sky))" stop-opacity="var(--spark-fill-opacity, 0.45)"/>
              <stop offset="100%" stop-color="var(--spark-fill-color, var(--sky))" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <path d="M0,20 Q10,20 15,15 T30,12 T45,16 T60,8 T80,2 L80,24 L0,24 Z" fill="url(#spark-fill)" stroke="none" />
          <path d="M0,20 Q10,20 15,15 T30,12 T45,16 T60,8 T80,2" stroke="url(#spark-grad)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
    </div>
    <div class="ifc-subtitle">Base corpus, combining dynamically with recurring SIPs.</div>
    <div class="ifc-right">
      <button class="btn secondary" id="manage-base-btn"><span style="margin-right: 6px; display: inline-flex; width: 16px; height: 16px;">${ICONS.edit}</span> Manage Base</button>
    </div>
  `;

  const renderCard = (s, isPaused) => {
    const isSkippedThisMonth = (s.skipMonths && s.skipMonths.includes(currentMonth)) || currentDeletedSips.includes(s.id);
    return `
    <div class="sip-card ${isPaused ? 'paused' : ''}">
      <div class="sip-card-header">
        <div class="sip-icon-wrap">${getAssetIcon(s.category)}</div>
        <div class="sip-meta" style="flex: 1; min-width: 0;">
          <div class="sip-name">${escapeHtml(s.description)}</div>
        </div>
        <button data-edit-sip="${s.id}" title="Edit SIP" style="background: transparent; border: none; cursor: pointer; color: var(--muted); flex-shrink: 0; padding: 6px; border-radius: 8px; display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; margin-top: -4px; transition: all 0.2s ease;" onmouseover="this.style.backgroundColor='var(--ice)'; this.style.color='var(--royal)';" onmouseout="this.style.backgroundColor='transparent'; this.style.color='var(--muted)';">
          <div style="width: 18px; height: 18px; display: flex; align-items: center; justify-content: center;">
            ${ICONS.edit}
          </div>
        </button>
      </div>
      <div class="sip-desc">Started ${monthKeyLabel(s.startMonth)} | Deducts every ${s.dayOfMonth}${ordinalSuffix(s.dayOfMonth)}</div>
      <div class="sip-card-footer">
        <div class="sip-amount"><strong>${fmtINR(s.amount)}</strong><span class="sip-mo">/ mo</span></div>
        <div class="sip-actions">
          ${!isPaused ? `<button class="icon-btn ${isSkippedThisMonth ? 'skipped-active' : ''}" data-skip-sip="${s.id}" title="${isSkippedThisMonth ? 'Cancel skip for this month' : 'Skip next deduction'}">${ICONS.skip}</button>` : ''}
          ${!isPaused ? `<button class="icon-btn" data-pause-sip="${s.id}" title="Pause SIP">${ICONS.pause}</button>` : `<button class="icon-btn restore-active" data-resume-sip="${s.id}" title="Resume SIP">${ICONS.resume}</button>`}
          <button class="icon-btn danger-hover" data-popover-trigger data-del-sip-series="${s.id}" title="Delete SIP">${ICONS.delete}</button>
        </div>
      </div>
    </div>`;
  };

  const sipCardsHtml = activeSips.map(s => renderCard(s, false)).join('') || `<div class="empty-chart" style="grid-column: 1/-1;">No active SIPs tracked — add one below.</div>`;
  const pausedCardsHtml = pausedSips.map(s => renderCard(s, true)).join('');

  let editData = editingSipId ? sipSeries.find(s => s.id === editingSipId) : null;
  const sipFormHtml = isSipFormOpen ? `
    <div class="form-panel slide-down-fade sip-form-panel">
      <div class="form-row">
        <div class="field">
          <label>Category</label>
          <select id="sip-category">
            <option value="Mutual Fund" ${editData && editData.category === 'Mutual Fund' ? 'selected' : ''}>Mutual Fund</option>
            <option value="Stock" ${editData && editData.category === 'Stock' ? 'selected' : ''}>Stock</option>
            <option value="ETF" ${editData && editData.category === 'ETF' ? 'selected' : ''}>ETF</option>
          </select>
        </div>
        <div class="field"><label>Fund / Stock Name</label><input id="sip-desc" type="text" placeholder="e.g. Nifty Index Fund" value="${editData ? escapeHtml(editData.description) : ''}" /></div>
      </div>
      <div class="form-row">
        <div class="field"><label>Amount (₹ / month)</label><input id="sip-amount" type="number" step="0.01" min="0" placeholder="0.00" value="${editData ? editData.amount : ''}" /></div>
        <div class="field"><label>Deduction Date</label><input id="sip-day" type="number" step="1" min="1" max="31" placeholder="e.g. 5" value="${editData ? editData.dayOfMonth : ''}" /></div>
      </div>
      <div class="form-actions">
        <button class="btn primary" id="sip-add">${editData ? 'Save Changes' : 'Confirm Setup'}</button>
        <button class="btn ghost" id="sip-cancel">Cancel</button>
      </div>
    </div>
  ` : '';

  const tb = document.getElementById('global-topbar');
  if (tb) tb.style.display = '';

  markRendered(root);
  root.innerHTML = `
  <div class="section">
    <div class="portfolio-summary-grid">
      <div class="invest-foundation-card">
        ${foundationContent}
      </div>
      <div class="total-sip-card">
        <div class="tsc-top">
          <div class="ifc-title">TOTAL MONTHLY SIP</div>
          <div class="tsc-val num">${fmtINR(totalMonthlySip)}</div>
          <div class="tsc-mo">per month</div>
        </div>
        <div class="ifc-subtitle" style="margin-top: 12px; margin-bottom: 0;">Aggregated monthly contribution across all active SIPs.</div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title"><h2>Active SIPs</h2><span class="hint">Automated recurring investments</span></div>
    <div class="sip-grid">${sipCardsHtml}</div>
    <div style="margin-top: 20px;">
      ${!isSipFormOpen ? `<button class="pill-btn active" id="open-sip-form" type="button">+ Add New SIP</button>` : ''}
      ${sipFormHtml}
    </div>
  </div>

  ${pausedSips.length > 0 ? `
  <div class="section" style="margin-top: 40px; border-top: 1px solid var(--hair); padding-top: 30px;">
    <div class="section-title"><h2>Paused SIPs</h2><span class="hint">Currently on hold</span></div>
    <div class="sip-grid">${pausedCardsHtml}</div>
  </div>` : ''}
  `;

  appendPageChrome(root);
}

root.addEventListener('click', async (ev) => {
  // Foundation Handlers
  if (ev.target.closest('#manage-base-btn')) { isEditingFoundation = true; await renderSips(); return; }
  if (ev.target.closest('#ext-invest-cancel')) { isEditingFoundation = false; await renderSips(); return; }
  if (ev.target.closest('#ext-invest-save')) {
    existingInvestments = Number($('#ext-invest-amount')?.value) || 0;
    await Store.set('existinginvestments', existingInvestments);
    isEditingFoundation = false;
    await renderSips();
    showToast('Investment foundation updated');
    return;
  }

  // Form Toggles
  if (ev.target.closest('#open-sip-form')) { isSipFormOpen = true; editingSipId = null; await renderSips(); return; }
  if (ev.target.closest('#sip-cancel')) { isSipFormOpen = false; editingSipId = null; await renderSips(); return; }

  // Edit SIP Action
  const editBtn = ev.target.closest('[data-edit-sip]');
  if (editBtn) {
    editingSipId = editBtn.dataset.editSip;
    isSipFormOpen = true;
    await renderSips();
    const form = document.querySelector('.sip-form-panel');
    if (form) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  // Add / Edit SIP
  if (ev.target.closest('#sip-add')) {
    ev.preventDefault();
    const category = $('#sip-category').value;
    const desc = $('#sip-desc').value.trim();
    const amount = Number($('#sip-amount').value);
    const dayOfMonth = Number($('#sip-day').value);
    if (!desc || !amount || amount <= 0 || !dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31) { 
      showToast('Enter a valid fund name, amount, and date (1-31)'); 
      return; 
    }

    if (editingSipId) {
      const sip = sipSeries.find(s => s.id === editingSipId);
      if (sip) {
        sip.category = category;
        sip.description = desc;
        sip.amount = amount;
        sip.dayOfMonth = dayOfMonth;
      }
      showToast('SIP updated');
    } else {
      sipSeries.push({ id: uid(), category, description: desc, amount, dayOfMonth, startMonth: currentMonthKey(), status: 'active', skipMonths: [] });
      showToast(`SIP added: deducts on the ${dayOfMonth}${ordinalSuffix(dayOfMonth)} every month`);
    }

    await Store.set('sipseries', sipSeries);
    isSipFormOpen = false;
    editingSipId = null;
    await renderSips();
    return;
  }

  // Action: Skip
  const skipBtn = ev.target.closest('[data-skip-sip]');
  if (skipBtn) {
    const sipId = skipBtn.dataset.skipSip;
    const sip = sipSeries.find(s => s.id === sipId);
    const mKey = currentMonthKey();
    
    const monthData = await Store.get('month:' + mKey, { deletedSip: [] });
    monthData.deletedSip = monthData.deletedSip || [];

    sip.skipMonths = sip.skipMonths || [];
    const isSkipped = sip.skipMonths.includes(mKey) || monthData.deletedSip.includes(sipId);

    if (isSkipped) {
      sip.skipMonths = sip.skipMonths.filter(m => m !== mKey);
      monthData.deletedSip = monthData.deletedSip.filter(id => id !== sipId);
      showToast('Skip cancelled. Deduction restored for this month.');
    } else {
      sip.skipMonths.push(mKey);
      if (!monthData.deletedSip.includes(sipId)) monthData.deletedSip.push(sipId);
      showToast(`Skipping deduction for ${monthKeyLabel(mKey)}`);
    }
    await Store.set('sipseries', sipSeries);
    await Store.set('month:' + mKey, monthData);
    await renderSips();
    return;
  }

  // Action: Pause
  const pauseBtn = ev.target.closest('[data-pause-sip]');
  if (pauseBtn) {
    const sip = sipSeries.find(s => s.id === pauseBtn.dataset.pauseSip);
    sip.status = 'paused';
    sip.pausedMonth = currentMonthKey();
    await Store.set('sipseries', sipSeries);
    await renderSips();
    showToast('SIP paused');
    return;
  }

  // Action: Resume
  const resumeBtn = ev.target.closest('[data-resume-sip]');
  if (resumeBtn) {
    const sip = sipSeries.find(s => s.id === resumeBtn.dataset.resumeSip);
    sip.status = 'active';
    sip.pausedMonth = null;
    await Store.set('sipseries', sipSeries);
    await renderSips();
    showToast('SIP resumed');
    return;
  }

  // Action: Delete (Preserve Ledger History)
  const delSipSeriesBtn = ev.target.closest('[data-del-sip-series]');
  if (delSipSeriesBtn) {
    ev.stopPropagation();
    showDeleteCallout(delSipSeriesBtn, 'confirm-del-sip-series', delSipSeriesBtn.dataset.delSipSeries, 'Stop SIP?');
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
    showToast('SIP permanently deleted');
  }
});

wireDeletePopoverDismiss(root);
window.addEventListener('auth:signed-in', renderSips);
window.addEventListener('auth:checked', renderSips);
authReady.then(renderSips);
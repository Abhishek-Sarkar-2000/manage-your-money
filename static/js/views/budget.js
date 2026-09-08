/* ---------- /budget ---------- */
import { Store } from '../core/store.js';
import { $, $$, uid, escapeHtml } from '../core/dom.js';
import { fmtINR, currentMonthKey } from '../core/format.js';
import { authReady } from '../core/auth.js';
import { appendPageChrome } from '../components/page-chrome.js';
import { showToast } from '../components/toast.js';
import { markRendered } from '../components/render-guard.js';
import { allSpendTags } from '../core/domain.js';
import { showDeleteCallout, hideDeleteCallout, wireDeletePopoverDismiss } from '../components/delete-popover.js';

const root = document.getElementById('budget-root');
const DEFAULT_TAGS = ['Groceries', 'Dining', 'Food', 'Fuel', 'Transport', 'Rent', 'Utility', 'Shopping', 'Recharge', 'Medicine', 'Gift', 'EMI', 'SIP', 'RECURRING'];

let budgetData = [];
let customTags = [];
let monthEntries = [];
let domainLoaded = false;
let isFormOpen = false;
let draggedItem = null;

async function loadDomain() {
  if (domainLoaded) return;
  [budgetData, customTags] = await Promise.all([
    Store.get('budget-data', []),
    Store.get('custom-spend-tags', [])
  ]);
  const monthData = await Store.get('month:' + currentMonthKey(), { entries: [] });
  monthEntries = monthData.entries || [];
  domainLoaded = true;
}

function calculateUsed(name, isSub, parentName) {
  return monthEntries.reduce((sum, e) => {
    if (['spend', 'cardcharge', 'cashpayment'].includes(e.type)) {
      let isMatch = false;
      if (isSub) {
        isMatch = (e.tag || '').toLowerCase() === (parentName || '').toLowerCase() &&
                  (e.subCategory || '').toLowerCase() === name.toLowerCase();
      } else {
        isMatch = (e.tag || 'Untagged').toLowerCase() === name.toLowerCase();
      }

      if (isMatch) {
        let lentAmount = 0;
        if (Array.isArray(e.lent)) {
          e.lent.forEach(l => { lentAmount += Number(l.amount) || 0; });
        }
        const personal = (Number(e.amount) || 0) - lentAmount;
        return sum + personal;
      }
    }
    return sum;
  }, 0);
}

// pct -> { label, cls } used for both row status pills and the KPI overall pill
function getStatusInfo(pct) {
  if (pct > 100) return { label: 'Over budget', cls: 'status-over' };
  if (pct > 70) return { label: 'High spend', cls: 'status-high' };
  return { label: 'On track', cls: 'status-ontrack' };
}

function computeSummary() {
  let totalBudget = 0;
  let totalUsed = 0;

  // Only top-level categories are counted: subcategory budgets/spend are
  // subsets of their parent category and would otherwise be double counted.
  budgetData.forEach(cat => {
    totalBudget += Number(cat.budget) || 0;
    totalUsed += calculateUsed(cat.name, false, null);
  });

  const totalRemaining = totalBudget - totalUsed;
  const usedPct = totalBudget > 0 ? (totalUsed / totalBudget) * 100 : (totalUsed > 0 ? 100 : 0);
  const remainingPct = totalBudget > 0 ? Math.max(0, (totalRemaining / totalBudget) * 100) : 0;

  return { totalBudget, totalUsed, totalRemaining, usedPct, remainingPct };
}

function renderSummaryCards() {
  const { totalBudget, totalUsed, totalRemaining, usedPct, remainingPct } = computeSummary();
  const status = getStatusInfo(usedPct);

  const briefcaseSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"></rect><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"></path><path d="M2 13h20"></path></svg>`;
  const coinsSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="8" ry="3"></ellipse><path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6"></path><path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"></path></svg>`;
  const clockSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 15"></polyline></svg>`;

  const remainingClass = totalRemaining < 0 ? 'negative' : '';
  const remainingPctDisplay = totalRemaining < 0 ? '0%' : `${remainingPct.toFixed(1)}%`;

  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const clampedPct = Math.min(Math.max(usedPct, 0), 100);
  const dashOffset = circumference - (clampedPct / 100) * circumference;
  const ringColor = usedPct > 100 ? 'var(--debit)' : 'var(--credit)';

  return `
  <div class="budget-summary-grid">
    <div class="kpi-card">
      <div class="kpi-icon">${briefcaseSvg}</div>
      <div class="kpi-body">
        <div class="kpi-label">Total Budget</div>
        <div class="kpi-value">${fmtINR(totalBudget)}</div>
      </div>
    </div>
    <div class="kpi-card">
      <div class="kpi-icon">${coinsSvg}</div>
      <div class="kpi-body">
        <div class="kpi-label">Used</div>
        <div class="kpi-value">${fmtINR(totalUsed)}</div>
        <div class="kpi-sub blue">${usedPct.toFixed(1)}%</div>
      </div>
    </div>
    <div class="kpi-card">
      <div class="kpi-icon">${clockSvg}</div>
      <div class="kpi-body">
        <div class="kpi-label">Remaining</div>
        <div class="kpi-value ${remainingClass}">${fmtINR(totalRemaining)}</div>
        <div class="kpi-sub green">${remainingPctDisplay}</div>
      </div>
    </div>
    <div class="kpi-card status-card">
      <svg width="48" height="48" viewBox="0 0 48 48">
        <circle cx="24" cy="24" r="${radius}" fill="none" stroke="var(--hair)" stroke-width="5"></circle>
        <circle cx="24" cy="24" r="${radius}" fill="none" stroke="${ringColor}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${dashOffset.toFixed(2)}" transform="rotate(-90 24 24)"></circle>
        <text x="24" y="28" text-anchor="middle" font-size="11" font-family="'IBM Plex Mono', monospace" fill="var(--navy)">${Math.round(usedPct)}%</text>
      </svg>
      <div class="kpi-body">
        <div class="kpi-label">Overall</div>
        <div class="kpi-sub">${usedPct.toFixed(1)}% used</div>
        <span class="kpi-status-pill status-pill ${status.cls}">${status.label}</span>
      </div>
    </div>
  </div>
  `;
}

function renderBudgetRow(item, isSub, parentId) {
  let parentName = null;
  if (isSub && parentId) {
    const parent = budgetData.find(c => c.id === parentId);
    if (parent) parentName = parent.name;
  }
  const used = calculateUsed(item.name, isSub, parentName);
  const pct = item.budget > 0 ? (used / item.budget) * 100 : 0;
  const isDanger = pct > 100;
  const status = item.budget > 0 ? getStatusInfo(pct) : { label: 'Unassigned', cls: 'status-unassigned' };

  const dragHandleSvg = `<svg class="drag-handle" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"></circle><circle cx="15" cy="6" r="1.6"></circle><circle cx="9" cy="12" r="1.6"></circle><circle cx="15" cy="12" r="1.6"></circle><circle cx="9" cy="18" r="1.6"></circle><circle cx="15" cy="18" r="1.6"></circle></svg>`;

  const pencilSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>`;

  const warnSvg = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path></svg>`;

  let chevronHtml = '';
  if (!isSub && item.subcategories && item.subcategories.length > 0) {
    chevronHtml = `<button class="toggle-sub ${item.expanded ? 'expanded' : ''}" data-toggle-sub="${item.id}" title="${item.expanded ? 'Collapse' : 'Expand'}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></button>`;
  }

  return `
  <div class="budget-row ${isSub ? 'is-sub' : ''}" data-id="${item.id}" data-type="${isSub ? 'sub' : 'cat'}" ${parentId ? `data-parent-id="${parentId}"` : ''} draggable="true">
    <div class="cat-name-col">
      ${dragHandleSvg}
      ${escapeHtml(item.name)}
    </div>
    <div class="budget-amt-col">
      ${fmtINR(item.budget)}
    </div>
    <div class="budget-progress">
      <div style="text-align: right;">${fmtINR(used)} (${status.cls === 'status-unassigned' ? '--' : Math.round(pct)}%)</div>
      <div class="bp-bar"><div class="bp-fill ${isDanger ? 'danger' : ''}" style="width: ${Math.min(pct, 100)}%;"></div></div>
    </div>
    <div class="status-col">
      <span class="status-pill ${status.cls}">${status.cls === 'status-high' ? warnSvg : ''}${status.label}</span>
    </div>
    <div class="actions-col">
      ${chevronHtml}
      <button class="edit-budget-btn" data-edit-budget="${item.id}" data-type="${isSub ? 'sub' : 'cat'}" ${parentId ? `data-parent-id="${parentId}"` : ''} title="Edit budget">${pencilSvg}</button>
      <button class="icon-btn" data-popover-trigger data-del-budget="${item.id}" data-type="${isSub ? 'sub' : 'cat'}" ${parentId ? `data-parent-id="${parentId}"` : ''} title="Remove">✕</button>
    </div>
  </div>
  `;
}

async function renderBudget() {
  await loadDomain();

  let tableRows = '';
  budgetData.forEach(cat => {
    tableRows += renderBudgetRow(cat, false, null);
    if (cat.subcategories && cat.subcategories.length > 0) {
      const subRowsHtml = cat.subcategories.map(sub => renderBudgetRow(sub, true, cat.id)).join('');
      tableRows += `
      <div class="subcat-wrap ${cat.expanded ? 'expanded' : ''}" data-subcat-wrap="${cat.id}">
        <div class="subcat-inner">${subRowsHtml}</div>
      </div>
      `;
    }
  });

  if (!tableRows) {
    tableRows = `<div class="empty-chart" style="padding: 24px; grid-column: 1/-1;">No budgets set yet. Add one below.</div>`;
  }

  const allTags = allSpendTags(DEFAULT_TAGS, customTags);
  const tagOptions = allTags.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');

  const formHtml = isFormOpen ? `
  <div class="form-panel slide-down-fade" style="margin: 14px 0px;">
    <div class="form-row">
      <div class="field">
        <label>Category (Tag)</label>
        <select id="f-cat-name">
          <option value="" disabled selected>Select tag...</option>
          ${tagOptions}
          <option value="__custom__">+ Add custom tag</option>
        </select>
      </div>
      <div class="field" id="f-cat-custom-wrap" style="display:none;">
        <label>New tag name</label>
        <input id="f-cat-custom" type="text" placeholder="e.g. Pets" />
      </div>
      <div class="field">
        <label>Budget (₹)</label>
        <input id="f-cat-budget" type="number" step="0.01" min="0" placeholder="0.00" />
      </div>
    </div>
    <div id="subcat-container"></div>
    <div style="margin-top: 10px; margin-bottom: 14px;">
      <button class="btn ghost small" id="f-add-subcat" disabled>+ Add subcategory</button>
    </div>
    <div class="form-actions">
      <button class="btn primary" data-submit-budget type="button">Save Budget</button>
      <button class="btn ghost" data-close-budget-form type="button">Cancel</button>
    </div>
  </div>
  ` : '';

  const tb = document.getElementById('global-topbar');
  if (tb) tb.style.display = '';

  markRendered(root);
  root.innerHTML = `
  <div class="section">
    <div class="month-header"><h1>Budget</h1></div>
    <p style="color:var(--muted); max-width:56ch; margin-top:6px;">Set monthly goals for your tags and track your personal spending. Drag and drop rows to reorder.</p>
  </div>

  <div class="section">
    ${renderSummaryCards()}

    <div class="pill-grid" style="margin-bottom: 16px;">
      <button class="pill-btn ${isFormOpen ? '' : 'active'}" data-budget-form-toggle type="button">+ Add Budget</button>
    </div>
    ${formHtml}
    
    <div class="budget-list">
        <div class="budget-header">
            <div>Category</div>
            <div class="b-budget-header">Budget</div>
            <div class="b-used-header">Used</div>
            <div class="b-status-header">Status</div>
            <div></div>
        </div>
      ${tableRows}
    </div>
  </div>
  `;

  appendPageChrome(root);
}

// Drag & Drop Handlers
root.addEventListener('dragstart', (ev) => {
  const row = ev.target.closest('.budget-row');
  if (!row) return;
  draggedItem = {
    id: row.dataset.id,
    type: row.dataset.type,
    parentId: row.dataset.parentId || null
  };
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', draggedItem.id);
  row.style.opacity = '0.4';
});

root.addEventListener('dragend', (ev) => {
  const row = ev.target.closest('.budget-row');
  if (row) row.style.opacity = '1';
  document.querySelectorAll('.drag-over, .drag-over-right').forEach(el => {
    el.classList.remove('drag-over', 'drag-over-right');
  });
  draggedItem = null;
});

root.addEventListener('dragover', (ev) => {
  ev.preventDefault();
  const row = ev.target.closest('.budget-row');
  if (!row) return;

  const targetType = row.dataset.type;
  const targetParentId = row.dataset.parentId || null;
  const targetId = row.dataset.id;

  if (draggedItem && draggedItem.type === 'sub') {
    if (targetType === 'cat' || targetParentId !== draggedItem.parentId) {
      ev.dataTransfer.dropEffect = 'none';
      document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
      return;
    }
  }

  if (draggedItem && draggedItem.type === 'cat' && targetType === 'sub') {
    ev.dataTransfer.dropEffect = 'none';
    document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
    return;
  }

  const rect = row.getBoundingClientRect();
  const isBottomHalf = ev.clientY > rect.top + rect.height / 2;

  document.querySelectorAll('.drop-above, .drop-below').forEach(el => {
    if (el !== row) el.classList.remove('drop-above', 'drop-below');
  });

  row.classList.remove('drop-above', 'drop-below');
  row.classList.add(isBottomHalf ? 'drop-below' : 'drop-above');
});

root.addEventListener('dragleave', (ev) => {
  const row = ev.target.closest('.budget-row');
  if (row) {
    if (!row.contains(ev.relatedTarget)) {
      row.classList.remove('drop-above', 'drop-below');
    }
  }
});

root.addEventListener('dragend', (ev) => {
  const row = ev.target.closest('.budget-row');
  if (row) row.style.opacity = '1';
  document.querySelectorAll('.drop-above, .drop-below').forEach(el => {
    el.classList.remove('drop-above', 'drop-below');
  });
  draggedItem = null;
});

root.addEventListener('drop', async (ev) => {
  ev.preventDefault();
  const row = ev.target.closest('.budget-row');
  if (!row || !draggedItem) return;

  const targetId = row.dataset.id;
  const targetType = row.dataset.type;
  const targetParentId = row.dataset.parentId || null;

  if (draggedItem.type === 'sub') {
    if (targetType === 'cat' || targetParentId !== draggedItem.parentId) {
      document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
      draggedItem = null;
      return;
    }
  }

  if (draggedItem.type === 'cat' && targetType === 'sub') {
    document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
    draggedItem = null;
    return;
  }

  if (draggedItem.id === targetId) {
     document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
     draggedItem = null;
     return;
  }

  let itemToMove;
  if (draggedItem.type === 'cat') {
    const idx = budgetData.findIndex(c => c.id === draggedItem.id);
    if (idx > -1) itemToMove = budgetData.splice(idx, 1)[0];
  } else {
    const parent = budgetData.find(c => c.id === draggedItem.parentId);
    if (parent && parent.subcategories) {
      const idx = parent.subcategories.findIndex(s => s.id === draggedItem.id);
      if (idx > -1) itemToMove = parent.subcategories.splice(idx, 1)[0];
    }
  }

  if (!itemToMove) return;

  const rect = row.getBoundingClientRect();
  const isBottomHalf = ev.clientY > rect.top + rect.height / 2;

  if (targetType === 'cat') {
    const targetIdx = budgetData.findIndex(c => c.id === targetId);
    budgetData.splice(isBottomHalf ? targetIdx + 1 : targetIdx, 0, itemToMove);
  } else if (targetType === 'sub') {
    const parent = budgetData.find(c => c.id === targetParentId);
    if (parent && parent.subcategories) {
      const targetIdx = parent.subcategories.findIndex(s => s.id === targetId);
      parent.subcategories.splice(isBottomHalf ? targetIdx + 1 : targetIdx, 0, itemToMove);
      parent.expanded = true;
    }
  }

  document.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
  draggedItem = null;

  await Store.set('budget-data', budgetData);
  await renderBudget();
  showToast('Order updated');
});

// Click Handlers
root.addEventListener('click', async (ev) => {
  const formToggle = ev.target.closest('[data-budget-form-toggle]');
  if (formToggle) { isFormOpen = !isFormOpen; await renderBudget(); return; }
  
  const closeForm = ev.target.closest('[data-close-budget-form]');
  if (closeForm) { isFormOpen = false; await renderBudget(); return; }

  const toggleSub = ev.target.closest('[data-toggle-sub]');
  if (toggleSub) {
    const cat = budgetData.find(c => c.id === toggleSub.dataset.toggleSub);
    if (cat) {
      cat.expanded = !cat.expanded;
      await Store.set('budget-data', budgetData);
      
      // Toggle the wrapper class for smooth animation without re-render
      const wrapper = document.querySelector(`[data-subcat-wrap="${cat.id}"]`);
      if (wrapper) {
      wrapper.classList.toggle('expanded');
      }
      toggleSub.classList.toggle('expanded');

      // Save to store in the background (fire-and-forget)
      Store.set('budget-data', budgetData);
    }
    return;
  }

  if (ev.target.closest('#f-add-subcat')) {
    let catName = $('#f-cat-name').value;
    if (catName === '__custom__') catName = $('#f-cat-custom').value.trim();

    let existingSubs = [];
    if (catName) {
      const cat = budgetData.find(c => c.name.toLowerCase() === catName.toLowerCase());
      if (cat && cat.subcategories) existingSubs = cat.subcategories.map(s => s.name);
    }
    const subOptions = existingSubs.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');

    const container = $('#subcat-container');
    const row = document.createElement('div');
    row.className = 'form-row subcat-row';
    row.style.alignItems = 'flex-start';
    row.innerHTML = `
      <div class="field">
        <label>Sub-category Tag</label>
        <select class="sc-name-select" style="padding: 10px 12px; border: 1px solid var(--hair); border-radius: 7px; width: 100%; font-family: 'Source Serif 4', serif; font-size: 0.95rem; background: #fff;">
          <option value="" disabled selected>Select...</option>
          ${subOptions}
          <option value="__custom__">+ Add sub-category</option>
        </select>
        <input type="text" class="sc-name-custom" placeholder="e.g. Meat" style="display:none; margin-top: 6px; padding: 10px 12px; border: 1px solid var(--hair); border-radius: 7px; width: 100%; font-family: 'Source Serif 4', serif; font-size: 0.95rem;" />
      </div>
      <div style="display: flex; flex-wrap: nowrap; gap: 10px;">
        <div class="field" style="width: 100%;"><label>Budget (₹)</label><input type="number" step="0.01" min="0" class="sc-budget" placeholder="0.00" /></div>
        <button class="icon-btn" data-remove-subcat-row style="align-self: flex-end; margin-bottom: 8px;">✕</button>
      </div>
    `;
    container.appendChild(row);
    return;
  }
  
  if (ev.target.closest('[data-remove-subcat-row]')) {
    ev.target.closest('.subcat-row').remove();
    return;
  }

  if (ev.target.closest('[data-submit-budget]')) {
    let catName = $('#f-cat-name').value;
    if (catName === '__custom__') catName = $('#f-cat-custom').value.trim();
    const catBudget = Number($('#f-cat-budget').value) || 0;
    
    if (!catName || catBudget <= 0) { showToast('Enter valid category name and budget'); return; }

    const subcatRows = Array.from(document.querySelectorAll('.subcat-row'));
    const subcats = [];
    let subcatSum = 0;
    
    for (const row of subcatRows) {
      const select = row.querySelector('.sc-name-select');
      const custom = row.querySelector('.sc-name-custom');
      let sname = select ? select.value : '';
      if (sname === '__custom__') sname = custom.value.trim();

      const sbudg = Number(row.querySelector('.sc-budget').value) || 0;
      if (sname && sbudg > 0) {
        subcats.push({ id: uid(), name: sname, budget: sbudg });
        subcatSum += sbudg;
      }
    }

    if (subcatSum > catBudget) {
      showToast('Sum of sub-category budgets exceeds parent budget');
      return;
    }

    if (catName === '__custom__') {
       const custom = $('#f-cat-custom').value.trim();
       if (!allSpendTags(DEFAULT_TAGS, customTags).some(t => t.toLowerCase() === custom.toLowerCase())) {
         customTags.push(custom);
         await Store.set('custom-spend-tags', customTags);
       }
       catName = custom;
    }

    const existingIdx = budgetData.findIndex(c => c.name.toLowerCase() === catName.toLowerCase());
    if (existingIdx > -1) {
      budgetData[existingIdx].budget = catBudget;
      if (subcats.length > 0) {
         budgetData[existingIdx].subcategories = budgetData[existingIdx].subcategories || [];
         budgetData[existingIdx].subcategories.push(...subcats);
      }
    } else {
      budgetData.push({
        id: uid(),
        name: catName,
        budget: catBudget,
        expanded: true,
        subcategories: subcats
      });
    }

    await Store.set('budget-data', budgetData);
    isFormOpen = false;
    await renderBudget();
    showToast('Budget added');
    return;
  }

  const editBtn = ev.target.closest('[data-edit-budget]');
  if (editBtn) {
    const row = editBtn.closest('.budget-row');
    const amtCol = row.querySelector('.budget-amt-col');
    const currentAmtText = amtCol.textContent.trim().replace(/[^0-9.]/g, '');
    
    amtCol.innerHTML = `
      <input type="number" step="0.01" min="0" class="inline-edit-input" value="${currentAmtText}" />
      <button class="icon-btn" data-save-edit="${editBtn.dataset.editBudget}" data-type="${editBtn.dataset.type}" data-parent-id="${editBtn.dataset.parentId || ''}" style="color:var(--credit);">✓</button>
      <button class="icon-btn" data-cancel-edit style="color:var(--debit);">✕</button>
    `;
    amtCol.querySelector('.inline-edit-input').focus();
    return;
  }

  if (ev.target.closest('[data-cancel-edit]')) {
    await renderBudget();
    return;
  }

  const saveEdit = ev.target.closest('[data-save-edit]');
  if (saveEdit) {
    const id = saveEdit.dataset.saveEdit;
    const type = saveEdit.dataset.type;
    const parentId = saveEdit.dataset.parentId;
    const newBudget = Number(saveEdit.closest('.budget-amt-col').querySelector('.inline-edit-input').value);

    if (isNaN(newBudget) || newBudget < 0) { showToast('Invalid amount'); return; }

    if (type === 'cat') {
      const cat = budgetData.find(c => c.id === id);
      if (cat) {
        const sumSubs = (cat.subcategories || []).reduce((s, sub) => s + sub.budget, 0);
        if (newBudget < sumSubs) {
          showToast('Budget cannot be less than sum of sub-categories');
          return;
        }
        cat.budget = newBudget;
      }
    } else if (type === 'sub') {
      const parent = budgetData.find(c => c.id === parentId);
      if (parent) {
        const sumOtherSubs = (parent.subcategories || []).reduce((s, sub) => s + (sub.id === id ? 0 : sub.budget), 0);
        if (sumOtherSubs + newBudget > parent.budget) {
          showToast('Sub-category budgets exceed parent budget');
          return;
        }
        const sub = parent.subcategories.find(s => s.id === id);
        if (sub) sub.budget = newBudget;
      }
    }

    await Store.set('budget-data', budgetData);
    await renderBudget();
    showToast('Budget updated');
    return;
  }

  const delBtn = ev.target.closest('[data-del-budget]');
  if (delBtn) {
    ev.stopPropagation();
    showDeleteCallout(delBtn, 'confirm-del-budget', `${delBtn.dataset.type}|${delBtn.dataset.parentId || ''}|${delBtn.dataset.delBudget}`);
    return;
  }

  const confirmDel = ev.target.closest('[data-confirm-del-budget]');
  if (confirmDel) {
    ev.stopPropagation();
    const [type, parentId, id] = confirmDel.dataset.confirmDelBudget.split('|');
    if (type === 'cat') {
      budgetData = budgetData.filter(c => c.id !== id);
    } else {
      const parent = budgetData.find(c => c.id === parentId);
      if (parent && parent.subcategories) {
        parent.subcategories = parent.subcategories.filter(s => s.id !== id);
      }
    }
    await Store.set('budget-data', budgetData);
    hideDeleteCallout();
    await renderBudget();
    showToast('Budget removed');
    return;
  }
});

root.addEventListener('change', (ev) => {
  if (ev.target.matches('.sc-name-select')) {
    const customInput = ev.target.nextElementSibling;
    if (customInput && customInput.classList.contains('sc-name-custom')) {
      customInput.style.display = ev.target.value === '__custom__' ? 'block' : 'none';
      if (ev.target.value === '__custom__') customInput.focus();
    }
    return;
  }

  if (ev.target.id === 'f-cat-name') {
    const val = ev.target.value;
    const customWrap = $('#f-cat-custom-wrap');
    if (customWrap) customWrap.style.display = val === '__custom__' ? 'block' : 'none';
    
    const addSubBtn = $('#f-add-subcat');
    if (addSubBtn) addSubBtn.disabled = !val;

    $('#subcat-container').innerHTML = '';

    const budgetInput = $('#f-cat-budget');
    if (budgetInput && val !== '__custom__') {
      const existingCat = budgetData.find(c => c.name.toLowerCase() === val.toLowerCase());
      budgetInput.value = existingCat ? existingCat.budget : '';
    } else if (budgetInput) {
      budgetInput.value = '';
    }
  }
});

wireDeletePopoverDismiss(root);
window.addEventListener('auth:signed-in', renderBudget);
window.addEventListener('auth:checked', renderBudget);
authReady.then(renderBudget);
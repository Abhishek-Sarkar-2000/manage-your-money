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

function renderBudgetRow(item, isSub, parentId) {
  let parentName = null;
  if (isSub && parentId) {
    const parent = budgetData.find(c => c.id === parentId);
    if (parent) parentName = parent.name;
  }
  const used = calculateUsed(item.name, isSub, parentName);
  const pct = item.budget > 0 ? (used / item.budget) * 100 : (used > 0 ? 100 : 0);
  const isDanger = pct > 100;

  let toggleHtml = '';
  if (!isSub && item.subcategories && item.subcategories.length > 0) {
    toggleHtml = `<button class="toggle-sub ${item.expanded ? 'expanded' : ''}" data-toggle-sub="${item.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></button>`;
  } else if (!isSub) {
    toggleHtml = `<div style="width:22px;"></div>`;
  }

  const pencilSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>`;

  return `
  <div class="budget-row ${isSub ? 'is-sub' : ''}" data-id="${item.id}" data-type="${isSub ? 'sub' : 'cat'}" ${parentId ? `data-parent-id="${parentId}"` : ''} draggable="true">
    <div class="cat-name-col">
      ${toggleHtml}
      ${escapeHtml(item.name)}
    </div>
    <div class="budget-amt-col">
      ${fmtINR(item.budget)}
      <button class="edit-budget-btn" data-edit-budget="${item.id}" data-type="${isSub ? 'sub' : 'cat'}" ${parentId ? `data-parent-id="${parentId}"` : ''} title="Edit budget">${pencilSvg}</button>
    </div>
    <div class="budget-progress">
      <div style="text-align: right;">${fmtINR(used)} (${Math.round(pct)}%)</div>
      <div class="bp-bar"><div class="bp-fill ${isDanger ? 'danger' : ''}" style="width: ${Math.min(pct, 100)}%;"></div></div>
    </div>
    <div class="actions-col">
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
    if (cat.expanded && cat.subcategories) {
      cat.subcategories.forEach(sub => {
        tableRows += renderBudgetRow(sub, true, cat.id);
      });
    }
  });

  if (!tableRows) {
    tableRows = `<div class="empty-chart" style="padding: 24px; grid-column: 1/-1;">No budgets set yet. Add one below.</div>`;
  }

  const allTags = allSpendTags(DEFAULT_TAGS, customTags);
  const tagOptions = allTags.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  
  const formHtml = isFormOpen ? `
  <div class="form-panel slide-down-fade" style="margin-top: 14px;">
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
    <div class="pill-grid" style="margin-bottom: 16px;">
      <button class="pill-btn ${isFormOpen ? 'active' : ''}" data-budget-form-toggle type="button">+ Add Budget</button>
    </div>
    ${formHtml}
    
    <div class="budget-list">
        <div class="budget-header">
            <div style="flex: 1;">Category</div>
            <div class="b-budget-header">Budget</div>
            <div class="b-used-header">Used</div>
            <div style="width: 30px;"></div>
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
      await renderBudget();
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
      <div class="field"><label>Budget (₹)</label><input type="number" step="0.01" min="0" class="sc-budget" placeholder="0.00" /></div>
      <button class="icon-btn" data-remove-subcat-row style="align-self: flex-end; margin-bottom: 8px;">✕</button>
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
/* ---------- Delete-confirmation popover ----------
   Shared by every view that has a "✕ remove" icon button: months, cards,
   SIPs, EMI series, split groups, price-tracker items, etc. Each view wires
   its own [data-del-*] triggers and [data-confirm-*] handlers; this module
   only owns showing/positioning/hiding the shared popover element. */
import { escapeHtml } from '../core/dom.js';

export function showDeleteCallout(triggerEl, actionName, id, label = 'Delete?') {
  const pop = document.getElementById('del-popover');
  if (!pop) return;

  pop.innerHTML = `
    <span style="font-size: 0.9rem; font-weight: 600; color: var(--navy);">${escapeHtml(label)}</span>
    <div style="display: flex; gap: 6px;">
      <button class="icon-btn" data-${actionName}="${id}" style="color: var(--credit);" title="Confirm">✓</button>
      <button class="icon-btn" data-cancel-del style="color: var(--debit);" title="Cancel">✕</button>
    </div>
  `;

  pop.classList.add('show');

  const rect = triggerEl.getBoundingClientRect();
  const appRect = pop.offsetParent ? pop.offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
  const popWidth = pop.offsetWidth || 130;
  
  const viewLeft = rect.left - appRect.left - popWidth - 10;
  const viewTop = rect.top - appRect.top + (rect.height / 2) - ((pop.offsetHeight || 44) / 2);

  pop.style.left = viewLeft + 'px';
  pop.style.top = viewTop + 'px';
}

export function hideDeleteCallout() {
  const pop = document.getElementById('del-popover');
  if (pop) pop.classList.remove('show');
}

/* Wires the two behaviors shared by every page that uses this popover:
   dismiss on outside click, and the generic [data-cancel-del] button. Call
   once per page after the view's own root listeners are attached. */
export function wireDeletePopoverDismiss(root = document) {
  root.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-cancel-del]')) {
      ev.stopPropagation();
      hideDeleteCallout();
      return;
    }
    if (!ev.target.closest('#del-popover') && !ev.target.closest('[data-popover-trigger]')) {
      hideDeleteCallout();
    }
  });
}

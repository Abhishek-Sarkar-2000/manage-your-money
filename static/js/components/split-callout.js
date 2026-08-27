/* ---------- Split spend share callout ----------
   Positioned via JS so it always escapes table/scroll-container clipping,
   regardless of overflow ancestors. Used only by split.js / share-split.js. */
import { escapeHtml } from '../core/dom.js';
import { fmtINR } from '../core/format.js';

let pinnedKey = null;

function positionSplitCallout(pop, triggerEl) {
  const rect = triggerEl.getBoundingClientRect();
  const appRect = pop.offsetParent ? pop.offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
  const popWidth = pop.offsetWidth || 260;
  
  let viewLeft = rect.left;
  if (viewLeft + popWidth > window.innerWidth - 12) {
    viewLeft = Math.max(12, window.innerWidth - popWidth - 12);
  }
  
  let viewTop = rect.bottom + 6;
  const popHeight = pop.offsetHeight || 0;
  if (popHeight && viewTop + popHeight > window.innerHeight - 12) {
    viewTop = rect.top - popHeight - 6;
  }
  
  pop.style.left = (viewLeft - appRect.left) + 'px';
  pop.style.top = (viewTop - appRect.top) + 'px';
}

export function showSplitCallout(triggerEl) {
  const pop = document.getElementById('split-share-popover');
  if (!pop) return;
  let shares = [];
  try { shares = JSON.parse(triggerEl.dataset.spendShares || '[]'); } catch (e) { shares = []; }
  const rows = shares.map(sh => `<div class="pop-row"><span class="pn">${escapeHtml(sh.label)}</span><span class="pv">${fmtINR(sh.amount)}</span></div>`).join('');
  pop.innerHTML = `<div class="pop-title">Split breakdown</div>${rows}`;
  pop.classList.add('show');
  positionSplitCallout(pop, triggerEl);
}

export function hideSplitCallout() {
  const pop = document.getElementById('split-share-popover');
  if (pop) pop.classList.remove('show');
  pinnedKey = null;
}

/* Wires hover (desktop) + click-to-pin (touch) behavior for every
   [data-spend-toggle] element on the page. Call once after rendering. */
export function wireSplitCallouts(root = document) {
  root.addEventListener('click', (ev) => {
    const trigger = ev.target.closest('[data-spend-toggle]');
    if (trigger) {
      const key = trigger.dataset.spendShares;
      if (pinnedKey === key) {
        hideSplitCallout();
      } else {
        pinnedKey = key;
        showSplitCallout(trigger);
      }
      return;
    }
    if (!ev.target.closest('#split-share-popover')) hideSplitCallout();
  });

  root.addEventListener('mouseover', (ev) => {
    if (!window.matchMedia('(hover: hover)').matches) return;
    const trigger = ev.target.closest('[data-spend-toggle]');
    if (trigger) showSplitCallout(trigger);
  });
  root.addEventListener('mouseout', (ev) => {
    if (!window.matchMedia('(hover: hover)').matches) return;
    const trigger = ev.target.closest('[data-spend-toggle]');
    if (!trigger) return;
    const key = trigger.dataset.spendShares;
    if (pinnedKey === key) return; // stays open, it's pinned via click
    if (trigger.contains(ev.relatedTarget)) return;
    hideSplitCallout();
  });
}

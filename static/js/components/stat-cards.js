/* ---------- Stat cards (shared by Home + Month view) ---------- */
import { escapeHtml } from '../core/dom.js';
import { fmtINR, monthKeyShort } from '../core/format.js';
import { scrollWrapper } from './scroll-wrapper.js';

export function renderStatCards(stats, splitOwed) {
  const owedPop = stats.owed.list.length
    ? stats.owed.list.map(p => `<div class="pop-row"><span class="pn">${escapeHtml(p.person)}</span><span class="pv" style="color:var(--amber)">${fmtINR(p.amount)}</span></div>`).join('')
    : `<div class="pop-empty">Nobody owes you anything right now.</div>`;

  const investPop = stats.invested.list.length
    ? stats.invested.list.map(i => `<div class="pop-row"><span class="pn">${escapeHtml(i.description)}${i.monthKey ? `<span class="ps">${monthKeyShort(i.monthKey)}</span>` : ''}</span><span class="pv" style="color:var(--blue)">${fmtINR(i.amount)}</span></div>`).join('')
    : `<div class="pop-empty">No investments logged yet.</div>`;

  const cardPop = stats.cardDues.list.length
    ? stats.cardDues.list.map(c => `<div class="pop-row"><span class="pn">${escapeHtml(c.name)}</span><span class="pv" style="color:${c.dues > 0 ? 'var(--debit)' : 'var(--credit)'}">${fmtINR(c.dues)}</span></div>`).join('')
    : `<div class="pop-empty">No credit cards added yet.</div>`;

  const balancePop = stats.breakdown.length
    ? stats.breakdown.map(b => `
        <div class="pop-row stacked">
          <div class="pop-line1">${monthKeyShort(b.monthKey)} (<span style="color:var(--credit)">+${fmtINR(b.income)}</span> / <span style="color:var(--debit)">-${fmtINR(b.outflow)}</span>)</div>
          <div class="pop-line2">Start: ${fmtINR(b.starting)}</div>
        </div>`).join('')
    : `<div class="pop-empty">Add a month to see balances here.</div>`;

  const splitOwedCard = splitOwed ? (() => {
    const splitPop = splitOwed.list.length
      ? splitOwed.list.map(p => `<div class="pop-row"><span class="pn">${escapeHtml(p.person)}</span><span class="pv" style="color:var(--debit)">${fmtINR(p.amount)}</span></div>`).join('')
      : `<div class="pop-empty">You're all settled up.</div>`;
    return `
    <div class="stat-card owedbyyou" tabindex="0" data-stat-card>
      <div class="stat-back"><div class="pop-title">Who you owe</div>${splitPop}</div>
      <div class="stat-front" data-stat-toggle>
        <div class="label">Owed by you <span class="hoverdot">i</span></div>
        <div class="value" style="color:var(--debit)">${fmtINR(splitOwed.total)}</div>
      </div>
      <div class="stat-popover"><div class="pop-title">Who you owe</div>${splitPop}</div>
    </div>`;
  })() : '';

  const track = `
    <div class="stat-card left" tabindex="0" data-stat-card>
      <div class="stat-back"><div class="pop-title">starting balance + CR - DR</div>${balancePop}</div>
      <div class="stat-front" data-stat-toggle>
        <div class="label">Amount left <span class="hoverdot">i</span></div>
        <div class="value">${fmtINR(stats.amountLeft)}</div>
      </div>
      <div class="stat-popover"><div class="pop-title">starting balance + CR - DR</div>${balancePop}</div>
    </div>
    <div class="stat-card invest" tabindex="0" data-stat-card>
      <div class="stat-back"><div class="pop-title">${stats.invested.title || 'Every investment'}</div>${investPop}</div>
      <div class="stat-front" data-stat-toggle>
        <div class="label">Amount invested <span class="hoverdot">i</span></div>
        <div class="value">${fmtINR(stats.invested.total)}</div>
      </div>
      <div class="stat-popover"><div class="pop-title">${stats.invested.title || 'Every investment'}</div>${investPop}</div>
    </div>
    <div class="stat-card owed" tabindex="0" data-stat-card>
      <div class="stat-back"><div class="pop-title">Who owes you</div>${owedPop}</div>
      <div class="stat-front" data-stat-toggle>
        <div class="label">Owed to you <span class="hoverdot">i</span></div>
        <div class="value">${fmtINR(stats.owed.total)}</div>
      </div>
      <div class="stat-popover"><div class="pop-title">Who owes you</div>${owedPop}</div>
    </div>
    ${splitOwedCard}
    <div class="stat-card carddues" tabindex="0" data-stat-card>
      <div class="stat-back"><div class="pop-title">By card</div>${cardPop}</div>
      <div class="stat-front" data-stat-toggle>
        <div class="label">Credit card dues <span class="hoverdot">i</span></div>
        <div class="value">${fmtINR(stats.cardDues.total)}</div>
      </div>
      <div class="stat-popover"><div class="pop-title">By card</div>${cardPop}</div>
    </div>`;

  return scrollWrapper(track, 'stats-grid');
}

/* Mobile tap-to-flip behavior — the desktop hover state is pure CSS. */
export function wireStatCardFlip(root = document) {
  root.addEventListener('click', (ev) => {
    const statToggle = ev.target.closest('[data-stat-toggle]');
    if (statToggle && window.matchMedia('(hover: none)').matches) {
      const card = statToggle.closest('[data-stat-card]');
      const wasOpen = card.classList.contains('open');
      root.querySelectorAll('[data-stat-card].open').forEach(c => { if (c !== card) c.classList.remove('open'); });
      card.classList.toggle('open', !wasOpen);
      return;
    }
    const statBack = ev.target.closest('.stat-back');
    if (statBack && window.matchMedia('(hover: none)').matches) {
      const card = statBack.closest('[data-stat-card]');
      if (card) card.classList.remove('open');
    }
  });
}

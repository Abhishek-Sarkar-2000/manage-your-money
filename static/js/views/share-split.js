/* ---------- /share/split/<id> ----------
   Fully public: no auth bar chrome, no /api/storage calls. Reads via the
   dedicated /api/public/split/<id> endpoint (see app.py) and never writes,
   so the settle-up toggles below are deliberately read-only — the original
   monolith let a visitor click them, but the write would 401 silently
   since a public page never has a session; rendering them as plain state
   here is the same effective behavior with honest, non-interactive markup. */
import { escapeHtml } from '../core/dom.js';
import { fmtINR } from '../core/format.js';
import { loadSharedSplit, getYouLabel, computeGroupPaid, computeGroupSettlementView, SPLIT_YOU } from '../core/split-domain.js';
import { sharedStackedDebtChart, sharedSharesBarChart } from '../components/charts/split-charts.js';
import { scrollWrapper, setupScrollWrappers, setupTableScrollIndicators } from '../components/scroll-wrapper.js';
import { appendPageChrome } from '../components/page-chrome.js';
import { wireSplitCallouts } from '../components/split-callout.js';
import { markRendered } from '../components/render-guard.js';

const root = document.getElementById('share-split-root');
const shareId = root.dataset.shareId;

function renderSplitGroupCardReadOnly(group, youLabel) {
  const paid = computeGroupPaid(group);
  const dateLabel = group.createdAt ? new Date(group.createdAt + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
  const rows = group.people.map(p => `
    <div class="sgc-person"><span class="spn">${p === SPLIT_YOU ? youLabel() : escapeHtml(p.toUpperCase())}</span><span class="spv">${fmtINR(paid[p] || 0)}</span></div>`).join('');
  return `
  <div class="split-group-card active" data-split-card="${group.id}">
    <h4>${escapeHtml(group.description)}</h4>
    <div class="sgc-date">${dateLabel}</div>
    <div class="sgc-people">${rows}</div>
  </div>`;
}

function renderSplitShareCallout(group, s, youLabel) {
  const shares = group.people.map(p => ({
    label: p === SPLIT_YOU ? youLabel() : String(p).toUpperCase(),
    amount: Number((s.shares || {})[p]) || 0,
  }));
  const dataAttr = escapeHtml(JSON.stringify(shares));
  return `<span class="split-spend-cell" tabindex="0" data-spend-toggle data-spend-shares="${dataAttr}">${escapeHtml(s.description)}</span>`;
}

function renderSplitDetailsPanelReadOnly(group, youLabel) {
  const sortedSpends = [...group.spends].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const dateCounts = {};
  for (const s of sortedSpends) dateCounts[s.date] = (dateCounts[s.date] || 0) + 1;
  const seenDates = new Set();
  const rowsHtml = sortedSpends.map(s => {
    const dateLabel = s.date ? new Date(s.date + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—';
    let dateCell = '';
    if (!seenDates.has(s.date)) { seenDates.add(s.date); dateCell = `<td class="dv-date" rowspan="${dateCounts[s.date]}">${dateLabel}</td>`; }
    const payeeLabel = s.payee === SPLIT_YOU ? youLabel() : escapeHtml(String(s.payee).toUpperCase());
    return `<tr>${dateCell}<td>${renderSplitShareCallout(group, s, youLabel)}<span class="src-badge">${payeeLabel}</span></td><td class="num">${fmtINR(s.amount)}</td></tr>`;
  }).join('');

  return `
  <div class="split-details-panel" data-split-details="${group.id}" style="margin-top: 2px;">
    <div class="section-title"><h2>${escapeHtml(group.description)} - Ledger</h2><span class="hint">${group.people.length} people</span></div>
    <div class="form-note" style="margin-top:8px; margin-bottom:8px; border: none;">All group spends are listed here. Click a spend name to view share divisions.</div>
    <div class="table-wrap">
      <table class="divisions-table" ${rowsHtml ? '' : `style="width: 100%;"`}>
        <thead><tr><th>Date</th><th>Details</th><th ${rowsHtml ? `class="num"` : ''}>Amount</th><th></th></tr></thead>
        <tbody>${rowsHtml || `<tr class="empty-row"><td colspan="4">No spends logged in this group yet.</td></tr>`}</tbody>
      </table>
    </div>
  </div>`;
}

function renderSettleCardReadOnly(c, youLabel) {
  const from = c.from === SPLIT_YOU ? youLabel() : escapeHtml(c.from.toUpperCase());
  const to = c.to === SPLIT_YOU ? youLabel() : escapeHtml(c.to.toUpperCase());
  return `
  <div class="split-settle-card ${c.settled ? 'settled' : ''}">
    <div class="ssc-group">${escapeHtml(c.groupDesc || '')}</div>
    <div class="ssc-line"><strong>${from}</strong> pays <strong>${to}</strong></div>
    <div class="ssc-amount num">${fmtINR(c.amount)}</div>
    <label class="toggle-switch" style="pointer-events:none; opacity:0.6;">
      <input type="checkbox" disabled ${c.settled ? 'checked' : ''} />
      ${c.settled ? 'Settled' : 'Outstanding'}
    </label>
  </div>`;
}

async function renderSharedSplitPage() {
  document.body.dataset.isShared = 'true';
  document.body.classList.add('shared-mode');

  const { group, owner, error } = await loadSharedSplit(shareId);
  const youLabel = (possessive) => getYouLabel(true, owner, possessive);

  if (!group) {
    markRendered(root);
    root.innerHTML = `<div class="section"><div class="empty-chart">${error || 'This shared Split Money group could not be found.'}</div></div>`;
    return;
  }

  const { cards } = computeGroupSettlementView(group);
  const outstandingCards = cards.filter(c => !c.settled);
  const groupCardHtml = renderSplitGroupCardReadOnly(group, youLabel);
  const paid = computeGroupPaid(group);

  const settlementHtml = cards.length
    ? cards.sort((a, b) => (a.settled === b.settled) ? 0 : (a.settled ? 1 : -1))
        .map(c => renderSettleCardReadOnly({ ...c, groupId: group.id, groupDesc: group.description }, youLabel)).join('')
    : `<div class="empty-chart">No settlement transfers for this group.</div>`;

  const shareTotals = {};
  for (const person of group.people) shareTotals[person] = 0;
  for (const spend of (group.spends || [])) {
    for (const [person, amount] of Object.entries(spend.shares || {})) shareTotals[person] = (shareTotals[person] || 0) + (Number(amount) || 0);
  }
  const shareRows = group.people.map(person => {
    const label = person === SPLIT_YOU ? youLabel() : escapeHtml(String(person).toUpperCase());
    return `<tr><td>${label}</td><td class="num">${fmtINR(paid[person] || 0)}</td><td class="num">${fmtINR(shareTotals[person] || 0)}</td></tr>`;
  }).join('');

  markRendered(root);
  root.innerHTML = `
  <div class="section shared-page-header">
    <div class="month-header"><h1>${escapeHtml(group.description)}</h1></div>
    <p class="shared-page-subtitle">Shared Split Money group · ${group.people.length} people</p>
  </div>

  <div class="section">
    <div class="section-title"><h2>Group</h2><span class="hint">Shared view</span></div>
    ${groupCardHtml}
  </div>

  <div class="section">
    <div class="section-title"><h2>Split charts</h2><span class="hint">Outstanding balances and group shares</span></div>
    <div class="charts-grid shared-split-charts">
      <div class="chart-card shared-chart-card">
        <h4>Who owes how much</h4>
        <p class="shared-chart-description">Outstanding amount each person owes to other members.</p>
        ${sharedStackedDebtChart(group, youLabel)}
      </div>
      <div class="chart-card shared-chart-card">
        <h4>Shares by members</h4>
        <p class="shared-chart-description">Total share each member is responsible for paying.</p>
        ${sharedSharesBarChart(group, youLabel)}
      </div>
    </div>
  </div>

  <div class="shared-details-always-visible">
    ${renderSplitDetailsPanelReadOnly(group, youLabel)}
  </div>

  <div class="section">
    <div class="section-title"><h2>Shares</h2><span class="hint">Total share per member</span></div>
    <div class="table-wrap">
      <table class="shared-shares-table">
        <thead><tr><th>Person</th><th class="table-numeric">Total Paid</th><th class="table-numeric">Total Share</th></tr></thead>
        <tbody>${shareRows || `<tr class="empty-row"><td colspan="3">No shares recorded.</td></tr>`}</tbody>
      </table>
    </div>
  </div>

  <div class="section">
    <div class="section-title">
      <h2>Settle up</h2>
      <span class="hint">${outstandingCards.length ? `${outstandingCards.length} outstanding transfer${outstandingCards.length === 1 ? '' : 's'}` : 'All outstanding transfers settled'}</span>
    </div>
    ${scrollWrapper(settlementHtml)}
  </div>
  `;

  appendPageChrome(root, { isShared: true });
  setupScrollWrappers(root);
  setupTableScrollIndicators(root);
}

wireSplitCallouts(root);
renderSharedSplitPage();

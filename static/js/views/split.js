/* ---------- /split ---------- */
import { Store } from '../core/store.js';
import { $, $$, escapeHtml } from '../core/dom.js';
import { fmtINR, todayStr, currentMonthKey } from '../core/format.js';
import { currentUser, authReady } from '../core/auth.js';
import { ensureMonthIndexed, loadMonth, saveMonth } from '../core/domain.js';
import {
  SPLIT_YOU, getYouLabel, loadSplit, saveSplit, createSplitGroup, deleteSplitGroup,
  computeSplitPageData, computeGroupPaid, computeGroupSettlementView,
  toggleSplitSettlement, settleAllInGroup,
} from '../core/split-domain.js';
import { splitDonut } from '../components/charts/donut.js';
import { sharedStackedDebtChart, sharedSharesBarChart, SPLIT_PALETTE } from '../components/charts/split-charts.js';
import { scrollWrapper, setupScrollWrappers, setupTableScrollIndicators } from '../components/scroll-wrapper.js';
import { showDeleteCallout, hideDeleteCallout, wireDeletePopoverDismiss } from '../components/delete-popover.js';
import { showSplitCallout, hideSplitCallout, wireSplitCallouts } from '../components/split-callout.js';
import { mountLoginHero } from '../components/login-hero.js';
import { appendPageChrome } from '../components/page-chrome.js';
import { showToast } from '../components/toast.js';
import { markRendered } from '../components/render-guard.js';

const root = document.getElementById('split-root');
const youLabel = (possessive) => getYouLabel(false, null, possessive);

let splitsIndex = [];
let monthsIndex = [];
let splitFormOpen = false;
let splitSpendFormOpen = false;
let splitExpandedId = null;
let splitSlideDirection = '';
let animTimeout = null;
let domainLoaded = false;

// Fetched once; renderSplit() runs on nearly every interaction (settle
// toggles, expanding a card, adding a spend), so refetching these two
// index arrays every time would mean a network round trip per click.
// Every mutation to splitsIndex/monthsIndex already happens in place
// before persisting, so the cache never goes stale.
async function loadDomain() {
  if (domainLoaded) return;
  [splitsIndex, monthsIndex] = await Promise.all([
    Store.get('splits-index', []),
    Store.get('months-index', []),
  ]);
  domainLoaded = true;
}

function renderSplitAddForm() {
  return `
  <div class="form-panel">
    <div class="form-row">
      <div class="field"><label>Group description</label><input id="sf-desc" type="text" placeholder="e.g. Goa Trip" /></div>
    </div>
    <div id="sf-members">
      <div class="split-member-row">
        <div class="field"><label>Person 1</label><input class="sf-member" type="text" value="YOU" readonly style="background:var(--ice-2); color:var(--muted); cursor:not-allowed;" /></div>
        <button class="btn small ghost" data-remove-split-member type="button">Remove</button>
      </div>
      <div class="split-member-row">
        <div class="field"><label>Person 2</label><input class="sf-member" type="text" placeholder="Name" /></div>
        <button class="btn small ghost" data-remove-split-member type="button">Remove</button>
      </div>
    </div>
    <button class="btn small ghost" data-add-split-member type="button">+ Add person</button>
    <div class="form-actions">
      <button class="btn primary" data-submit-split type="button">Save split</button>
      <button class="btn ghost" data-close-split-form type="button">Cancel</button>
    </div>
  </div>`;
}

function renderSplitGroupCard(group) {
  const paid = computeGroupPaid(group);
  const dateLabel = group.createdAt ? new Date(group.createdAt + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
  const totalSpends = (group.spends || []).reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
  
  const headerRow = `
    <div class="sgc-person" style="font-size: 0.65rem; font-family: 'IBM Plex Mono', monospace; text-transform: uppercase; letter-spacing: 0.05em; color: var(--blue); margin-bottom: 2px;">
      <span>Members</span>
      <span>Total Paid</span>
    </div>`;

  const rows = group.people.map(p => `
    <div class="sgc-person"><span class="spn">${p === SPLIT_YOU ? youLabel() : escapeHtml(p.toUpperCase())}</span><span class="spv">${fmtINR(paid[p] || 0)}</span></div>`).join('');
    
  const footerRow = `
    <div class="sgc-person" style="margin-top: 4px; padding-top: 10px; border-top: 1px dashed var(--sky); color: var(--navy); font-weight: 600;">
      <span>Total Spends</span>
      <span class="num">${fmtINR(totalSpends)}</span>
    </div>`;
    
  const active = splitExpandedId === group.id ? 'active' : '';

  const { cards } = computeGroupSettlementView(group);
  const outstanding = cards.filter(c => !c.settled);
  const isFullySettled = cards.length > 0 && outstanding.length === 0;

  const actionsHtml = `
    <div class="sgc-actions">
      <label class="toggle-switch" title="${isFullySettled ? 'Un-settle all' : 'Settle all'}">
        <input type="checkbox" data-settle-group-toggle="${group.id}" ${isFullySettled ? 'checked' : ''} />
      </label>
      <button class="icon-btn" data-share-split="${group.id}" title="Share link" type="button">🔗</button>
      <button class="icon-btn" data-popover-trigger data-del-split="${group.id}" title="Delete group" type="button">✕</button>
    </div>`;

  return `
  <div class="split-group-card ${active}" data-split-card="${group.id}">
    <div class="sgc-header-row">
      <h4>${escapeHtml(group.description)}</h4>
      ${actionsHtml}
    </div>
    <div class="sgc-date">${dateLabel}</div>
    <div class="sgc-people">
      ${headerRow}
      ${rows}
      ${footerRow}
    </div>
  </div>`;
}

function renderSplitSettleCard(c) {
  const from = c.from === SPLIT_YOU ? youLabel() : escapeHtml(c.from.toUpperCase());
  const to = c.to === SPLIT_YOU ? youLabel() : escapeHtml(c.to.toUpperCase());
  return `
  <div class="split-settle-card ${c.settled ? 'settled' : ''}">
    <div class="ssc-group">${escapeHtml(c.groupDesc || '')}</div>
    <div class="ssc-line"><strong>${from}</strong> ${c.from === SPLIT_YOU ? 'pay' : 'pays'} <strong>${to}</strong></div>
    <div class="ssc-amount num">${fmtINR(c.amount)}</div>
    <label class="toggle-switch">
      <input type="checkbox" data-settle-toggle
        data-group-id="${c.groupId}" data-transfer-id="${c.id}"
        data-from="${escapeHtml(c.from)}" data-to="${escapeHtml(c.to)}"
        data-amount="${c.amount}" data-group-desc="${escapeHtml(c.groupDesc || '')}"
        ${c.settled ? 'checked' : ''} />
      ${c.settled ? 'Settled' : 'Mark settled'}
    </label>
  </div>`;
}

function renderSplitShareCallout(group, s) {
  const shares = group.people.map(p => ({
    label: p === SPLIT_YOU ? youLabel() : String(p).toUpperCase(),
    amount: Number((s.shares || {})[p]) || 0,
  }));
  const dataAttr = escapeHtml(JSON.stringify(shares));
  return `<span class="split-spend-cell" tabindex="0" data-spend-toggle data-spend-shares="${dataAttr}">${escapeHtml(s.description)}</span>`;
}

function renderSplitDetailsPanel(group) {
  const memberOptions = group.people.map(p => `<option value="${escapeHtml(p)}">${p === SPLIT_YOU ? youLabel() : escapeHtml(p.toUpperCase())}</option>`).join('');

  const shareInputs = group.people.map(p => {
    const personLabel = p === SPLIT_YOU ? youLabel(true) + ' share' : `${escapeHtml(p.toUpperCase())}'s share`;
    return `
    <div class="field split-person-share-box">
      <label>${personLabel} (₹)</label>
      <div style="display:flex; align-items:center; gap:8px;">
        <input class="sp-share" data-person="${escapeHtml(p)}" type="number" step="0.01" min="0" placeholder="0.00" style="flex:1;" />
        <label class="toggle-switch" title="Toggle inclusion in this spend" style="margin:0; flex-shrink:0;">
          <input type="checkbox" class="sp-member-toggle" data-person="${escapeHtml(p)}" checked />
        </label>
      </div>
    </div>`;
  }).join('');

  const sortedSpends = [...group.spends].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const dateCounts = {};
  for (const s of sortedSpends) dateCounts[s.date] = (dateCounts[s.date] || 0) + 1;
  const seenDates = new Set();
  const rowsHtml = sortedSpends.map(s => {
    const dateLabel = s.date ? new Date(s.date + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—';
    let dateCell = '';
    if (!seenDates.has(s.date)) { seenDates.add(s.date); dateCell = `<td class="dv-date" rowspan="${dateCounts[s.date]}">${dateLabel}</td>`; }
    return `
    <tr>${dateCell}
      <td>
        ${renderSplitShareCallout(group, s)}
        <span class="src-badge">${escapeHtml(s.payee)}</span>
      </td>
      <td class="num">${fmtINR(s.amount)}</td>
      <td class="actions-cell"><button class="icon-btn" data-del-split-spend="${group.id}|${s.id}" title="Remove spend">✕</button></td>
    </tr>`;
  }).join('');

  const formHtml = splitSpendFormOpen ? `
  <div class="form-panel slide-down-fade" style="margin-top:14px;">
    <div class="form-note" style="margin-top:0; margin-bottom:14px;">Add a transaction. The amount is split equally among active members by default.</div>
    <div class="form-row">
      <div class="field"><label>Spend</label><input id="sp-desc" type="text" placeholder="e.g. Dinner" /></div>
      <div class="field"><label>Paid by</label><select id="sp-payee">${memberOptions}</select></div>
      <div class="field"><label>Date</label><input id="sp-date" type="date" value="${todayStr()}" /></div>
      <div class="field"><label>Total amount (₹)</label><input id="sp-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
    </div>
    <div class="split-share-grid">${shareInputs}</div>
    <div class="form-actions">
      <button class="btn primary" data-submit-split-spend="${group.id}" type="button">Add spend</button>
      <button class="btn ghost" data-close-split-spend-form type="button">Cancel</button>
    </div>
  </div>` : '';
  const addBtnHtml = !splitSpendFormOpen ? `
  <div class="pill-grid" style="margin-top: 14px;">
    <button class="pill-btn" data-open-split-spend-form type="button">+ Add Spend</button>
  </div>` : '';

  const totalSpends = (group.spends || []).reduce((sum, s) => sum + (Number(s.amount) || 0), 0);

  return `
  <div class="split-details-panel" data-split-details="${group.id}" style="margin-top: 2px;">
    <div class="section-title">
      <h2>${escapeHtml(group.description)} - Ledger</h2>
      <span class="hint">Total Spends: ${fmtINR(totalSpends)} · ${group.people.length} people</span>
    </div>
    ${addBtnHtml}
    ${formHtml}
    <div class="form-note" style="margin-top:18px; margin-bottom:8px;">All group spends are listed here. Click a spend name to view share divisions.</div>
    <div class="table-wrap">
      <table class="divisions-table" ${rowsHtml ? '' : `style="width: 100%;"`}>
        <thead><tr><th>Date</th><th>Details</th><th ${rowsHtml ? `class="num"` : ''}>Amount</th><th></th></tr></thead>
        <tbody>${rowsHtml || `<tr class="empty-row"><td colspan="5">No spends logged in this group yet.</td></tr>`}</tbody>
      </table>
    </div>
  </div>`;
}

function distributeSplitShares(amount) {
  const shareInputs = $$('.sp-share');
  if (!shareInputs.length) return;
  const activeInputs = shareInputs.filter(inp => {
    const toggle = $(`.sp-member-toggle[data-person="${inp.dataset.person}"]`);
    return toggle ? toggle.checked : true;
  });
  const inactiveInputs = shareInputs.filter(inp => !activeInputs.includes(inp));
  inactiveInputs.forEach(inp => { inp.value = '0.00'; inp.disabled = true; inp.style.opacity = '0.45'; });

  const n = activeInputs.length;
  if (n === 0) return;
  activeInputs.forEach(inp => { inp.disabled = false; inp.style.opacity = '1'; });

  const baseCents = Math.floor((amount * 100) / n);
  let remainderCents = Math.round(amount * 100) - baseCents * n;
  activeInputs.forEach((inp) => {
    let cents = baseCents;
    if (remainderCents > 0) { cents += 1; remainderCents -= 1; }
    inp.value = (cents / 100).toFixed(2);
  });
}

async function renderSplit() {
  if (!currentUser) {
    markRendered(root);
    mountLoginHero(root);
    return;
  }
  await loadDomain();

  const { groups, owedByYou, owedToYou } = await computeSplitPageData(false, null, splitsIndex);
  const oweSegments = Object.entries(owedByYou).map(([person, amount], i) => ({ label: person, value: amount, color: SPLIT_PALETTE[i % SPLIT_PALETTE.length] }));
  const owedSegments = Object.entries(owedToYou).map(([person, amount], i) => ({ label: person, value: amount, color: SPLIT_PALETTE[i % SPLIT_PALETTE.length] }));

  const groupCardsHtml = groups.length
    ? groups.map(g => renderSplitGroupCard(g)).join('')
    : `<div class="empty-chart" style="flex:1 0 100%;">No split groups yet — add one above to get started.</div>`;

  const expandedGroup = splitExpandedId ? groups.find(g => g.id === splitExpandedId) : null;

  let settleCardsHtml = `<div class="empty-chart" style="flex:1 0 100%;">Tap a group card above to see settlement options.</div>`;
  let groupChartsHtml = `
  <div class="section">
    <div class="section-title"><h2>Group charts</h2><span class="hint">Outstanding balances and group shares</span></div>
    <div class="charts-grid shared-split-charts">
      <div class="empty-chart" style="grid-column: 1 / -1;">Tap a group card above to see its charts.</div>
    </div>
  </div>`;
  let sharesTableHtml = `
  <div class="section">
    <div class="section-title"><h2>Shares</h2><span class="hint">Total spent per person</span></div>
    <div class="table-wrap">
      <table style="width: 100%;">
        <thead><tr><th>Person</th><th>Total Paid</th><th>Total Share (Owed)</th></tr></thead>
        <tbody><tr class="empty-row"><td colspan="3">Tap a group card above to see shares.</td></tr></tbody>
      </table>
    </div>
  </div>`;

  if (expandedGroup) {
    const { cards } = computeGroupSettlementView(expandedGroup);
    settleCardsHtml = cards.length
      ? cards.sort((a, b) => (a.settled === b.settled) ? 0 : (a.settled ? 1 : -1))
          .map(c => renderSplitSettleCard({ ...c, groupId: expandedGroup.id, groupDesc: expandedGroup.description })).join('')
      : `<div class="empty-chart" style="flex:1 0 100%;">No settlement transfers for this group.</div>`;

    groupChartsHtml = `
    <div class="section">
      <div class="section-title"><h2>Group charts</h2><span class="hint">Outstanding balances and group shares</span></div>
      <div class="charts-grid shared-split-charts">
        <div class="chart-card shared-chart-card">
          <h4>Who owes how much</h4>
          <p class="shared-chart-description">Outstanding amount each person owes to other members.</p>
          ${sharedStackedDebtChart(expandedGroup, youLabel)}
        </div>
        <div class="chart-card shared-chart-card">
          <h4>Shares by members</h4>
          <p class="shared-chart-description">Total share each member is responsible for paying.</p>
          ${sharedSharesBarChart(expandedGroup, youLabel)}
        </div>
      </div>
    </div>`;

    const paid = computeGroupPaid(expandedGroup);
    const shareTotals = {};
    for (const person of expandedGroup.people) shareTotals[person] = 0;
    for (const spend of (expandedGroup.spends || [])) {
      for (const [person, amount] of Object.entries(spend.shares || {})) shareTotals[person] = (shareTotals[person] || 0) + (Number(amount) || 0);
    }
    const shareRows = expandedGroup.people.map(person => {
      const label = person === SPLIT_YOU ? youLabel() : escapeHtml(String(person).toUpperCase());
      return `<tr><td>${label}</td><td class="num">${fmtINR(paid[person] || 0)}</td><td class="num">${fmtINR(shareTotals[person] || 0)}</td></tr>`;
    }).join('');
    sharesTableHtml = `
    <div class="section">
      <div class="section-title"><h2>Shares</h2><span class="hint">Total spent per person</span></div>
      <div class="table-wrap">
        <table style="width: 100%;">
          <thead><tr><th>Person</th><th>Total Paid</th><th>Total Share (Owed)</th></tr></thead>
          <tbody>${shareRows}</tbody>
        </table>
      </div>
    </div>`;
  }

  const tb = document.getElementById('global-topbar');
  if (tb) tb.style.display = '';

  markRendered(root);
  root.innerHTML = `
  <div class="section">
    <div class="month-header"><h1>Split Money</h1></div>
  </div>

  <div class="section">
    <div class="section-title"><h2>Start a new split</h2><span class="hint">Track a group of people sharing expenses</span></div>
    <div class="pill-grid">
      <button class="pill-btn ${splitFormOpen ? 'active' : ''}" data-split-form-toggle type="button">+ New split group</button>
    </div>
    ${splitFormOpen ? renderSplitAddForm() : ''}
  </div>

  <div class="section">
    <div class="section-title"><h2>Overview</h2><span class="hint">Across every split group</span></div>
    <div class="charts-grid">
      <div class="chart-card">
        <h4>Who I owe how much</h4>
        ${splitDonut(oweSegments, "You don't owe anyone in any split right now.")}
      </div>
      <div class="chart-card">
        <h4>Who owes me how much</h4>
        ${splitDonut(owedSegments, "No one owes you in any split right now.")}
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title"><h2>Groups</h2><span class="hint">Newest first · tap a card for details</span></div>
    ${scrollWrapper(groupCardsHtml)}
    ${expandedGroup ? `
    <div id="split-details-anim-inner" class="${splitSlideDirection || ''}">
      ${renderSplitDetailsPanel(expandedGroup)}
    </div>` : ''}
  </div>

  ${groupChartsHtml}
  ${sharesTableHtml}

  <div class="section">
    <div class="section-title"><h2>Settle up</h2><span class="hint">Greedy debt-minimized transfers</span></div>
    ${scrollWrapper(settleCardsHtml)}
  </div>
  `;

  appendPageChrome(root);
  setupScrollWrappers(root);
  setupTableScrollIndicators(root);
}

root.addEventListener('click', async (ev) => {
  const splitFormToggle = ev.target.closest('[data-split-form-toggle]');
  if (splitFormToggle) { splitFormOpen = !splitFormOpen; await renderSplit(); return; }

  const closeSplitForm = ev.target.closest('[data-close-split-form]');
  if (closeSplitForm) { splitFormOpen = false; await renderSplit(); return; }

  const addSplitMember = ev.target.closest('[data-add-split-member]');
  if (addSplitMember) {
    const wrap = $('#sf-members');
    const idx = wrap.children.length + 1;
    const row = document.createElement('div');
    row.className = 'split-member-row';
    row.innerHTML = `<div class="field"><label>Person ${idx}</label><input class="sf-member" type="text" placeholder="Name" /></div><button class="btn small ghost" data-remove-split-member type="button">Remove</button>`;
    wrap.appendChild(row);
    return;
  }
  const removeSplitMember = ev.target.closest('[data-remove-split-member]');
  if (removeSplitMember) { removeSplitMember.closest('.split-member-row').remove(); return; }

  const submitSplit = ev.target.closest('[data-submit-split]');
  if (submitSplit) {
    const desc = ($('#sf-desc').value || '').trim();
    const members = $$('.sf-member').map(i => i.value.trim()).filter(Boolean);
    if (!desc) { showToast('Enter a group description'); return; }
    if (members.length < 2) { showToast('Add at least two people to split with'); return; }
    const seen = new Set();
    const people = [];
    for (const m of members) { const key = m.toLowerCase(); if (seen.has(key)) continue; seen.add(key); people.push(m); }
    await createSplitGroup(splitsIndex, desc, people);
    splitFormOpen = false;
    await renderSplit();
    showToast('Split group created');
    return;
  }

  const delSplitBtn = ev.target.closest('[data-del-split]');
  if (delSplitBtn) { ev.stopPropagation(); showDeleteCallout(delSplitBtn, 'confirm-del-split', delSplitBtn.dataset.delSplit); return; }
  const confirmDelSplit = ev.target.closest('[data-confirm-del-split]');
  if (confirmDelSplit) {
    ev.stopPropagation();
    await deleteSplitGroup(splitsIndex, confirmDelSplit.dataset.confirmDelSplit);
    hideDeleteCallout();
    await renderSplit();
    showToast('Split group deleted');
    return;
  }

  const shareBtn = ev.target.closest('[data-share-split]');
  if (shareBtn) {
    const id = shareBtn.dataset.shareSplit;
    shareBtn.disabled = true;
    try {
      const res = await fetch('/api/split/share', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'split:' + id }),
      });
      const body = await res.json();
      if (!res.ok) { showToast(body.error || 'Could not create a share link'); return; }
      await navigator.clipboard.writeText(body.url);
      showToast('Link copied! Anyone with this link can view the split.');
    } catch (e) {
      console.error('share link failed', e);
      showToast('Failed to copy link.');
    } finally {
      shareBtn.disabled = false;
    }
    return;
  }

  const splitCard = ev.target.closest('[data-split-card]');
  if (splitCard && !ev.target.closest('.sgc-actions')) {
    const id = splitCard.dataset.splitCard;
    if (animTimeout) clearTimeout(animTimeout);
    if (splitExpandedId === id) { splitExpandedId = null; splitSpendFormOpen = false; await renderSplit(); return; }
    if (splitExpandedId) {
      const cardsEls = $$('.split-group-card');
      let oldIdx = -1, newIdx = -1;
      cardsEls.forEach((c, i) => { if (c.dataset.splitCard === splitExpandedId) oldIdx = i; if (c.dataset.splitCard === id) newIdx = i; });
      const isRight = newIdx > oldIdx;
      const inner = $('#split-details-anim-inner');
      if (inner && oldIdx !== -1 && newIdx !== -1) {
        inner.className = isRight ? 'slide-out-left' : 'slide-out-right';
        animTimeout = setTimeout(async () => {
          splitExpandedId = id; splitSpendFormOpen = false;
          splitSlideDirection = isRight ? 'slide-in-right' : 'slide-in-left';
          await renderSplit();
        }, 300);
      } else { splitExpandedId = id; splitSpendFormOpen = false; splitSlideDirection = ''; await renderSplit(); }
      return;
    }
    splitExpandedId = id; splitSpendFormOpen = false; splitSlideDirection = '';
    await renderSplit();
    return;
  }

  const openSplitSpendForm = ev.target.closest('[data-open-split-spend-form]');
  if (openSplitSpendForm) { splitSpendFormOpen = true; await renderSplit(); return; }
  const closeSplitSpendForm = ev.target.closest('[data-close-split-spend-form]');
  if (closeSplitSpendForm) { splitSpendFormOpen = false; await renderSplit(); return; }

  const submitSplitSpend = ev.target.closest('[data-submit-split-spend]');
  if (submitSplitSpend) {
    const groupId = submitSplitSpend.dataset.submitSplitSpend;
    const desc = ($('#sp-desc').value || '').trim();
    const payee = $('#sp-payee').value;
    const date = $('#sp-date').value || todayStr();
    const amount = Number($('#sp-amount').value);
    if (!desc || !amount || amount <= 0) { showToast('Enter a spend description and amount'); return; }
    const shares = {};
    let shareSum = 0;
    $$('.sp-share').forEach(inp => { const v = Number(inp.value) || 0; shares[inp.dataset.person] = v; shareSum += v; });
    if (Math.abs(shareSum - amount) > 0.01) { showToast('Shares must add up to the total amount'); return; }

    const group = await loadSplit(groupId, false);
    const { uid } = await import('../core/dom.js');
    const spendId = uid();
    let ledgerEntryId = null, ledgerMonthKey = null;

    if (payee === SPLIT_YOU) {
      ledgerMonthKey = currentMonthKey();
      await ensureMonthIndexed(ledgerMonthKey, monthsIndex);
      const monthData = await loadMonth(ledgerMonthKey);
      const entryId = uid();
      monthData.entries.push({
        id: entryId, type: 'spend', description: `${desc} (${group.description})`, amount,
        date, paymentMode: 'cash', cardId: null, tag: 'split', lent: [],
      });
      await saveMonth(ledgerMonthKey);
      ledgerEntryId = entryId;
    }

    group.spends.push({ id: spendId, description: desc, payee, amount, date, shares, ledgerEntryId, monthKey: ledgerMonthKey });
    await saveSplit(groupId);
    splitSpendFormOpen = false;
    await renderSplit();
    showToast('Spend added to split');
    return;
  }

  const delSplitSpend = ev.target.closest('[data-del-split-spend]');
  if (delSplitSpend) {
    const [groupId, spendId] = delSplitSpend.dataset.delSplitSpend.split('|');
    const group = await loadSplit(groupId, false);
    if (group) {
      const spend = group.spends.find(s => s.id === spendId);
      if (spend) {
        if (spend.payee === SPLIT_YOU && spend.ledgerEntryId && spend.monthKey) {
          const monthData = await loadMonth(spend.monthKey);
          monthData.entries = monthData.entries.filter(e => e.id !== spend.ledgerEntryId);
          await saveMonth(spend.monthKey);
        }
        group.spends = group.spends.filter(s => s.id !== spendId);
        await saveSplit(groupId);
        await renderSplit();
        showToast('Spend removed');
      }
    }
  }
});

root.addEventListener('change', async (ev) => {
  if (ev.target.matches('.sp-member-toggle')) {
    const totalAmt = Number($('#sp-amount')?.value) || 0;
    distributeSplitShares(totalAmt);
    return;
  }
  if (ev.target.matches('[data-settle-toggle]')) {
    const el = ev.target;
    const willSettle = el.checked;
    await toggleSplitSettlement(el.dataset.groupId, el.dataset.transferId, el.dataset.from, el.dataset.to, Number(el.dataset.amount), el.dataset.groupDesc, willSettle, monthsIndex);
    await renderSplit();
    showToast(willSettle ? "Marked as settled — synced to this month's ledger" : 'Settlement undone — removed from ledger');
    return;
  }
  if (ev.target.matches('[data-settle-group-toggle]')) {
    const groupId = ev.target.dataset.settleGroupToggle;
    const willSettle = ev.target.checked;
    const group = await loadSplit(groupId, false);
    if (group) {
      if (willSettle) {
        await settleAllInGroup(group, monthsIndex);
        showToast('Group settled');
      } else {
        const { cards } = computeGroupSettlementView(group);
        const settled = cards.filter(c => c.settled);
        for (const c of settled) await toggleSplitSettlement(group.id, c.id, c.from, c.to, c.amount, group.description, false, monthsIndex);
        showToast('Group un-settled');
      }
      await renderSplit();
    }
  }
});

root.addEventListener('input', (ev) => {
  if (ev.target.id === 'sp-amount') distributeSplitShares(Number(ev.target.value) || 0);
});

wireDeletePopoverDismiss(root);
wireSplitCallouts(root);
window.addEventListener('auth:signed-in', renderSplit);
window.addEventListener('auth:checked', renderSplit);
// Wait for the first /api/auth/me round trip so we never flash the
// signed-out login hero for an already-authenticated visitor.
authReady.then(renderSplit);

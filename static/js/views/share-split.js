/* ---------- /share/split/<id> ----------
   Fully public: no auth bar chrome, no /api/storage calls. Reads via the
   dedicated /api/public/split/<id> endpoint (see app.py) and never writes,
   so the settle-up toggles below are deliberately read-only — the original
   monolith let a visitor click them, but the write would 401 silently
   since a public page never has a session; rendering them as plain state
   here is the same effective behavior with honest, non-interactive markup. */
import { escapeHtml, uid } from '../core/dom.js';
import { fmtINR } from '../core/format.js';
import { loadSharedSplit, getYouLabel, computeGroupPaid, computeGroupSettlementView, SPLIT_YOU } from '../core/split-domain.js';
import { sharedStackedDebtChart, sharedSharesBarChart } from '../components/charts/split-charts.js';
import { scrollWrapper, setupScrollWrappers, setupTableScrollIndicators } from '../components/scroll-wrapper.js';
import { appendPageChrome } from '../components/page-chrome.js';
import { wireSplitCallouts } from '../components/split-callout.js';
import { markRendered } from '../components/render-guard.js';
import { currentUser, authReady, initGoogleSignIn } from '../core/auth.js';
import { Store } from '../core/store.js';
import { showToast } from '../components/toast.js';

function initPublicThemeSelector() {
  const syncActiveStates = () => {
    const theme = localStorage.getItem('ledger-theme') || 'default';
    document.querySelectorAll('[data-theme-btn]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.themeBtn === theme);
    });
  };

  document.addEventListener('click', (ev) => {
    const themeBtn = ev.target.closest('[data-theme-btn]');
    if (themeBtn) {
      const theme = themeBtn.dataset.themeBtn;
      localStorage.setItem('ledger-theme', theme);
      document.documentElement.setAttribute('data-theme', theme);
      syncActiveStates();
      
      const profileMenu = document.getElementById('profile-menu');
      const burgerBtn = document.getElementById('burger-menu-btn');
      if (profileMenu) profileMenu.classList.remove('show');
      if (burgerBtn) burgerBtn.setAttribute('aria-expanded', 'false');
      return;
    }

    const burgerBtn = ev.target.closest('#burger-menu-btn');
    const profileMenu = document.getElementById('profile-menu');
    
    if (burgerBtn && profileMenu) {
      const willOpen = !profileMenu.classList.contains('show');
      profileMenu.classList.toggle('show', willOpen);
      burgerBtn.setAttribute('aria-expanded', String(willOpen));
      return;
    }

    if (profileMenu && profileMenu.classList.contains('show') && !ev.target.closest('.auth-controls')) {
      profileMenu.classList.remove('show');
      const bBtn = document.getElementById('burger-menu-btn');
      if (bBtn) bBtn.setAttribute('aria-expanded', 'false');
    }
  });

  syncActiveStates();
}

// Initialize immediately so click controls work regardless of async rendering
initPublicThemeSelector();

// base.html's normal auth bootstrap script is skipped on shared pages, so
// this page has to trigger Google Sign-In itself. checkAuth() already runs
// automatically as a side effect of importing auth.js (see authReady).
initGoogleSignIn();

// Reveal the topbar controls after 1s to mimic the auth-check delay
setTimeout(() => {
  const authBar = document.getElementById('auth-bar');
  if (authBar) {
    authBar.style.opacity = '1';
    authBar.style.visibility = 'visible';
  }
}, 1000);

const root = document.getElementById('share-split-root');
const shareId = root.dataset.shareId;

// Populated once loadSharedSplit() resolves inside renderSharedSplitPage();
// the click handler below needs them outside that closure to build the clone.
let sharedGroupData = null;
let sharedOwnerData = null;
let sharedYouLabel = null;
let importDuplicateState = null; // { clonedGroup, splitsIndex, existingId, existingDescription } while awaiting a replace/new-copy decision

function renderSplitGroupCardReadOnly(group, youLabel) {
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
      <span>Total</span>
      <span class="num">${fmtINR(totalSpends)}</span>
    </div>`;

  return `
  <div class="split-group-card active" data-split-card="${group.id}">
    <h4>${escapeHtml(group.description)}</h4>
    <div class="sgc-date">${dateLabel}</div>
    <div class="sgc-people">
      ${headerRow}
      ${rows}
      ${footerRow}
    </div>
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

function renderImportDuplicatePanel() {
  const desc = escapeHtml(importDuplicateState.existingDescription);
  return `
  <div class="form-panel slide-down-fade" style="margin-top:14px;">
    <div class="form-note" style="margin-top:0; border-color: var(--blue);">
      You already have a split group named "${desc}" in your account. What would you like to do?
    </div>
    <div class="form-actions">
      <button class="btn primary" data-replace-import type="button">Replace existing group</button>
      <button class="btn" data-new-copy-import type="button">Import as a separate copy</button>
      <button class="btn ghost" data-cancel-import type="button">Cancel</button>
    </div>
  </div>`;
}

// Labels each option exactly the way every other list on this page already
// labels people (see renderSplitGroupCardReadOnly, renderSplitDetailsPanelReadOnly,
// etc.) — "YOU" renders through the same youLabel() closure everyone else
// uses, with no special-cased owner logic living in the import feature.
function renderImportMemberOptions(group, youLabel) {
  return group.people.map(p => {
    const label = p === SPLIT_YOU ? youLabel() : escapeHtml(p.toUpperCase());
    return `<option value="${escapeHtml(p)}">${label}</option>`;
  }).join('');
}

function renderImportSection(group, youLabel) {
  if (importDuplicateState) {
    return `
    <div class="section shared-import-section" data-import-section>
      <div class="section-title"><h2>Import this group</h2><span class="hint">Copy it into your own Split Money dashboard</span></div>
      ${renderImportDuplicatePanel()}
    </div>`;
  }

  return `
  <div class="section shared-import-section" data-import-section>
    <div class="section-title"><h2>Import this group</h2><span class="hint">Copy it into your own Split Money dashboard</span></div>
    <div class="form-row" style="align-items: end;">
      <div class="field">
        <label>Who are you in this group?</label>
        <select id="import-who-am-i">
          ${renderImportMemberOptions(group, youLabel)}
        </select>
      </div>
      <div class="form-actions" style="margin-top:0; margin-bottom:2px;">
        <button class="btn primary" data-confirm-import type="button">Import this group</button>
      </div>
    </div>
  </div>`;
}

// Deep-clones the public group and re-maps identities so it makes sense
// inside the importer's own isolated user_storage:
//   - whatever the JSON calls "YOU" (the original owner) becomes their name
//   - whatever the importer says they are becomes "YOU"
// ledgerEntryId/monthKey are stripped since those point at the original
// owner's month ledger and would silently corrupt the importer's own months.
function cloneGroupForImport(group, owner, importerName) {
  const originalOwnerName = (owner && owner.name) || 'The owner';
  const clone = JSON.parse(JSON.stringify(group));

  const swapIdentity = (value) => {
    if (importerName === SPLIT_YOU) return value;
    if (value === SPLIT_YOU) return originalOwnerName;
    if (value === importerName) return SPLIT_YOU;
    return value;
  };

  clone.id = 'split_' + uid();
  clone.people = clone.people.map(swapIdentity);
  clone.people.sort((a, b) => a === SPLIT_YOU ? -1 : (b === SPLIT_YOU ? 1 : 0));

  clone.spends = (clone.spends || []).map(s => {
    const { ledgerEntryId, monthKey, ...rest } = s;
    const shares = {};
    for (const [person, amount] of Object.entries(rest.shares || {})) {
      shares[swapIdentity(person)] = amount;
    }
    return { ...rest, payee: swapIdentity(rest.payee), shares };
  });

  clone.settlements = (clone.settlements || []).map(t => {
    const { ledgerEntryId, monthKey, ...rest } = t;
    return { ...rest, from: swapIdentity(rest.from), to: swapIdentity(rest.to) };
  });

  return clone;
}

// Walks the importer's own groups looking for a description collision.
// Not indexed anywhere, so this is O(n) Store.get calls — acceptable since
// it only runs once, right before a user-initiated import.
// State transitions inside the import flow (opening the duplicate-resolution
// panel, cancelling it, reacting to a fresh sign-in) never need new group
// data — sharedGroupData/sharedOwnerData/sharedYouLabel are already cached
// from the one real page load. Re-running renderSharedSplitPage() for these
// would re-fetch /api/public/split/<id> for no reason, and any hiccup on
// that call (latency, rate limiting) would wipe the whole page — which is
// exactly the "disappears" bug. This only ever touches the DOM.
function refreshImportSection() {
  const slot = document.getElementById('import-section-slot');
  if (!slot || !sharedGroupData) return;
  slot.innerHTML = currentUser ? renderImportSection(sharedGroupData, sharedYouLabel) : '';
}

async function findDuplicateGroupId(splitsIndex, description) {
  const target = (description || '').trim().toLowerCase();
  for (const id of splitsIndex) {
    sessionStorage.removeItem('split:' + id);
    const existing = await Store.get('split:' + id, null);
    if (existing && (existing.description || '').trim().toLowerCase() === target) return id;
  }
  return null;
}

async function finalizeImport(clonedGroup, splitsIndex, existingId) {
  if (existingId) {
    // Replace: reuse the existing slot instead of appending to
    // splits-index, so the duplicate doesn't end up living twice.
    clonedGroup.id = existingId;
    await Store.set('split:' + existingId, clonedGroup);
  } else {
    splitsIndex.push(clonedGroup.id);
    await Store.set('splits-index', splitsIndex);
    await Store.set('split:' + clonedGroup.id, clonedGroup);
  }
  importDuplicateState = null;
  await renderSharedSplitPage();
  showToast('Split group added');
}

// Store.get() serves 'splits-index' from sessionStorage when present (see
// core/store.js). That's fine for normal in-app navigation, but here it's
// actively dangerous: if this tab's cached index predates a group created
// elsewhere (another tab, another device, or just before this page loaded),
// the duplicate check below would run against stale data — and the
// subsequent "push + save the whole array back" would silently clobber the
// server's real index with that stale-plus-one array. Force a live read.
async function getFreshSplitsIndex() {
  sessionStorage.removeItem('splits-index');
  return Store.get('splits-index', []);
}

async function handleImportConfirm() {
  const select = document.getElementById('import-who-am-i');
  const importerName = select ? select.value : null;
  if (!importerName || !sharedGroupData) return;

  // No block on importing as the original owner — the shared page is
  // universal, so someone using a second account (or the owner themselves)
  // can legitimately claim that identity.
  const clonedGroup = cloneGroupForImport(sharedGroupData, sharedOwnerData, importerName);
  const splitsIndex = await getFreshSplitsIndex();

  const existingId = await findDuplicateGroupId(splitsIndex, clonedGroup.description);
  if (existingId) {
    importDuplicateState = { clonedGroup, splitsIndex, existingId, existingDescription: clonedGroup.description };
    refreshImportSection();
    return;
  }

  await finalizeImport(clonedGroup, splitsIndex, null);
}

async function renderSharedSplitPage() {
  document.body.dataset.isShared = 'true';
  document.body.classList.add('shared-mode');

  const [{ group, owner, error }] = await Promise.all([loadSharedSplit(shareId), authReady]);
  const youLabel = (possessive) => getYouLabel(true, owner, possessive);

  if (!group) {
    markRendered(root);
    root.innerHTML = `<div class="section"><div class="empty-chart">${error || 'This shared Split Money group could not be found.'}</div></div>`;
    return;
  }

  sharedGroupData = group;
  sharedOwnerData = owner;
  sharedYouLabel = youLabel;

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

  const totalSpends = (group.spends || []).reduce((sum, s) => sum + (Number(s.amount) || 0), 0);

  const brandEl = document.querySelector('.brand');
  if (brandEl) {
    if (currentUser) {
      brandEl.href = '/home';
      brandEl.style.cursor = 'pointer';
      brandEl.setAttribute('title', 'Back to home');
    } else {
      brandEl.removeAttribute('href');
      brandEl.style.cursor = 'default';
      brandEl.removeAttribute('title');
    }
  }

  markRendered(root);
  root.innerHTML = `
  <div class="section shared-page-header">
    <div class="month-header">
      <h1>${escapeHtml(group.description)}</h1>
      <h4 style="margin: 8px 0px 2px 0px;">Total Spends: ${fmtINR(totalSpends)}</h4>
    </div>
     <p class="shared-page-subtitle">Shared group · ${group.people.length} people</p>
  </div>

  <div id="import-section-slot">${currentUser ? renderImportSection(group, youLabel) : ''}</div>

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

root.addEventListener('click', async (ev) => {
  const confirmBtn = ev.target.closest('[data-confirm-import]');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    try {
      await handleImportConfirm();
    } finally {
      confirmBtn.disabled = false;
    }
    return;
  }

  const replaceBtn = ev.target.closest('[data-replace-import]');
  if (replaceBtn) {
    replaceBtn.disabled = true;
    const { clonedGroup, splitsIndex, existingId } = importDuplicateState;
    await finalizeImport(clonedGroup, splitsIndex, existingId);
    return;
  }

  const newCopyBtn = ev.target.closest('[data-new-copy-import]');
  if (newCopyBtn) {
    newCopyBtn.disabled = true;
    const { clonedGroup, splitsIndex } = importDuplicateState;
    await finalizeImport(clonedGroup, splitsIndex, null);
    return;
  }

  const cancelImportBtn = ev.target.closest('[data-cancel-import]');
  if (cancelImportBtn) {
    importDuplicateState = null;
    refreshImportSection();
  }
});

wireSplitCallouts(root);
window.addEventListener('auth:signed-in', renderSharedSplitPage);
window.addEventListener('auth:checked', renderSharedSplitPage);
renderSharedSplitPage();
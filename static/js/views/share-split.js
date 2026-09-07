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
import { wireChartTooltips } from '../components/charts/line-chart.js';
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

      const themeColors = { 'default': '#FCFDFF', 'dark': '#0F111E', 'hi-contrast': '#FFFFFF' };
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = themeColors[theme] || '#FCFDFF';

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

let activePayeeFilters = [];
let currentSort = { key: 'date', asc: false };

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
  return `<strong class="split-spend-cell" tabindex="0" data-spend-toggle data-spend-shares="${dataAttr}">${escapeHtml(s.description)}</strong>`;
}

function renderSplitDetailsPanelReadOnly(group, youLabel) {
  // 1. Extract Payees
  const payees = [...new Set((group.spends || []).map(s => s.payee))].filter(Boolean).sort();
  
  // 2. Filter & Sort
  let filteredSpends = (group.spends || []).filter(s => {
    if (activePayeeFilters.length > 0 && !activePayeeFilters.includes(s.payee)) return false;
    return true;
  });

  filteredSpends.sort((a, b) => {
    if (currentSort.key === 'date') {
      const aDate = Number.isFinite(Date.parse(a.date || '')) ? Date.parse(a.date || '') : -Infinity;
      const bDate = Number.isFinite(Date.parse(b.date || '')) ? Date.parse(b.date || '') : -Infinity;
      const cmp = aDate - bDate;
      return currentSort.asc ? cmp : -cmp;
    } else if (currentSort.key === 'amount') {
      const cmp = (Number(a.amount) || 0) - (Number(b.amount) || 0);
      return currentSort.asc ? cmp : -cmp;
    }
    return 0;
  });

  const dateStreakCounts = new Map();
  const firstDateRows = new Set();

  for (let i = 0; i < filteredSpends.length;) {
    let j = i + 1;
    while (j < filteredSpends.length && filteredSpends[j].date === filteredSpends[i].date) {
      j++;
    }
    dateStreakCounts.set(i, j - i);
    firstDateRows.add(i);
    i = j;
  }

  const rowsHtml = filteredSpends.map((s, index) => {
    let dateContent = '—';
    if (s.date) {
      const dt = new Date(s.date + 'T00:00:00');
      const day = dt.toLocaleDateString('en-IN', { day: '2-digit' });
      const month = dt.toLocaleDateString('en-IN', { month: 'short' });
      const weekday = dt.toLocaleDateString('en-IN', { weekday: 'short' });
      dateContent = `
        <div class="dv-date-badge" style="display: inline-flex; flex-wrap: wrap; flex-direction: column;">
          <div class="dv-date-top" style="white-space: nowrap;">
            <strong class="dv-date-day" style="display: inline-block; font-size: 1.2rem; font-weight: 600;">${day}</strong>
            <span class="dv-date-month">${month}</span>
          </div>
          <div class="dv-date-weekday" style="color: var(--muted);">${weekday}</div>
        </div>
      `;
    }
    let dateCell = '';
    if (firstDateRows.has(index)) {
      dateCell = `<td class="dv-date" rowspan="${dateStreakCounts.get(index)}">${dateContent}</td>`;
    }
    const payeeLabel = s.payee === SPLIT_YOU ? youLabel() : escapeHtml(String(s.payee).toUpperCase());
    return `<tr>${dateCell}<td class="desc-cell">${renderSplitShareCallout(group, s, youLabel)}<span class="src-badge">${payeeLabel}</span></td><td class="num">${fmtINR(s.amount)}</td></tr>`;
  }).join('');

  const filteredTotal = filteredSpends.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);

  // 3. UI Controls
  const tablePayeeOptions = payees.map(p => `<option value="${escapeHtml(p)}" ${activePayeeFilters.includes(p) ? 'disabled' : ''}>${escapeHtml(p)}</option>`).join('');
  const activeTableFilterPills = activePayeeFilters.map(p => `
    <div class="pill-btn sub-pill active chart-tag-pill">
      ${escapeHtml(p)}
      <button class="icon-btn chart-tag-remove" data-remove-table-filter="payee|${escapeHtml(p)}" aria-label="Remove filter">✕</button>
    </div>`).join('');

  const sortDirectionLabel = currentSort.key === 'date' 
    ? (currentSort.asc ? 'Oldest first' : 'Newest first')
    : (currentSort.asc ? 'Low to High' : 'High to Low');

  const tableControlsHtml = `
    <div class="sticky-controls-wrap">
      <div class="table-controls" style="display: flex; flex-wrap: wrap; align-items: center; gap: 10px;">
        <select id="table-payee-filter" aria-label="Filter by payee">
          <option value="">All Payees</option>
          ${tablePayeeOptions}
        </select>
        <select id="table-sort-control" aria-label="Sort transactions">
          <option value="date" ${currentSort.key === 'date' ? 'selected' : ''}>Date</option>
          <option value="amount" ${currentSort.key === 'amount' ? 'selected' : ''}>Amount</option>
        </select>
        <button id="table-sort-direction" class="btn small" type="button" aria-label="Toggle sort direction" style="min-height: 0px;">
          ${currentSort.asc ? '↑' : '↓'} ${sortDirectionLabel}
        </button>
      </div>
      ${activeTableFilterPills ? `<div style="display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; margin-bottom: 12px; padding: 0 14px;">${activeTableFilterPills}</div>` : ''}

      <div class="table-header-wrap">
        <table class="table-header-sticky" style="min-width: 500px;">
          <colgroup>
            <col style="width: 95px;">
            <col style="width: auto;">
            <col style="width: 120px;">
            <col style="width: 10px;">
          </colgroup>
          <thead><tr><th>Date</th><th>Details</th><th class="table-numeric">Amount</th><th></th></tr></thead>
        </table>
      </div>
    </div>`;

  return `
  <div class="split-details-panel" data-split-details="${group.id}" style="margin-top: 2px;">
    <div class="section-title" style="margin-bottom: 12px;">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="color: var(--blue); display: flex;">
          <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
        </span>
        <h2 style="margin: 0;">${escapeHtml(group.description)} - Ledger</h2>
      </div>
      <span class="hint">${group.people.length} people</span>
    </div>
    <div class="form-note" style="margin-top:8px; margin-bottom:8px; border: none;">All group spends are listed here. Click a spend name to view share divisions.</div>
    
    <div class="transactions-container">
      ${tableControlsHtml}
      <div class="table-wrap">
        <table class="divisions-table table-body-sticky" ${filteredSpends.length ? 'style="min-width: 500px;"' : `style="width: 100%;"`}>
          <colgroup>
            <col style="width: 95px;">
            <col style="width: auto;">
            <col style="width: 120px;">
          </colgroup>
          <tbody>
            ${rowsHtml || (group.spends.length ? `<tr class="empty-row"><td colspan="3">No spends match the selected filter.</td></tr>` : `<tr class="empty-row"><td colspan="3">No spends logged in this group yet.</td></tr>`)}
            ${filteredSpends.length ? `
              <tr class="table-total-row">
                <td colspan="2">
                  <div style="font-family: 'Source Serif 4', Georgia, serif; font-size:1rem; font-weight: 600; display: flex; align-items: center; gap: 6px;">
                    Total <span style="font-size:0.78rem; color: var(--muted);"> [Filtered Spends]</span>
                  </div>
                </td>
                <td class="num table-total-amount">
                  ${fmtINR(Math.abs(filteredTotal))}
                </td>
              </tr>
            ` : ''}
          </tbody>
        </table>
      </div>
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
      <div class="section-title" style="margin-bottom: 12px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="color: var(--blue); display: flex;">
            <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          </span>
          <h2 style="margin: 0;">Import this group</h2>
        </div>
        <span class="hint">Copy it into your own Split Money dashboard</span>
      </div>
      ${renderImportDuplicatePanel()}
    </div>`;
  }

  return `
  <div class="section shared-import-section" data-import-section>
    <div class="section-title" style="margin-bottom: 12px;">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="color: var(--blue); display: flex;">
          <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        </span>
        <h2 style="margin: 0;">Import this group</h2>
      </div>
      <span class="hint">Copy it into your own Split Money dashboard</span>
    </div>
    <div class="form-row" style="margin-bottom: 8px;">
      <div class="field">
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
    <div class="section-title" style="margin-bottom: 12px;">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="color: var(--blue); display: flex;">
          <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
        </span>
        <h2 style="margin: 0;">Group</h2>
      </div>
      <span class="hint">Shared view</span>
    </div>
    ${groupCardHtml}
  </div>

  <div class="section">
    <div class="section-title" style="margin-bottom: 12px;">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="color: var(--blue); display: flex;">
          <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="14" width="4" height="8"></rect><rect x="10" y="8" width="4" height="14"></rect><rect x="17" y="2" width="4" height="20"></rect></svg>
        </span>
        <h2 style="margin: 0;">Split charts</h2>
      </div>
      <span class="hint">Outstanding balances and group shares</span>
    </div>
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
    <div class="section-title" style="margin-bottom: 12px;">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="color: var(--blue); display: flex;">
          <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="12" width="2.5" height="10"></rect><rect x="7.5" y="6" width="2.5" height="16"></rect><rect x="13" y="15" width="2.5" height="7"></rect><rect x="18.5" y="4" width="2.5" height="18"></rect></svg>
        </span>
        <h2 style="margin: 0;">Shares</h2>
      </div>
      <span class="hint">Total share per member</span>
    </div>
    <div class="table-wrap">
      <table class="shared-shares-table">
        <thead><tr><th>Person</th><th class="table-numeric">Total Paid</th><th class="table-numeric">Total Share</th></tr></thead>
        <tbody>${shareRows || `<tr class="empty-row"><td colspan="3">No shares recorded.</td></tr>`}</tbody>
      </table>
    </div>
  </div>

  <div class="section">
    <div class="section-title" style="margin-bottom: 12px;">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="color: var(--blue); display: flex;">
          <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
        </span>
        <h2 style="margin: 0;">Settlements</h2>
      </div>
      <span class="hint">${outstandingCards.length ? `${outstandingCards.length} outstanding transfer${outstandingCards.length === 1 ? '' : 's'}` : 'All outstanding transfers settled'}</span>
    </div>
    ${scrollWrapper(settlementHtml)}
  </div>
  `;

  appendPageChrome(root, { isShared: true });
  setupScrollWrappers(root);
  setupTableScrollIndicators(root);

  // Sync horizontal scrolling and EXACT table widths between the body and sticky header
  const tableWrapEl = root.querySelector('.transactions-container .table-wrap');
  const headerWrapEl = root.querySelector('.transactions-container .table-header-wrap');
  
  if (tableWrapEl && headerWrapEl) {
    const bodyTable = tableWrapEl.querySelector('table');
    const headerTable = headerWrapEl.querySelector('table');

    if (bodyTable && headerTable) {
      const syncTableWidth = () => {
        if (headerTable && bodyTable) {
          headerTable.style.width = bodyTable.offsetWidth + 'px';
        }
      };
      
      setTimeout(syncTableWidth, 10);
      
      let resizeTimer;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(syncTableWidth, 150);
      });
    }

    tableWrapEl.addEventListener('scroll', () => {
      headerWrapEl.scrollLeft = tableWrapEl.scrollLeft;
    }, { passive: true });
  }
}

root.addEventListener('click', async (ev) => {
  const removeTableFilter = ev.target.closest('[data-remove-table-filter]');
  if (removeTableFilter) {
    const filterVal = removeTableFilter.dataset.removeTableFilter.split('|')[1];
    activePayeeFilters = activePayeeFilters.filter(p => p !== filterVal);
    await renderSharedSplitPage();
    return;
  }

  const sortDirectionBtn = ev.target.closest('#table-sort-direction');
  if (sortDirectionBtn) {
    currentSort.asc = !currentSort.asc;
    await renderSharedSplitPage();
    return;
  }

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

root.addEventListener('change', async (ev) => {
  if (ev.target.id === 'table-payee-filter') {
    const value = ev.target.value;
    if (value && !activePayeeFilters.includes(value)) {
      activePayeeFilters.push(value);
    }
    ev.target.value = '';
    await renderSharedSplitPage();
    return;
  }

  if (ev.target.id === 'table-sort-control') {
    const key = ev.target.value;
    if (!key) return;
    if (key === currentSort.key) {
      currentSort.asc = !currentSort.asc;
    } else {
      currentSort.key = key;
    }
    await renderSharedSplitPage();
    return;
  }
});

wireSplitCallouts(root);
wireChartTooltips(root);
window.addEventListener('auth:signed-in', renderSharedSplitPage);
window.addEventListener('auth:checked', renderSharedSplitPage);
initGoogleSignIn();
renderSharedSplitPage();
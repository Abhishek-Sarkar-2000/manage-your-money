/* ---------- /home ----------
   Only fetches cards/EMI/SIP/months-index/existing-investments — never
   touches split groups or price-tracker items. Domain data is fetched once
   per page load and cached in `cache`; a range-toggle click only re-slices
   the already-computed daily balance series and re-renders from memory —
   it never re-hits the network. */
import { Store } from '../core/store.js';
import { fmtINR, currentMonthKey, monthKeyLabel } from '../core/format.js';
import { currentUser, authReady } from '../core/auth.js';
import { computeGlobalStats, computeMonthTotals, emiRowsForMonth, sipRowsForMonth, loadMonth, computeDailyBalanceSeries, windowSeries } from '../core/domain.js';
import { computeGlobalSplitOwedByYou } from '../core/split-domain.js';
import { renderStatCards, wireStatCardFlip } from '../components/stat-cards.js';
import { dailyBalanceChart } from '../components/charts/line-chart.js';
import { setupScrollWrappers, setupTableScrollIndicators } from '../components/scroll-wrapper.js';
import { mountLoginHero } from '../components/login-hero.js';
import { appendPageChrome } from '../components/page-chrome.js';
import { markRendered } from '../components/render-guard.js';

const root = document.getElementById('home-root');
let balanceChartRange = 1;
let cache = null; // { cards, emiSeries, sipSeries, monthsIndex, splitsIndex, existingInvestments, stats, splitOwed, dailySeries, currentMonthCardHtml }

async function loadDomain() {
  const [cards, emiSeries, sipSeries, monthsIndex, splitsIndex, existingInvestments] = await Promise.all([
    Store.get('creditcards', []),
    Store.get('emiseries', []),
    Store.get('sipseries', []),
    Store.get('months-index', []),
    Store.get('splits-index', []),
    Store.get('existinginvestments', 0),
  ]);

  // PRE-WARM CACHE: Perform a single bulk fetch to grab all historical months and splits.
  // This completely eliminates the N+1 API queries when domain functions later call Store.get().
  const keysToBulkFetch = [];
  if (monthsIndex && monthsIndex.length > 0) {
    keysToBulkFetch.push(...monthsIndex.map(k => 'month:' + k));
  }
  if (splitsIndex && splitsIndex.length > 0) {
    keysToBulkFetch.push(...splitsIndex.map(id => 'split:' + id));
  }
  if (keysToBulkFetch.length > 0 && typeof Store.bulkGet === 'function') {
    await Store.bulkGet(keysToBulkFetch);
  }

  return { cards, emiSeries, sipSeries, monthsIndex, splitsIndex, existingInvestments };
}

async function renderCurrentMonthCard(domain) {
  const key = currentMonthKey();
  const label = monthKeyLabel(key);
  if (!domain.monthsIndex.includes(key)) {
    return `
    <a class="current-month-card empty" href="/month/${key}">
      <div class="cm-left">
        <div class="cm-eyebrow">This month</div>
        <h3>${label}</h3>
        <div class="cm-sub">You haven't started logging this month yet — tap to begin.</div>
      </div>
    </a>`;
  }
  const data = await loadMonth(key);
  const emiRows = emiRowsForMonth(domain.emiSeries, key, data.deletedEmi);
  const sipRows = sipRowsForMonth(domain.sipSeries, key, data.deletedSip);
  computeMonthTotals(data.entries.concat(emiRows, sipRows)); // parity with original (unused in markup)
  return `
  <a class="current-month-card" href="/month/${key}">
    <div class="cm-left">
      <div class="cm-eyebrow">This month</div>
      <h3>${label}</h3>
      <div class="cm-sub">${data.entries.length} ${data.entries.length === 1 ? 'entry' : 'entries'} logged so far · tap to open</div>
    </div>
  </a>`;
}

/* Runs once per page load: every network round trip and every O(months)
   computation lives here. Nothing below this function touches Store.get(). */
async function buildCache() {
  const domain = await loadDomain();
  const stats = await computeGlobalStats({
    cards: domain.cards, emiSeries: domain.emiSeries, sipSeries: domain.sipSeries,
    monthsIndex: domain.monthsIndex, existingInvestments: domain.existingInvestments,
    isShared: false, sharedSplitId: null, splitsIndex: domain.splitsIndex,
  });
  const splitOwed = await computeGlobalSplitOwedByYou(domain.splitsIndex);
  const dailySeries = await computeDailyBalanceSeries(domain.monthsIndex, domain.emiSeries, domain.sipSeries);
  const currentMonthCardHtml = await renderCurrentMonthCard(domain);
  return { ...domain, stats, splitOwed, dailySeries, currentMonthCardHtml };
}

/* Cheap: only re-slices dailySeries for the chosen range and rebuilds markup
   from data already sitting in memory. Safe to call on every click. */
function renderFromCache() {
  const windowedSeries = windowSeries(cache.dailySeries, balanceChartRange);

  markRendered(root);
  root.removeAttribute('data-loading');
  root.innerHTML = `
  <div class="topbar">
    <a class="brand" href="/home"><span class="mark">₹</span> LedgerNote</a>
  </div>

  <div class="section">
    ${cache.currentMonthCardHtml}
  </div>

  <div class="section">
    <div class="section-title"><h2>Your finances, at a glance</h2><span class="hint">Hover a card for the breakdown</span></div>
    ${renderStatCards(cache.stats, cache.splitOwed)}
  </div>

  <div class="section">
    <div class="section-title"><h2>Balance over time</h2></div>
    <div class="chart-card">
      <div class="chart-toolbar">
        <div class="range-toggle">
          <button class="range-btn ${balanceChartRange === 1 ? 'active' : ''}" data-range="1" type="button">1M</button>
          <button class="range-btn ${balanceChartRange === 3 ? 'active' : ''}" data-range="3" type="button">3M</button>
          <button class="range-btn ${balanceChartRange === 6 ? 'active' : ''}" data-range="6" type="button">6M</button>
        </div>
      </div>
      ${dailyBalanceChart(windowedSeries, balanceChartRange)}
    </div>
  </div>

  <div class="section">
    <div class="section-title"><h2>Manage</h2></div>
    <div class="scroll-wrapper" data-scroll-wrapper>
      <div class="scroll-track money-track" data-scroll-track>
        <a class="action-card" href="/months">
          <div class="ac-icon">☰</div>
          <h3>Previous months</h3>
          <p>Browse every month you've logged so far.</p>
        </a>
        <a class="action-card" href="/cards">
          <div class="ac-icon">▭</div>
          <h3>Credit cards</h3>
          <p>Manage the cards you track charges and dues against.</p>
        </a>
        <a class="action-card" href="/sips">
          <div class="ac-icon">↻</div>
          <h3>Manage SIPs</h3>
          <p>Set up recurring investments so they're auto-tracked every month until you stop them.</p>
        </a>
        <a class="action-card" href="/split">
          <div class="ac-icon">⇄</div>
          <h3>Split Money</h3>
          <p>Track group spends with friends, settle debts, and sync it straight into your ledger.</p>
        </a>
        <a class="action-card" href="/pricetrack">
          <div class="ac-icon">↗</div>
          <h3>Price Tracker</h3>
          <p>Note down what things cost — groceries, transport, subscriptions — and watch prices move over time.</p>
        </a>
      </div>
      <button class="scroll-arrow left" data-scroll-prev type="button" aria-label="Scroll left" style="display:none;">←</button>
      <button class="scroll-arrow" data-scroll-next type="button" aria-label="Scroll right">→</button>
    </div>
  </div>
  `;

  appendPageChrome(root, { showFabHome: false });
  setupScrollWrappers(root);
  setupTableScrollIndicators(root);
}

// Add a guard variable at the top level of home.js
let heroMounted = false;

async function renderHome() {
  if (!currentUser) {
    // PREVENT DOUBLE-RENDER: If the hero is already mounted, do not wipe the DOM again!
    if (heroMounted) return; 
    
    markRendered(root);
    mountLoginHero(root);
    heroMounted = true;
    return;
  }
  
  heroMounted = false; // Reset if user signs in
  if (!cache) cache = await buildCache();
  renderFromCache();
}

root.addEventListener('click', (ev) => {
  const rangeBtn = ev.target.closest('[data-range]');
  if (rangeBtn) {
    balanceChartRange = Number(rangeBtn.dataset.range);
    renderFromCache(); 
  }
});

wireStatCardFlip(root);

window.addEventListener('auth:signed-in', () => { cache = null; renderHome(); });

authReady.then(renderHome);
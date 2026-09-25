import { fmtINR } from '../core/format.js';
import { scrollWrapper } from './scroll-wrapper.js';

const MONEY_MATTERS_LINKS = [
  { href: '/home', label: 'Home', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"></path><path d="M5 9.5V21h14V9.5"></path><path d="M9 21v-7h6v7"></path></svg>' },
  { href: '/months', label: 'Month List', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M16 3v4M8 3v4M3 10h18"></path><path d="M8 14h2M14 14h2M8 17h2M14 17h2"></path></svg>' },
  { href: '/budget', label: 'Budget & Goals', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="5"></circle><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"></circle></svg>' },
  { href: '/cards', label: 'Cards', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2"></rect><path d="M2.5 10h19"></path><path d="M6 15h4"></path></svg>' },
  { href: '/sips', label: 'SIPs', icon: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3" y="13" width="3" height="7" rx="0.8" fill="currentColor"></rect><rect x="8" y="9" width="3" height="11" rx="0.8" fill="currentColor"></rect><rect x="13" y="12" width="3" height="8" rx="0.8" fill="currentColor"></rect><rect x="18" y="8" width="3" height="12" rx="0.8" fill="currentColor"></rect><path d="M3.5 9.5 9 5.5 14.5 8 20 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path><path d="m17.3 3.4 2.8.1-.7 2.7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>' },
  { href: '/subscriptions', label: 'Subscriptions', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.2 8.1A6.9 6.9 0 0 1 18 8.4"></path><path d="m15.5 5.5 3 2.9-4 .8"></path><path d="M16.8 15.9A6.9 6.9 0 0 1 6 15.6"></path><path d="m8.5 18.5-3-2.9 4-.8"></path></svg>' },
  { href: '/split', label: 'Split Money', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3"></circle><circle cx="17" cy="7" r="2.5"></circle><path d="M2.5 20c.4-4 2.4-6 5.5-6s5.1 2 5.5 6"></path><path d="M14 14c.8-.7 1.8-1 3-1 2.6 0 4.1 1.6 4.5 4.8"></path></svg>' },
  { href: '/pricetrack', label: 'Price Tracker', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13 11 22l-9-9V4h9l9 9Z"></path><circle cx="7" cy="9" r="1.5"></circle></svg>' },
];

function isMoneyMattersLinkActive(href) {
  const path = window.location.pathname;
  if (href === '/home') return path === '/' || path === '/home';
  if (href === '/months') return path === '/months' || path.startsWith('/month/');
  return path === href || path.startsWith(`${href}/`);
}

function renderMoneyMattersQuickLinks() {
  const path = window.location.pathname;
  const isHomeDashboard = path === '/' || path === '/home';
  const visibleLinks = MONEY_MATTERS_LINKS.filter(({ href }) => !(isHomeDashboard && href === '/home'));

  const links = visibleLinks.map(({ href, label, icon }) => {
    const active = isMoneyMattersLinkActive(href);
    return `<a class="money-matters-link${active ? ' is-active' : ''}" href="${href}"${active ? ' aria-current="page"' : ''}><span class="money-matters-link-icon" aria-hidden="true">${icon}</span><span class="money-matters-link-label">${label}</span><span class="money-matters-link-arrow" aria-hidden="true">›</span></a>`;
  }).join('');

  return `<section class="dashboard-money-matters" aria-labelledby="dashboard-money-matters-title"><div class="dashboard-money-matters-header"><div class="dashboard-money-matters-title"><div class="dashboard-section-kicker">Quick links</div><h3 id="dashboard-money-matters-title">Money matters</h3></div><div class="dashboard-money-matters-scroll">${scrollWrapper(links, 'money-matters-track')}</div></div></section>`;
}

function percentOfIncome(value, income) {
  const safeIncome = Number(income) || 0;
  if (safeIncome <= 0) return null;
  return Math.round(((Number(value) || 0) / safeIncome) * 100);
}

export function renderDashboardKpis(kpis) {
  const spentPct = percentOfIncome(kpis.spentThisMonth, kpis.income);
  const investedPct = percentOfIncome(kpis.investmentsThisMonth, kpis.income);

  const availableAbnormal = kpis.availableBalance < 0;
  const spendingAbnormal = kpis.income > 0 && kpis.spentThisMonth > kpis.income;
  const investmentAbnormal = kpis.income > 0 && kpis.investmentsThisMonth > kpis.income;
  const forecastTotal = Number(kpis.budgetForecastTotal) || 0;
  const projectionAbnormal = kpis.monthEndProjection < 0;

  const projectionClass = projectionAbnormal ? ' is-negative' : '';

  const availableMeta = availableAbnormal ? `Balance is ${fmtINR(Math.abs(kpis.availableBalance))} below zero` : (kpis.hasCurrentMonth ? `As of ${kpis.asOfLabel} · posted cash activity` : 'Carried from your latest logged month');
  const spentMeta = spendingAbnormal ? `${fmtINR(kpis.spentThisMonth - kpis.income)} more spent than income logged` : (spentPct === null ? 'No income logged this month' : `${spentPct}% of income logged`);
  const investedMeta = investmentAbnormal ? `${fmtINR(kpis.investmentsThisMonth - kpis.income)} more invested than income logged` : (investedPct === null ? 'No income logged this month' : `${investedPct}% of income logged`);

  const projectionMeta = `${fmtINR(forecastTotal)} total forecast spend`;

  const hasCreditCardDues =
    kpis.creditCardDues !== undefined &&
    kpis.creditCardDues !== null;

  const creditCardDues = Number(kpis.creditCardDues) || 0;

  const creditCardDuesCard = hasCreditCardDues
    ? `
      <article class="dashboard-kpi-card dashboard-kpi-card-carddues">
        <div class="dashboard-kpi-top">
          <span class="dashboard-kpi-label">Credit Card Dues</span>
          <span class="dashboard-kpi-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2"></rect>
              <path d="M3 9h18"></path>
              <path d="M7 15h4"></path>
            </svg>
          </span>
        </div>

        <div class="dashboard-kpi-value">
          ${fmtINR(creditCardDues)}
        </div>

        <div class="dashboard-kpi-footer">
          <span class="dashboard-kpi-meta">
            ${creditCardDues > 0
              ? 'Outstanding across your credit cards'
              : 'No outstanding credit card dues'}
          </span>
          <span class="dashboard-kpi-chip">Credit</span>
        </div>
      </article>
    `
    : '';

  return `
    <div class="dashboard-kpi-grid">
      <article class="dashboard-kpi-card dashboard-kpi-card-balance">
        <div class="dashboard-kpi-top"><span class="dashboard-kpi-label">Available Balance</span><span class="dashboard-kpi-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="14" rx="2"></rect><path d="M16 11h5v5h-5a2.5 2.5 0 0 1 0-5Z"></path><path d="M7 6V4h10v2"></path></svg></span></div>
        <div class="dashboard-kpi-value">${fmtINR(kpis.availableBalance)}</div>
        <div class="dashboard-kpi-footer"><span class="dashboard-kpi-meta${availableAbnormal ? ' is-warning' : ''}">${availableAbnormal ? '<span class="dashboard-kpi-info" aria-hidden="true">i</span>' : ''}${availableMeta}</span><span class="dashboard-kpi-chip">Today</span></div>
      </article>

      <article class="dashboard-kpi-card dashboard-kpi-card-spend">
        <div class="dashboard-kpi-top"><span class="dashboard-kpi-label">Spent This Month</span><span class="dashboard-kpi-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18 10 12l4 4 6-8"></path><path d="M15 8h5v5"></path></svg></span></div>
        <div class="dashboard-kpi-value">${fmtINR(kpis.spentThisMonth)}</div>
        <div class="dashboard-kpi-footer"><span class="dashboard-kpi-meta${spendingAbnormal ? ' is-warning' : ''}">${spendingAbnormal ? '<span class="dashboard-kpi-info" aria-hidden="true">i</span>' : ''}${spentMeta}</span><span class="dashboard-kpi-chip">Month</span></div>
      </article>

      <article class="dashboard-kpi-card dashboard-kpi-card-invest">
        <div class="dashboard-kpi-top"><span class="dashboard-kpi-label">Investments This Month</span><span class="dashboard-kpi-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="13" width="4" height="7" rx="1"></rect><rect x="10" y="9" width="4" height="11" rx="1"></rect><rect x="17" y="4" width="4" height="16" rx="1"></rect></svg></span></div>
        <div class="dashboard-kpi-value">${fmtINR(kpis.investmentsThisMonth)}</div>
        <div class="dashboard-kpi-footer"><span class="dashboard-kpi-meta${investmentAbnormal ? ' is-warning' : ''}">${investmentAbnormal ? '<span class="dashboard-kpi-info" aria-hidden="true">i</span>' : ''}${investedMeta}</span><span class="dashboard-kpi-chip">Month</span></div>
      </article>

      ${creditCardDuesCard}

      <article class="dashboard-kpi-card dashboard-kpi-card-projection${projectionClass}">
        <div class="dashboard-kpi-top"><span class="dashboard-kpi-label">Month-End Projection</span><span class="dashboard-kpi-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path><path d="m17.5 5.5 1.5-1.5"></path></svg></span></div>
        <div class="dashboard-kpi-value">${fmtINR(kpis.monthEndProjection)}</div>
        <div class="dashboard-kpi-footer"><span class="dashboard-kpi-meta${projectionAbnormal ? ' is-warning' : ''}">${projectionAbnormal ? '<span class="dashboard-kpi-info" aria-hidden="true">i</span>' : ''}${projectionMeta}</span><span class="dashboard-kpi-chip">Month end</span></div>
      </article>
    </div>

    ${renderMoneyMattersQuickLinks()}
  `;
}
import { fmtINR } from '../core/format.js';

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
  const projectionAbnormal = kpis.monthEndProjection < 0;

  const projectionClass = projectionAbnormal ? ' is-negative' : '';

  const availableMeta = availableAbnormal ? `Balance is ${fmtINR(Math.abs(kpis.availableBalance))} below zero` : (kpis.hasCurrentMonth ? `As of ${kpis.asOfLabel} · posted cash activity` : 'Carried from your latest logged month');
  const spentMeta = spendingAbnormal ? `${fmtINR(kpis.spentThisMonth - kpis.income)} more spent than income logged` : (spentPct === null ? 'No income logged this month' : `${spentPct}% of income logged`);
  const investedMeta = investmentAbnormal ? `${fmtINR(kpis.investmentsThisMonth - kpis.income)} more invested than income logged` : (investedPct === null ? 'No income logged this month' : `${investedPct}% of income logged`);
  const projectionMeta = projectionAbnormal ? `Projected to end ${fmtINR(Math.abs(kpis.monthEndProjection))} below zero` : (kpis.pendingCashCommitments > 0 ? `${fmtINR(kpis.pendingCashCommitments)} scheduled cash commitments remaining` : 'No scheduled cash commitments remaining');

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
        <div class="dashboard-kpi-top"><span class="dashboard-kpi-label">Investments This Month</span><span class="dashboard-kpi-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V12"></path><path d="M10 20V8"></path><path d="M16 20V4"></path><path d="M22 20H2"></path></svg></span></div>
        <div class="dashboard-kpi-value">${fmtINR(kpis.investmentsThisMonth)}</div>
        <div class="dashboard-kpi-footer"><span class="dashboard-kpi-meta${investmentAbnormal ? ' is-warning' : ''}">${investmentAbnormal ? '<span class="dashboard-kpi-info" aria-hidden="true">i</span>' : ''}${investedMeta}</span><span class="dashboard-kpi-chip">Month</span></div>
      </article>

      <article class="dashboard-kpi-card dashboard-kpi-card-projection${projectionClass}">
        <div class="dashboard-kpi-top"><span class="dashboard-kpi-label">Month-End Projection</span><span class="dashboard-kpi-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path><path d="m17.5 5.5 1.5-1.5"></path></svg></span></div>
        <div class="dashboard-kpi-value">${fmtINR(kpis.monthEndProjection)}</div>
        <div class="dashboard-kpi-footer"><span class="dashboard-kpi-meta${projectionAbnormal ? ' is-warning' : ''}">${projectionAbnormal ? '<span class="dashboard-kpi-info" aria-hidden="true">i</span>' : ''}${projectionMeta}</span><span class="dashboard-kpi-chip">Month end</span></div>
      </article>
    </div>
  `;
}
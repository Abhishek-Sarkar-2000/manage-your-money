import { fmtINR, fmtINRShort, monthKeyShort, addMonths } from '../core/format.js';

function niceChartStep(rawValue) {
  if (!Number.isFinite(rawValue) || rawValue <= 0) return 1;

  const exponent = Math.floor(Math.log10(rawValue));
  const magnitude = Math.pow(10, exponent);
  const normalized = rawValue / magnitude;

  if (normalized <= 1) return magnitude;
  if (normalized <= 2) return 2 * magnitude;
  if (normalized <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

function windowCashflowSeries(series, rangeMonths, currentMonthKey) {
  const byMonth = new Map((series || []).map(row => [row.monthKey, row]));
  const keys = [];

  for (let offset = -(rangeMonths - 1); offset <= 0; offset++) {
    keys.push(addMonths(currentMonthKey, offset));
  }

  return keys.map(monthKey => byMonth.get(monthKey) || { monthKey, income: 0, spending: 0, investments: 0 });
}

export function renderDashboardCashflowChart(series, rangeMonths, currentMonthKey) {
  const rows = windowCashflowSeries(series, rangeMonths, currentMonthKey);
  const metrics = [
    { key: 'income', label: 'Income', className: 'is-income' },
    { key: 'spending', label: 'Spending', className: 'is-spending' },
    { key: 'investments', label: 'Investments', className: 'is-investments' },
  ];

  const useOriginalCompactChart =
    window.matchMedia('(max-width: 1023px)').matches;

  const width = 900;

  /*
   * Tablet/mobile return to the original Cash Flow graph.
   * Only desktop receives the taller plotting area.
   */
  const height = useOriginalCompactChart ? 230 : 430;

  const padLeft = 72;
  const padRight = 18;
  const padTop = useOriginalCompactChart ? 18 : 22;
  const padBottom = useOriginalCompactChart ? 42 : 46;

  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const maxValue = Math.max(
    1,
    ...rows.flatMap(row =>
      metrics.map(metric =>
        Number(row[metric.key]) || 0
      )
    )
  );

  const desiredTickIntervals = useOriginalCompactChart
    ? 4
    : Math.max(
        4,
        Math.min(
          8,
          Math.round(plotHeight / 55)
        )
      );

  const tickStep = niceChartStep(
    maxValue / desiredTickIntervals
  );
  const axisMax = Math.max(tickStep, Math.ceil(maxValue / tickStep) * tickStep);
  const tickCount = Math.round(axisMax / tickStep);
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => index * tickStep);

  const grid = ticks.map(value => {
    const y = padTop + plotHeight - (value / axisMax) * plotHeight;
    return `<g class="dashboard-cashflow-gridline"><line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}"></line><text x="${padLeft - 10}" y="${(y + 3).toFixed(1)}" text-anchor="end">${fmtINRShort(value)}</text></g>`;
  }).join('');

  const groupWidth = plotWidth / rows.length;
  const barWidth = Math.min(30, Math.max(11, (groupWidth - 24) / 3));
  const barGap = Math.min(7, Math.max(3, barWidth * 0.2));
  const clusterWidth = (barWidth * 3) + (barGap * 2);

  const bars = rows.map((row, rowIndex) => {
    const groupStart = padLeft + (rowIndex * groupWidth) + ((groupWidth - clusterWidth) / 2);

    const monthBars = metrics.map((metric, metricIndex) => {
      const value = Math.max(0, Number(row[metric.key]) || 0);
      const barHeight = value > 0 ? Math.max(2, (value / axisMax) * plotHeight) : 0;
      const x = groupStart + metricIndex * (barWidth + barGap);
      const y = padTop + plotHeight - barHeight;

      return `<rect class="dashboard-cashflow-bar ${metric.className}" data-val="${fmtINR(value)}" data-label="${metric.label} · ${monthKeyShort(row.monthKey)}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="3"></rect>`;
    }).join('');

    const labelX = padLeft + (rowIndex * groupWidth) + (groupWidth / 2);
    return `${monthBars}<text class="dashboard-cashflow-month-label" x="${labelX.toFixed(1)}" y="${height - 10}" text-anchor="middle">${monthKeyShort(row.monthKey)}</text>`;
  }).join('');

  return `
    <div class="dashboard-cashflow-chart">
      <div class="dashboard-cashflow-legend">
        <span><i class="is-income"></i>Income</span>
        <span><i class="is-spending"></i>Spending</span>
        <span><i class="is-investments"></i>Investments</span>
      </div>
      <div class="dashboard-cashflow-svg-wrap">
        <svg
          viewBox="0 0 ${width} ${height}"
          role="img"
          aria-label="Monthly income, spending and investment chart"
        >${grid}${bars}</svg>
      </div>
      <div class="dashboard-chart-note">The current month reflects posted activity through today. Future scheduled commitments are shown separately in the projection.</div>
    </div>
  `;
}

export function renderMonthEndProjection(kpis) {
  const breakdown = kpis.pendingCashBreakdown || { emi: 0, sip: 0, recurring: 0 };
  const available = Number(kpis.availableBalance) || 0;
  const pending = Number(kpis.pendingCashCommitments) || 0;
  const projected = Number(kpis.monthEndProjection) || 0;
  const commitmentPct = available > 0 ? Math.min(100, Math.max(0, (pending / available) * 100)) : (pending > 0 ? 100 : 0);

  const obligationRows = [
    { label: 'Remaining EMIs', value: Number(breakdown.emi) || 0 },
    { label: 'Remaining SIPs', value: Number(breakdown.sip) || 0 },
    { label: 'Bank recurring payments', value: Number(breakdown.recurring) || 0 },
  ].filter(row => row.value > 0);

  const deductions = obligationRows.length ? obligationRows.map(row => `<div class="dashboard-projection-row"><span>${row.label}</span><strong>− ${fmtINR(row.value)}</strong></div>`).join('') : `<div class="dashboard-projection-empty">No remaining scheduled cash commitments this month.</div>`;

  return `
    <div class="dashboard-projection-body ${projected < 0 ? 'is-negative' : ''}">
      <div class="dashboard-projection-hero">
        <span>Projected month-end balance</span>
        <strong>${fmtINR(projected)}</strong>
      </div>
      <div class="dashboard-projection-meter" style="--projection-used:${commitmentPct.toFixed(1)}%;"><span></span></div>
      <div class="dashboard-projection-bridge">
        <div class="dashboard-projection-row is-start"><span>Available today</span><strong>${fmtINR(available)}</strong></div>
        ${deductions}
        <div class="dashboard-projection-row is-result"><span>Projected balance</span><strong>${fmtINR(projected)}</strong></div>
      </div>
      <div class="dashboard-projection-note"><span class="dashboard-projection-info" aria-hidden="true">i</span><span>Uses known remaining cash commitments only. It does not estimate discretionary spending or future credit-card settlement payments.</span></div>
    </div>
  `;
}
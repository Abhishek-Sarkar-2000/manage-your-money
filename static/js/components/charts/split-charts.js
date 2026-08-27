/* ---------- Split Money charts: who-owes-how-much + shares-by-member ---------- */
import { escapeHtml } from '../../core/dom.js';
import { fmtINR } from '../../core/format.js';
import { formatChartMoney, buildNiceChartTicks } from './axis-grid.js';
import { SPLIT_YOU, computeGroupSettlementView } from '../../core/split-domain.js';

export const SPLIT_PALETTE = ['var(--blue)', '#C98A3C', '#8E6FB0', 'var(--debit)', 'var(--credit)', '#5B4B9E', 'var(--amber)', 'var(--blue-soft)', '#2E7D6B', '#AD4358'];

export function sharedStackedDebtChart(group, getYouLabel) {
  const { cards } = computeGroupSettlementView(group);
  const outstanding = cards.filter(c => !c.settled && Number(c.amount) > 0.004);
  if (!outstanding.length) {
    return `<div class="empty-chart">No outstanding debts in this group.</div>`;
  }

  const byDebtor = {};
  for (const transfer of outstanding) {
    if (!byDebtor[transfer.from]) byDebtor[transfer.from] = {};
    byDebtor[transfer.from][transfer.to] = (byDebtor[transfer.from][transfer.to] || 0) + Number(transfer.amount || 0);
  }

  const debtors = Object.entries(byDebtor)
    .map(([debtor, creditors]) => ({
      debtor,
      creditors: Object.entries(creditors).filter(([, amount]) => amount > 0.004).map(([creditor, amount]) => ({ creditor, amount })),
    }))
    .filter(x => x.creditors.length);

  if (!debtors.length) {
    return `<div class="empty-chart">No outstanding debts in this group.</div>`;
  }

  const allCreditors = [];
  for (const debtor of debtors) {
    for (const { creditor } of debtor.creditors) {
      if (!allCreditors.includes(creditor)) allCreditors.push(creditor);
    }
  }

  const debtorTotals = debtors.map(({ debtor, creditors }) => ({
    debtor, creditors,
    total: creditors.reduce((sum, item) => sum + Number(item.amount || 0), 0),
  }));

  const actualMaxTotal = Math.max(1, ...debtorTotals.map(item => item.total));
  const debtAxis = buildNiceChartTicks(actualMaxTotal, 4);
  const maxTotal = debtAxis.max;

  const xTicks = debtAxis.ticks.map(value => ({ value, percent: debtAxis.max > 0 ? (value / debtAxis.max) * 100 : 0 }));
  const gridLines = xTicks.map(tick => `<div class="shared-debt-grid-line" style="left:${tick.percent}%"></div>`).join('');
  const xLabels = xTicks.map(tick => `<span class="shared-debt-x-tick" style="left:${tick.percent}%">${formatChartMoney(tick.value)}</span>`).join('');

  const bars = debtorTotals.map(({ debtor, creditors, total }) => {
    const totalWidth = maxTotal > 0 ? (total / maxTotal) * 100 : 0;
    const segments = creditors.map(({ creditor, amount }) => {
      const color = SPLIT_PALETTE[allCreditors.indexOf(creditor) % SPLIT_PALETTE.length];
      const segmentWidth = total > 0 ? (amount / total) * 100 : 0;
      const creditorLabel = creditor === SPLIT_YOU ? getYouLabel() : escapeHtml(String(creditor).toUpperCase());
      return `<div class="shared-debt-segment" style="width:${segmentWidth}%; background:${color};" title="${creditorLabel}: ${fmtINR(amount)}"></div>`;
    }).join('');

    const debtorLabel = debtor === SPLIT_YOU ? getYouLabel() : escapeHtml(String(debtor).toUpperCase());
    const isInside = totalWidth > 50;

    return `
      <div class="shared-debt-row">
        <div class="shared-debt-label" title="${debtorLabel}">${debtorLabel}</div>
        <div class="shared-debt-plot">
          <div class="shared-debt-grid">${gridLines}</div>
          <div class="shared-debt-bar" style="width:${totalWidth}%; --bar-end:${totalWidth}%">
            ${segments}
            ${isInside ? `<div class="shared-debt-total inside num">${fmtINR(total)}</div>` : ''}
          </div>
          ${!isInside ? `<div class="shared-debt-total outside num" style="left:${totalWidth}%;">${fmtINR(total)}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  const legend = allCreditors.map((creditor, i) => {
    const color = SPLIT_PALETTE[i % SPLIT_PALETTE.length];
    const label = creditor === SPLIT_YOU ? getYouLabel() : escapeHtml(String(creditor).toUpperCase());
    return `<div class="shared-chart-legend-item"><span class="shared-chart-legend-dot" style="background:${color};"></span><span>${label}</span></div>`;
  }).join('');

  return `
    <div class="shared-debt-chart">
      <div class="shared-debt-bars">
        ${bars}
        <div></div>
        <div class="shared-debt-axis">
          <div class="shared-debt-axis-line"></div>
          ${xLabels}
        </div>
      </div>
      <div class="shared-chart-axis-title">Amount (₹)</div>
      <div class="shared-chart-legend">${legend}</div>
    </div>
  `;
}

export function sharedSharesBarChart(group, getYouLabel) {
  const totals = {};
  for (const person of group.people) totals[person] = 0;
  for (const spend of (group.spends || [])) {
    for (const [person, amount] of Object.entries(spend.shares || {})) {
      totals[person] = (totals[person] || 0) + (Number(amount) || 0);
    }
  }

  const pairs = Object.entries(totals)
    .map(([person, value]) => ({ person, value: Math.round(value * 100) / 100 }))
    .filter(x => x.value > 0.004)
    .sort((a, b) => b.value - a.value);

  if (!pairs.length) {
    return `<div class="empty-chart">No shares recorded in this group yet.</div>`;
  }

  const actualMaxValue = Math.max(1, ...pairs.map(x => x.value));
  const shareAxis = buildNiceChartTicks(actualMaxValue, 4);
  const maxValue = shareAxis.max;
  const yTicks = shareAxis.ticks.map(value => ({ value, percent: shareAxis.max > 0 ? (value / shareAxis.max) * 100 : 0 }));

  const gridLines = yTicks.map(tick => `<div class="shared-share-grid-line" style="bottom:${tick.percent}%"></div>`).join('');
  const yLabels = yTicks.map(tick => `<span class="shared-share-y-tick" style="bottom:${tick.percent}%">${formatChartMoney(tick.value)}</span>`).join('');

  const bars = pairs.map((pair, i) => {
    const height = maxValue > 0 ? (pair.value / maxValue) * 100 : 0;
    const label = pair.person === SPLIT_YOU ? getYouLabel() : escapeHtml(String(pair.person).toUpperCase());
    const color = SPLIT_PALETTE[i % SPLIT_PALETTE.length];
    const isInside = height > 50;
    const formattedValue = fmtINR(pair.value);
    return `
      <div class="shared-share-bar-col">
        <div class="shared-share-bar-area">
          <div class="shared-share-bar" style="height:${height}%; background:${color};" title="${label}: ${formattedValue}">
            ${isInside ? `<div class="shared-share-value-wrap inside"><div class="shared-share-value-text num">${formattedValue}</div></div>` : ''}
          </div>
          ${!isInside ? `<div class="shared-share-value-wrap outside" style="bottom:${height}%;"><div class="shared-share-value-text num">${formattedValue}</div></div>` : ''}
        </div>
      </div>`;
  }).join('');

  const labels = pairs.map((pair) => {
    const label = pair.person === SPLIT_YOU ? getYouLabel() : escapeHtml(String(pair.person).toUpperCase());
    return `<div class="shared-share-label" title="${label}">${label}</div>`;
  }).join('');

  return `
    <div class="shared-share-chart">
      <div class="shared-share-y-axis">${yLabels}</div>
      <div class="shared-share-plot">
        <div class="shared-share-grid">${gridLines}</div>
        <div class="shared-share-bars">${bars}</div>
        <div class="shared-share-axis-line"></div>
      </div>
      <div class="shared-share-corner"></div>
      <div class="shared-share-x-labels">${labels}</div>
    </div>
    <div class="shared-share-axis-title">Total Share (₹)</div>
  `;
}

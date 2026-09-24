import { escapeHtml } from '../core/dom.js';
import { fmtINR } from '../core/format.js';
import { renderDashboardPager } from './dashboard-secondary.js';

function statusLabel(status) {
  if (status === 'over') return 'Over budget';
  if (status === 'forecast') return 'Projected over';
  if (status === 'high') return 'High spend';
  return 'On track';
}

export function renderDashboardBudget(snapshot, perPage = 4) {
  if (!snapshot?.hasBudget) {
    return `<div class="dashboard-budget-empty"><strong>No budget set for this month.</strong><span>Create a budget to track category usage and get overspend alerts here.</span><a href="/budget">Set up budget <span aria-hidden="true">→</span></a></div>`;
  }

  const usedPct = Number(snapshot.usedPct) || 0;
  const clampedUsedPct = Math.min(100, Math.max(0, usedPct));
  const categories = snapshot.categories || [];
  const pages = [];

  for (let index = 0; index < categories.length; index += perPage) {
    const categoryHtml = categories
      .slice(index, index + perPage)
      .map(category => {
        const pct = category.budget > 0
          ? category.usedPct
          : (category.used > 0 ? 100 : 0);

        const barPct = Math.min(100, Math.max(0, pct));

        const secondary = category.overAmount > 0
          ? `${fmtINR(category.overAmount)} over`
          : category.projectedOverAmount > 0
            ? `Projected ${fmtINR(category.projectedOverAmount)} over`
            : `${fmtINR(Math.max(0, category.remaining))} left`;

        return `
          <div class="dashboard-budget-row is-${escapeHtml(category.status)}">
            <div class="dashboard-budget-row-head">
              <span class="dashboard-budget-name">${escapeHtml(category.name)}</span>
              <span class="dashboard-budget-values">
                ${fmtINR(category.used)} / ${fmtINR(category.budget)}
              </span>
            </div>

            <div class="dashboard-budget-progress">
              <span style="width:${barPct.toFixed(1)}%"></span>
            </div>

            <div class="dashboard-budget-row-foot">
              <span>${escapeHtml(statusLabel(category.status))}</span>
              <span>${escapeHtml(secondary)}</span>
            </div>
          </div>
        `;
      })
      .join('');

    pages.push(`<div class="dashboard-budget-rows">${categoryHtml}</div>`);
  }

  const overallMeta = snapshot.totalRemaining >= 0
    ? `${fmtINR(snapshot.totalRemaining)} remaining`
    : `${fmtINR(Math.abs(snapshot.totalRemaining))} over budget`;

  return `
    <div class="dashboard-budget-summary is-${escapeHtml(snapshot.overallStatus)}">
      <div class="dashboard-budget-summary-copy">
        <span>Used this month</span>
        <strong>
          ${fmtINR(snapshot.totalUsed)}
          <small>of ${fmtINR(snapshot.totalBudget)}</small>
        </strong>
      </div>

      <span class="dashboard-budget-percent">${Math.round(usedPct)}%</span>
    </div>

    <div class="dashboard-budget-overall-progress">
      <span style="width:${clampedUsedPct.toFixed(1)}%"></span>
    </div>

    <div class="dashboard-budget-overall-meta">
      <span>${escapeHtml(overallMeta)}</span>
      ${
        snapshot.projectedOverAmount > 0
          ? `<span class="is-warning">Projected ${fmtINR(snapshot.projectedOverAmount)} over by month-end</span>`
          : '<span>Based on posted spending</span>'
      }
    </div>

    ${renderDashboardPager(pages, 'Budget categories')}

    ${
      snapshot.unbudgeted.total > 0
        ? `<div class="dashboard-budget-unbudgeted"><span class="dashboard-budget-info" aria-hidden="true">i</span><span><strong>${fmtINR(snapshot.unbudgeted.total)}</strong> of posted spending is outside your current budget.</span></div>`
        : ''
    }
  `;
}
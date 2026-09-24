import { escapeHtml } from '../core/dom.js';
import { fmtINR } from '../core/format.js';
import { renderDashboardPager } from './dashboard-secondary.js';

function formatCardDashboardDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function urgencyLabel(card) {
  if (card.urgency === 'overdue') return 'Overdue';
  if (card.daysUntilDue === 0) return 'Due today';
  if (card.daysUntilDue === 1) return 'Due tomorrow';
  if (card.urgency === 'critical' || card.urgency === 'warning') return `Due in ${card.daysUntilDue} days`;
  return `Due ${formatCardDashboardDate(card.dueDate)}`;
}

export function renderDashboardCards(snapshot, perPage = 2) {
  const cards = Array.isArray(snapshot?.cards) ? snapshot.cards : [];

  if (!cards.length) {
    return `<div class="dashboard-card-empty"><strong>No credit cards added yet.</strong><span>Add cards to track statement cycles, outstanding balances and upcoming payment dates.</span><a href="/cards">Add a card <span aria-hidden="true">→</span></a></div>`;
  }

  const pages = [];

  for (let index = 0; index < cards.length; index += perPage) {
    const rows = cards.slice(index, index + perPage).map(card => {
      const statementValue =
        card.statementDueAmount > 0
          ? card.statementDueAmount
          : card.lastStatementAmount;

      const statementLabel =
        card.statementDueAmount > 0
          ? 'Statement due'
          : 'Last statement';

      return `
        <a
          class="dashboard-card-row is-${escapeHtml(card.urgency)}"
          href="/cards?card=${encodeURIComponent(card.id)}&cycle=${card.statementDueAmount > 0 ? 'last' : 'current'}"
        >
          <div class="dashboard-card-row-top">
            <div class="dashboard-card-identity">
              <strong>${escapeHtml(card.name)}</strong>
              <span>${escapeHtml(urgencyLabel(card))}</span>
            </div>

            <div class="dashboard-card-outstanding">
              <span>Outstanding</span>
              <strong>${fmtINR(card.outstanding)}</strong>
            </div>
          </div>

          <div class="dashboard-card-metrics">
            <div>
              <span>${statementLabel}</span>
              <strong>${fmtINR(statementValue)}</strong>
            </div>

            <div>
              <span>Current cycle</span>
              <strong>${fmtINR(card.currentCycleAmount)}</strong>
            </div>

            <div>
              <span>Payment date</span>
              <strong>${formatCardDashboardDate(card.dueDate)}</strong>
            </div>
          </div>

          <div class="dashboard-card-cycle">
            <span>${formatCardDashboardDate(card.cycleStart)}</span>
            <span class="dashboard-card-cycle-line"></span>
            <span>${formatCardDashboardDate(card.cycleEnd)}</span>
          </div>
        </a>
      `;
    }).join('');

    pages.push(`<div class="dashboard-card-list">${rows}</div>`);
  }

  return `
    <div class="dashboard-card-summary">
      <div>
        <span>Total outstanding</span>
        <strong>${fmtINR(snapshot.totalOutstanding || 0)}</strong>
      </div>

      ${
        snapshot.urgentCount
          ? `<span class="dashboard-card-alert-count">${snapshot.urgentCount} need${snapshot.urgentCount === 1 ? 's' : ''} attention</span>`
          : '<span class="dashboard-card-clear">No urgent payments</span>'
      }
    </div>

    ${renderDashboardPager(pages, 'Credit card dues')}
  `;
}
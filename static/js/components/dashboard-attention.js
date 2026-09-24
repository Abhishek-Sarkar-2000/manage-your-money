import { escapeHtml } from '../core/dom.js';
import { fmtINR } from '../core/format.js';
import { renderDashboardPager } from './dashboard-secondary.js';

function formatDashboardDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(`${dateStr}T00:00:00`);
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function dashboardAttentionIcon(kind) {
  const icons = {
    card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 10h18"></path></svg>',
    balance: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 21h20L12 3Z"></path><path d="M12 9v5"></path><path d="M12 18h.01"></path></svg>',
    projection: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 6 6 4-4 6 6"></path><path d="M20 9v5h-5"></path></svg>',
    review: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"></path><path d="M8 9h8M8 13h5M8 17h3"></path></svg>',
    budget: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v10"></path><path d="M16 9.5c0-1.4-1.8-2.5-4-2.5S8 8 8 9.5s1.8 2.5 4 2.5 4 1.1 4 2.5-1.8 2.5-4 2.5-4-1.1-4-2.5"></path></svg>',
    emi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11 12 4l9 7"></path><path d="M5 10v10h14V10"></path><path d="M9 20v-6h6v6"></path></svg>',
    sip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V10"></path><path d="M12 14c-5 0-7-3-7-7 4 0 7 2 7 7Z"></path><path d="M12 11c4 0 6-2 6-6-4 0-6 2-6 6Z"></path></svg>',
    recurring: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18.5 7.5A8 8 0 1 0 20 14"></path><path d="M18.5 7.5V3.5"></path><path d="M18.5 7.5h-4"></path></svg>'
  };

  return icons[kind] || icons.review;
}

export function renderMoneyInbox(inbox, perPage = 5) {
  const items = inbox?.items || [];

  if (!items.length) {
    return `
      <div class="dashboard-attention-empty">
        <span class="dashboard-empty-check" aria-hidden="true">✓</span>
        <strong>Nothing needs attention right now.</strong>
        <small>New due dates, balance risks and review items will appear here automatically.</small>
      </div>
    `;
  }

  const pages = [];

  for (let index = 0; index < items.length; index += perPage) {
    const rows = items.slice(index, index + perPage).map(item => `
      <a
        class="dashboard-attention-row is-${escapeHtml(item.severity || 'info')}"
        href="${escapeHtml(item.href || '#')}"
      >
        <span class="dashboard-attention-icon" aria-hidden="true">
          ${dashboardAttentionIcon(item.kind)}
        </span>

        <span class="dashboard-attention-copy">
          <strong>${escapeHtml(item.title)}</strong>
          <small>${escapeHtml(item.detail || '')}</small>
        </span>

        ${
          item.amount !== undefined
            ? `<span class="dashboard-attention-amount">${fmtINR(item.amount)}</span>`
            : ''
        }

        <span class="dashboard-attention-chevron" aria-hidden="true">›</span>
      </a>
    `).join('');

    pages.push(`<div class="dashboard-attention-list">${rows}</div>`);
  }

  return renderDashboardPager(pages, 'Money Inbox');
}

export function renderUpcomingSpends(events, perPage = 5, horizonDays = 20) {
  const allEvents = Array.isArray(events) ? events : [];

  if (!allEvents.length) {
    return `
      <div class="dashboard-attention-empty">
        <span class="dashboard-empty-check" aria-hidden="true">✓</span>
        <strong>No scheduled commitments in the next ${horizonDays} days.</strong>
        <small>Active EMIs, SIPs and recurring payments will appear here.</small>
      </div>
    `;
  }

  const pages = [];

  for (let index = 0; index < allEvents.length; index += perPage) {
    const rows = allEvents.slice(index, index + perPage).map(event => `
      <a class="dashboard-upcoming-row" href="${escapeHtml(event.href || '#')}">
        <span
          class="dashboard-upcoming-icon is-${escapeHtml(event.kind)}"
          aria-hidden="true"
        >
          ${dashboardAttentionIcon(event.kind)}
        </span>

        <span class="dashboard-upcoming-copy">
          <strong>${escapeHtml(event.title)}</strong>
          <small>${escapeHtml(event.meta || '')}</small>
        </span>

        <span class="dashboard-upcoming-money">
          <strong>${fmtINR(event.amount)}</strong>
          <small>${formatDashboardDate(event.date)}</small>
        </span>
      </a>
    `).join('');

    pages.push(`<div class="dashboard-upcoming-list">${rows}</div>`);
  }

  return renderDashboardPager(
    pages,
    `Upcoming spends within ${horizonDays} days`,
  );
}
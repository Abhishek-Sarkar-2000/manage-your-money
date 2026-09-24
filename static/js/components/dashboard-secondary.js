import { escapeHtml } from '../core/dom.js';
import { fmtINR, monthKeyLabel } from '../core/format.js';

function dashboardPageSlices(items, pageSize, maxPages = Infinity) {
  const source = Array.isArray(items) ? items : [];
  const size = Math.max(1, Number(pageSize) || 1);
  const pageCap = Number.isFinite(maxPages) ? Math.max(1, Number(maxPages) || 1) : Infinity;
  const visible = source.slice(0, Number.isFinite(pageCap) ? size * pageCap : source.length);
  const pages = [];

  for (let index = 0; index < visible.length; index += size) {
    pages.push(visible.slice(index, index + size));
  }

  return { pages, shownCount: visible.length };
}

export function renderDashboardPager(pageHtml, label = 'Dashboard items') {
  const pages = (Array.isArray(pageHtml) ? pageHtml : []).filter(Boolean);
  if (!pages.length) return '';

  const isSinglePage = pages.length === 1;

  const dots = pages.map((_, index) => `
    <button
      class="dashboard-pager-dot ${index === 0 ? 'is-active' : ''}"
      type="button"
      data-dashboard-page-target="${index}"
      aria-label="Show page ${index + 1} of ${pages.length}"
      ${index === 0 ? 'aria-current="true"' : ''}
      ${isSinglePage ? 'disabled' : ''}
    ></button>
  `).join('');

  return `
    <div
      class="dashboard-pager ${isSinglePage ? 'is-single-page' : ''}"
      data-dashboard-pager
      data-dashboard-pager-index="0"
      style="--dashboard-page-offset:0%;"
      aria-label="${escapeHtml(label)}"
    >
      <div class="dashboard-pager-viewport">
        <div class="dashboard-pager-track">
          ${pages.map((page, index) => `
            <div
              class="dashboard-pager-page"
              data-dashboard-pager-page="${index}"
              aria-hidden="${index === 0 ? 'false' : 'true'}"
              ${index === 0 ? '' : 'inert'}
            >${page}</div>
          `).join('')}
        </div>
      </div>

      <div class="dashboard-pager-controls">
        <button
          class="dashboard-pager-arrow"
          type="button"
          data-dashboard-page-dir="-1"
          aria-label="Previous page"
          disabled
        >‹</button>

        <div class="dashboard-pager-dots">${dots}</div>

        <button
          class="dashboard-pager-arrow"
          type="button"
          data-dashboard-page-dir="1"
          aria-label="Next page"
          ${isSinglePage ? 'disabled' : ''}
        >›</button>
      </div>
    </div>
  `;
}

function formatDashboardDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function goalTiming(goal) {
  if (goal.completed) return 'Completed';
  if (!goal.expectedMonth) return 'No target month';
  if (goal.monthsLeft === 0) return `Target ${monthKeyLabel(goal.expectedMonth)}`;
  return `${goal.monthsLeft} month${goal.monthsLeft === 1 ? '' : 's'} left`;
}

function priceMeta(item) {
  const meta = item.meta || {};
  if (meta.source && meta.destination) return `${meta.source} → ${meta.destination}`;
  if (meta.quantity && meta.location) return `${meta.quantity} @ ${meta.location}`;
  if (meta.quantity) return meta.quantity;
  if (meta.location) return meta.location;
  return item.category || '';
}

export function renderDashboardGoals(snapshot, perPage = 1, maxPages = 3) {
  const goals = snapshot?.goals || [];

  if (!goals.length) {
    return `<div class="dashboard-secondary-empty"><strong>No active financial goals.</strong><span>Create a goal to track funding progress and deadlines here.</span><a href="/budget">Set a goal <span aria-hidden="true">→</span></a></div>`;
  }

  const { pages, shownCount } = dashboardPageSlices(goals, perPage, maxPages);

  const pageHtml = pages.map(pageGoals => {
    const rows = pageGoals.map(goal => `
      <a
        class="dashboard-goal-row ${goal.completed ? 'is-completed' : ''}"
        href="/budget?focus=goal&id=${encodeURIComponent(goal.id)}"
      >
        <div class="dashboard-goal-head">
          <div>
            <strong>${escapeHtml(goal.name)}</strong>
            <span>${escapeHtml(goalTiming(goal))}</span>
          </div>
          <span class="dashboard-goal-percent">${Math.round(goal.progressPct)}%</span>
        </div>

        <div class="dashboard-goal-progress">
          <span style="width:${goal.progressPct.toFixed(1)}%"></span>
        </div>

        <div class="dashboard-goal-foot">
          <span>${fmtINR(goal.funded)} of ${fmtINR(goal.targetAmount)}</span>
          ${
            goal.thisMonthFunded > 0
              ? `<span class="is-positive">+${fmtINR(goal.thisMonthFunded)} this month</span>`
              : `<span>${fmtINR(goal.remaining)} remaining</span>`
          }
        </div>
      </a>
    `).join('');

    return `<div class="dashboard-goal-list">${rows}</div>`;
  });

  const hiddenCount = Math.max(0, goals.length - shownCount);

  return `
    <div class="dashboard-goal-summary">
      <span>${snapshot.activeCount} active goal${snapshot.activeCount === 1 ? '' : 's'}</span>
      <strong>${fmtINR(snapshot.totalRemaining)} remaining</strong>
    </div>

    ${renderDashboardPager(pageHtml, 'Goal progress')}

    ${
      hiddenCount
        ? `<a class="dashboard-secondary-more" href="/budget">View ${hiddenCount} more <span aria-hidden="true">→</span></a>`
        : ''
    }
  `;
}

export function renderDashboardPeopleBalances(snapshot, perPage = 2, maxPages = 3) {
  const owedToYou = Array.isArray(snapshot?.owedToYouByPerson)
    ? snapshot.owedToYouByPerson
    : [];

  const owedByYou = Array.isArray(snapshot?.owedByYouByPerson)
    ? snapshot.owedByYouByPerson
    : [];

  if (!owedToYou.length && !owedByYou.length) {
    return `
      <div class="dashboard-people-empty">
        <strong>All settled up.</strong>
        <span>Unsettled Split Money shares and Month lending will appear here.</span>
      </div>
    `;
  }

  /*
   * Merge both directions into one record per person.
   * A person can theoretically both owe you and be owed by you,
   * so keep the two values separate instead of netting them.
   */
  const peopleMap = new Map();

  const getPersonRecord = person => {
    const label = String(person || 'Unknown').trim() || 'Unknown';
    const key = label.toLocaleLowerCase('en-IN');

    if (!peopleMap.has(key)) {
      peopleMap.set(key, {
        person: label,
        owesYou: 0,
        youOwe: 0,
      });
    }

    return peopleMap.get(key);
  };

  owedToYou.forEach(item => {
    const amount = Number(item.amount) || 0;
    if (amount <= 0) return;

    getPersonRecord(item.person).owesYou += amount;
  });

  owedByYou.forEach(item => {
    const amount = Number(item.amount) || 0;
    if (amount <= 0) return;

    getPersonRecord(item.person).youOwe += amount;
  });

  const people = [...peopleMap.values()]
    .filter(person => person.owesYou > 0 || person.youOwe > 0)
    .sort((a, b) => {
      const aTotal = a.owesYou + a.youOwe;
      const bTotal = b.owesYou + b.youOwe;

      return (
        bTotal - aTotal ||
        a.person.localeCompare(b.person)
      );
    });

  const { pages, shownCount } = dashboardPageSlices(
    people,
    perPage,
    maxPages,
  );

  const pageHtml = pages.map(pagePeople => `
    <div class="dashboard-people-page">
      ${pagePeople.map(person => `
        <div class="dashboard-people-side">
          <div
            class="dashboard-person-name"
            title="${escapeHtml(person.person)}"
          >
            ${escapeHtml(person.person)}
          </div>

          <div class="dashboard-person-balances">
            ${
              person.owesYou > 0
                ? `
                  <div class="dashboard-person-balance is-owed">
                    <span>Owes you</span>
                    <strong>${fmtINR(person.owesYou)}</strong>
                  </div>
                `
                : ''
            }

            ${
              person.youOwe > 0
                ? `
                  <div class="dashboard-person-balance is-owe">
                    <span>You owe</span>
                    <strong>${fmtINR(person.youOwe)}</strong>
                  </div>
                `
                : ''
            }
          </div>
        </div>
      `).join('')}
    </div>
  `);

  const hiddenCount = Math.max(0, people.length - shownCount);

  return `
    <div class="dashboard-people-summary">
      ${
        Number(snapshot?.owedToYou) > 0
          ? `
            <div class="is-owed">
              <span>Owed to you</span>
              <strong>${fmtINR(snapshot.owedToYou)}</strong>
            </div>
          `
          : ''
      }

      ${
        Number(snapshot?.owedByYou) > 0
          ? `
            <div class="is-owe">
              <span>You owe</span>
              <strong>${fmtINR(snapshot.owedByYou)}</strong>
            </div>
          `
          : ''
      }
    </div>

    ${renderDashboardPager(pageHtml, 'People balances')}

    <div class="dashboard-people-note">
      ${
        hiddenCount
          ? `${hiddenCount} more ${hiddenCount === 1 ? 'person' : 'people'} beyond the dashboard preview.`
          : 'Includes Split Money and unsettled Month lending.'
      }
    </div>
  `;
}

export function renderDashboardSharedExpenses(snapshot, perPage = 4, maxPages = 3) {
  const activity = snapshot?.activity || [];

  if (!snapshot?.groupCount && !snapshot?.lentCount) {
    return `<div class="dashboard-secondary-empty"><strong>No shared expenses yet.</strong><span>Split-group activity and amounts lent from Month transactions will appear here.</span><a href="/split">Create split <span aria-hidden="true">→</span></a></div>`;
  }

  const net = Number(snapshot.netPosition) || 0;
  const netLabel = net > 0 ? 'Owed to you' : net < 0 ? 'You owe' : 'Settled up';
  const netValue = Math.abs(net);

  const { pages, shownCount } = dashboardPageSlices(activity, perPage, maxPages);

  const pageHtml = pages.map(pageItems => {
    const rows = pageItems.map(item => {
      if (item.source === 'lent' || item.source === 'owed') {
        const status = item.settled ? 'Paid back' : `Lent to ${item.person}`;

        const href = item.monthKey && item.entryId
          ? `/month/${item.monthKey}?entry=${encodeURIComponent(item.entryId)}`
          : (item.monthKey ? `/month/${item.monthKey}?focus=lent` : '/months');

        return `
          <a
            class="dashboard-shared-row is-lent ${item.settled ? 'is-settled' : ''}"
            href="${href}"
          >
            <span class="dashboard-shared-icon" aria-hidden="true">₹</span>

            <span class="dashboard-shared-copy">
              <strong>${escapeHtml(item.description)}</strong>
              <small>${escapeHtml(status)} · Month transaction</small>
            </span>

            <span class="dashboard-shared-value">
              <strong>${fmtINR(item.amount)}</strong>
              <small>${formatDashboardDate(item.date)}</small>
            </span>
          </a>
        `;
      }

      const context = item.paidByYou
        ? `You paid · your share ${fmtINR(item.yourShare)}`
        : `Paid by ${item.payee} · your share ${fmtINR(item.yourShare)}`;

      return `
        <a
          class="dashboard-shared-row"
          href="/split?group=${encodeURIComponent(item.groupId)}&spend=${encodeURIComponent(item.id.replace(/^split-/, ''))}"
        >
          <span class="dashboard-shared-icon" aria-hidden="true">↔</span>

          <span class="dashboard-shared-copy">
            <strong>${escapeHtml(item.description)}</strong>
            <small>${escapeHtml(item.groupName)} · ${escapeHtml(context)}</small>
          </span>

          <span class="dashboard-shared-value">
            <strong>${fmtINR(item.amount)}</strong>
            <small>${formatDashboardDate(item.date)}</small>
          </span>
        </a>
      `;
    }).join('');

    return `<div class="dashboard-shared-list">${rows}</div>`;
  });

  const hiddenCount = Math.max(0, activity.length - shownCount);

  return `
    <div class="dashboard-shared-summary ${net < 0 ? 'is-owe' : net > 0 ? 'is-owed' : ''}">
      <span>${netLabel}</span>
      <strong>${net === 0 ? '₹0.00' : fmtINR(netValue)}</strong>
    </div>

    ${
      pageHtml.length
        ? renderDashboardPager(pageHtml, 'Shared expense activity')
        : '<div class="dashboard-secondary-mini-empty">No shared-money activity logged yet.</div>'
    }

    ${
      hiddenCount
        ? `<a class="dashboard-secondary-more" href="/split">View ${hiddenCount} older item${hiddenCount === 1 ? '' : 's'} <span aria-hidden="true">→</span></a>`
        : ''
    }
  `;
}

export function renderDashboardSipInvestments(snapshot) {
  const basePortfolio = Number(snapshot?.basePortfolio) || 0;
  const sipInvested = Number(snapshot?.sipInvested) || 0;
  const portfolioTotal = basePortfolio + sipInvested;

  const monthEndSip = Number(snapshot?.currentMonthScheduled) || 0;
  const remainingThisMonth = Number(snapshot?.currentMonthRemaining) || 0;

  return `
    <div class="dashboard-sip-investment">
      <div class="dashboard-sip-hero">
        <span>Portfolio + SIP investments</span>
        <strong>${fmtINR(portfolioTotal)}</strong>
        <small>
          Base ${fmtINR(basePortfolio)}
          <span aria-hidden="true">+</span>
          SIPs ${fmtINR(sipInvested)}
        </small>
      </div>

      <div class="dashboard-sip-month">
        <div>
          <span>By month-end</span>
          <strong>${fmtINR(monthEndSip)}</strong>
        </div>

        <div>
          <span>Still to invest</span>
          <strong>${fmtINR(remainingThisMonth)}</strong>
        </div>
      </div>
    </div>
  `;
}


export function renderDashboardPrices(snapshot, perPage = 4, maxPages = 3) {
  const items = snapshot?.items || [];

  if (!snapshot?.trackedCount) {
    return `<div class="dashboard-secondary-empty"><strong>No prices tracked yet.</strong><span>Track recurring purchases or services to spot meaningful price changes.</span><a href="/pricetrack">Track an item <span aria-hidden="true">→</span></a></div>`;
  }

  if (!items.length) {
    return `<div class="dashboard-secondary-empty"><strong>${snapshot.trackedCount} item${snapshot.trackedCount === 1 ? '' : 's'} ready to track.</strong><span>Log a price to start seeing movements here.</span><a href="/pricetrack">Log prices <span aria-hidden="true">→</span></a></div>`;
  }

  const { pages, shownCount } = dashboardPageSlices(items, perPage, maxPages);

  const pageHtml = pages.map(pageItems => {
    const rows = pageItems.map(item => {
      let movement = '<span class="dashboard-price-flat">No comparison</span>';

      if (item.changePct !== null) {
        const cls =
          item.changePct > 0
            ? 'is-up'
            : item.changePct < 0
              ? 'is-down'
              : 'is-flat';

        const arrow =
          item.changePct > 0
            ? '↑'
            : item.changePct < 0
              ? '↓'
              : '→';

        movement = `
          <span class="dashboard-price-change ${cls}">
            ${arrow} ${Math.abs(item.changePct).toFixed(1)}%
          </span>
        `;
      }

      return `
        <a
          class="dashboard-price-row"
          href="/pricetrack?item=${encodeURIComponent(item.id)}"
        >
          <span class="dashboard-price-copy">
            <strong>${escapeHtml(item.name)}</strong>
            <small>${escapeHtml(priceMeta(item))}</small>
          </span>

          <span class="dashboard-price-value">
            <strong>${fmtINR(item.latestPrice)}</strong>
            ${movement}
          </span>
        </a>
      `;
    }).join('');

    return `
      <div class="dashboard-price-list">
        ${rows}
      </div>
    `;
  });

  const hiddenCount = Math.max(0, items.length - shownCount);

  return `
    <div class="dashboard-price-summary">
      <span>${snapshot.trackedCount} tracked</span>
      <strong>${snapshot.movedCount} with movement</strong>
    </div>

    ${renderDashboardPager(pageHtml, 'Tracked prices')}

    ${
      hiddenCount
        ? `<a class="dashboard-secondary-more" href="/pricetrack">View ${hiddenCount} more <span aria-hidden="true">→</span></a>`
        : ''
    }
  `;
}
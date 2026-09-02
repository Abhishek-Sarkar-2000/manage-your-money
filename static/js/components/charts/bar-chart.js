/* ---------- Simple bar charts (self-contained, no libraries) ---------- */
import { escapeHtml } from '../../core/dom.js';
import { fmtINR, fmtINRShort } from '../../core/format.js';

export function barChart(pairs) {
  // A pair can either be a flat { label, value, color } bar, or a stacked
  // one via { label, segments: [{ label, value, color }, ...] } — segments
  // render bottom-up in array order and carry data-val/data-label so the
  // shared tooltip (wireChartTooltips) picks them up automatically.
  const totalOf = (p) => (p.segments ? p.segments.reduce((s, seg) => s + (seg.value || 0), 0) : (p.value || 0));
  const max = Math.max(1, ...pairs.map(totalOf));
  const cols = pairs.map(p => {
    const total = totalOf(p);
    if (p.segments) {
      const segmentsHtml = p.segments.filter(seg => seg.value > 0).map(seg => `
        <div class="stacked-segment" data-val="${fmtINR(seg.value)}" data-label="${escapeHtml(seg.label)}" style="height:${total > 0 ? (seg.value / total * 100) : 0}%; background:${seg.color};"></div>`).join('');
      return `
      <div class="bar-col">
        <div class="bval num">${fmtINR(total)}</div>
        <div class="bar stacked-bar" style="height:${Math.max(4, (total / max * 130))}px;">
          ${segmentsHtml}
        </div>
        <div class="blabel">${p.label}</div>
      </div>`;
    }
    return `
    <div class="bar-col">
      <div class="bval num">${fmtINR(p.value)}</div>
      <div class="bar" style="height:${Math.max(4, (p.value / max * 130))}px; background:${p.color};"></div>
      <div class="blabel">${p.label}</div>
    </div>`;
  }).join('');
  return `<div class="bars">${cols}</div>`;
}

export function tagsBarChart(entries, targetType, options = {}) {
  const { splitAdjustment = 0, splitTagName = 'Split' } = options;
  const personalTotals = {};
  const lentTotals = {};
  const settledLentTotals = {};
  const displayLabels = {};
  for (const e of entries) {
    if (e.type !== targetType) continue;
    const rawTag = (e.tag && String(e.tag).trim()) ? e.tag : 'Untagged';
    // Group case-insensitively — "split" and "Split" (e.g. a manually
    // tagged spend vs. the Split page's tag) should land in the same
    // bar, not fork into two differently-colored ones.
    const key = rawTag.toLowerCase();
    if (!displayLabels[key]) displayLabels[key] = rawTag;
    const amount = Number(e.amount) || 0;
    const lentArr = Array.isArray(e.lent) ? e.lent : [];
    const settledLent = lentArr.reduce((s, l) => l.settled ? s + (Number(l.amount) || 0) : s, 0);
    const unsettledLent = lentArr.reduce((s, l) => !l.settled ? s + (Number(l.amount) || 0) : s, 0);
    if (targetType === 'cardcharge') {
      // Credit-card dues track settled lent as its own segment instead of
      // folding it back into personal — the money's already been repaid
      // to you, but the card bill still needs the full amount paid off,
      // so it stays visible rather than vanishing into "personal".
      const personal = amount - unsettledLent - settledLent;
      personalTotals[key] = (personalTotals[key] || 0) + personal;
      settledLentTotals[key] = (settledLentTotals[key] || 0) + settledLent;
    } else {
      // Settled lent is paid back — it's fully deducted and never appears
      // here again. Unsettled lent is kept as its own segment so the bar
      // shows exactly how much of this tag's spend is still outstanding.
      const personal = amount - unsettledLent;
      personalTotals[key] = (personalTotals[key] || 0) + personal;
    }
    lentTotals[key] = (lentTotals[key] || 0) + unsettledLent;
  }

  // The Split page's "owed to you" balance is money already counted inside
  // this tag's spend, not a fresh spend on top of it — so it's carved OUT
  // of that tag's personal total (capped so it can't go negative / inflate
  // the tag's total) and moved into its lent segment instead.
  if (splitAdjustment > 0) {
    const key = splitTagName.toLowerCase();
    if (!displayLabels[key]) displayLabels[key] = splitTagName;
    const existingPersonal = personalTotals[key] || 0;
    const carve = Math.min(splitAdjustment, existingPersonal);
    personalTotals[key] = existingPersonal - carve;
    lentTotals[key] = (lentTotals[key] || 0) + splitAdjustment;
  }

  const keys = Object.keys(personalTotals).filter(k => (personalTotals[k] || 0) + (lentTotals[k] || 0) + (settledLentTotals[k] || 0) > 0);
  const pairs = keys
    .map(key => ({
      label: displayLabels[key],
      personal: personalTotals[key] || 0,
      lent: lentTotals[key] || 0,
      settledLent: settledLentTotals[key] || 0,
      value: (personalTotals[key] || 0) + (lentTotals[key] || 0) + (settledLentTotals[key] || 0),
    }))
    .sort((a, b) => b.value - a.value);
  if (!pairs.length) return { html: `<div class="empty-chart">No tagged spends yet.</div>`, count: 0 };

  const max = Math.max(1, ...pairs.map(p => p.value));
  const colors = ['var(--blue)', '#C98A3C', '#8E6FB0', 'var(--debit)', 'var(--credit)', '#5B4B9E', 'var(--amber)', 'var(--blue-soft)', '#2E7D6B', '#AD4358'];
  const cols = pairs.map((p, i) => {
    const color = colors[i % colors.length];
    const segments = [];
    // Bottom segment: personal spend for this tag.
    if (p.personal > 0) segments.push(`<div class="stacked-segment" data-val="${fmtINR(p.personal)}" data-label="${escapeHtml(p.label)} · Personal" style="height:${(p.personal / p.value * 100)}%; background:${color};"></div>`);
    // Middle segment: settled lent for credit cards — already repaid to
    // you, but still tracked distinctly from personal spend.
    if (p.settledLent > 0) segments.push(`<div class="stacked-segment" data-val="${fmtINR(p.settledLent)}" data-label="${escapeHtml(p.label)} · Settled Lent" style="height:${(p.settledLent / p.value * 100)}%; background:var(--credit);"></div>`);
    // Top segment: still-unsettled lent for this tag.
    if (p.lent > 0) segments.push(`<div class="stacked-segment" data-val="${fmtINR(p.lent)}" data-label="${escapeHtml(p.label)} · Lent" style="height:${(p.lent / p.value * 100)}%; background:#E03131;"></div>`);
    return `
    <div class="tag-bar-col">
      <div class="bval num">${fmtINRShort(p.value)}</div>
      <div class="tag-bar stacked-bar" style="height:${Math.max(4, (p.value / max * 140))}px;" title="${escapeHtml(p.label)}">
        ${segments.join('')}
      </div>
    </div>`;
  }).join('');

  let legend = pairs.map((p, i) => `
    <div class="shared-chart-legend-item">
      <span class="shared-chart-legend-dot" style="background:${colors[i % colors.length]};"></span>
      <span>${escapeHtml(p.label)}</span>
    </div>`).join('');

  if (pairs.some(p => p.settledLent > 0)) {
    legend += `
    <div class="shared-chart-legend-item">
      <span class="shared-chart-legend-dot" style="background:var(--credit);"></span>
      <span>Settled Lent</span>
    </div>`;
  }

  if (pairs.some(p => p.lent > 0)) {
    legend += `
    <div class="shared-chart-legend-item">
      <span class="shared-chart-legend-dot" style="background:#E03131;"></span>
      <span>Lent (unsettled)</span>
    </div>`;
  }

  return {
    html: `
      <div class="tag-bars">${cols}</div>
      <div class="shared-chart-legend">${legend}</div>
    `,
    count: pairs.length,
  };
}

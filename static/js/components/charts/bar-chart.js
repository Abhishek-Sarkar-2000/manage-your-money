/* ---------- Simple bar charts (self-contained, no libraries) ---------- */
import { escapeHtml } from '../../core/dom.js';
import { fmtINR, fmtINRShort } from '../../core/format.js';

export function barChart(pairs) {
  const max = Math.max(1, ...pairs.map(p => p.value));
  const cols = pairs.map(p => `
    <div class="bar-col">
      <div class="bval num">${fmtINR(p.value)}</div>
      <div class="bar" style="height:${Math.max(4, (p.value / max * 130))}px; background:${p.color};"></div>
      <div class="blabel">${p.label}</div>
    </div>`).join('');
  return `<div class="bars">${cols}</div>`;
}

export function tagsBarChart(entries, targetType) {
  const totals = {};
  for (const e of entries) {
    if (e.type === targetType) {
      const tag = (e.tag && String(e.tag).trim()) ? e.tag : 'Untagged';
      totals[tag] = (totals[tag] || 0) + (Number(e.amount) || 0);
    }
  }

  const pairs = Object.entries(totals).map(([label, value]) => ({ label, value })).filter(p => p.value > 0).sort((a, b) => b.value - a.value);
  if (!pairs.length) return `<div class="empty-chart">No tagged spends yet.</div>`;

  const max = Math.max(1, ...pairs.map(p => p.value));
  const colors = ['var(--blue)', '#C98A3C', '#8E6FB0', 'var(--debit)', 'var(--credit)', '#5B4B9E', 'var(--amber)', 'var(--blue-soft)', '#2E7D6B', '#AD4358'];
  const cols = pairs.map((p, i) => `
    <div class="tag-bar-col">
      <div class="bval num">${fmtINRShort(p.value)}</div>
      <div class="tag-bar" style="height:${Math.max(4, (p.value / max * 140))}px; background:${colors[i % colors.length]};"></div>
      <div class="blabel" title="${escapeHtml(p.label)}">${escapeHtml(p.label)}</div>
    </div>`).join('');
  return `<div class="tag-bars">${cols}</div>`;
}

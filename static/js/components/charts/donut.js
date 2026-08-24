/* ---------- Donut chart (self-contained, no libraries) ---------- */
import { fmtINR } from '../../core/format.js';

export function donutChart(segments) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return `<div class="empty-chart">No spending recorded yet this month.</div>`;
  let acc = 0;
  const stops = segments.filter(s => s.value > 0).map(s => {
    const start = acc / total * 360; acc += s.value; const end = acc / total * 360;
    return `${s.color} ${start}deg ${end}deg`;
  }).join(', ');
  const legend = segments.filter(s => s.value > 0).map(s => `
    <div class="legend-item">
      <span class="legend-dot" style="background:${s.color}"></span>
      <span>${s.label}</span>
      <span class="legend-val">${fmtINR(s.value)}</span>
    </div>`).join('');
  return `
  <div class="donut-wrap">
    <div class="donut" style="background:conic-gradient(${stops});">
      <div class="donut-center"><div class="t">Total</div><div class="v">${fmtINR(total)}</div></div>
    </div>
    <div class="legend">${legend}</div>
  </div>`;
}

/* Split Money's donut is the same chart with an empty-state message override. */
export function splitDonut(segments, emptyMsg) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return `<div class="empty-chart">${emptyMsg}</div>`;
  return donutChart(segments);
}

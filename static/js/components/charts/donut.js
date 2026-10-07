/* ---------- Donut chart (self-contained, no libraries) ---------- */
import { fmtINR } from '../../core/format.js';

let donutStripePatternSeed = 0;

function allocateSeparatedDonutAngles(segments, availableAngle, minSectorAngle) {
  const angles = new Array(segments.length).fill(0);
  if (!segments.length || availableAngle <= 0) return angles;

  const floorAngle = Math.min(Math.max(0, Number(minSectorAngle) || 0), availableAngle / segments.length);
  let remainingIndexes = segments.map((_, index) => index);
  let remainingAngle = availableAngle;
  let remainingValue = segments.reduce((sum, segment) => sum + segment.value, 0);

  while (remainingIndexes.length) {
    const undersized = remainingIndexes.filter(index => remainingValue > 0 && (segments[index].value / remainingValue) * remainingAngle < floorAngle);

    if (!undersized.length) {
      remainingIndexes.forEach(index => {
        angles[index] = remainingValue > 0 ? (segments[index].value / remainingValue) * remainingAngle : remainingAngle / remainingIndexes.length;
      });
      break;
    }

    if (undersized.length === remainingIndexes.length) {
      const equalAngle = remainingAngle / remainingIndexes.length;
      remainingIndexes.forEach(index => { angles[index] = equalAngle; });
      break;
    }

    const undersizedSet = new Set(undersized);
    undersized.forEach(index => { angles[index] = floorAngle; });
    remainingAngle = Math.max(0, remainingAngle - floorAngle * undersized.length);
    remainingValue -= undersized.reduce((sum, index) => sum + segments[index].value, 0);
    remainingIndexes = remainingIndexes.filter(index => !undersizedSet.has(index));
  }

  return angles;
}

export function donutChart(segments, { separated = true, minSectorAngle = 1, gapAngle = 11 } = {}) {
  const total = segments.reduce((sum, segment) => sum + (Number(segment.value) || 0), 0);
  if (total <= 0) return `<div class="empty-chart">No spending recorded yet this month.</div>`;

  const filtered = segments.filter(segment => (Number(segment.value) || 0) > 0).map(segment => ({ ...segment, value: Number(segment.value) || 0 }));

  const hasDetailedLegend = filtered.some(segment => segment.icon);

  const legend = filtered.map(segment => {
    if (!hasDetailedLegend) {
      return `
        <div class="legend-item">
          <span class="legend-dot" style="background:${segment.color}"></span>
          <span>${segment.label}</span>
          <span class="legend-val">${fmtINR(segment.value)}</span>
        </div>
      `;
    }

    const percentage = total > 0 ? (segment.value / total) * 100 : 0;

    return `
      <div class="legend-item legend-item-detailed">
        <span class="legend-dot" style="background:${segment.color}"></span>
        <span class="legend-icon" style="--legend-color:${segment.color};" aria-hidden="true">${segment.icon || ''}</span>
        <span class="legend-label">${segment.label}<small> - ${percentage.toFixed(1).replace(/\.0$/, '')}%</small></span>
        <span class="legend-metrics">
          <strong>${fmtINR(segment.value)}</strong>
        </span>
      </div>
    `;
  }).join('');

  if (separated) {
    const effectiveGap = filtered.length > 1 ? Math.min(Math.max(0, Number(gapAngle) || 0), Math.max(0, (360 / filtered.length) - 1)) : 0;
    const availableAngle = 360 - (effectiveGap * filtered.length);
    const angles = allocateSeparatedDonutAngles(filtered, availableAngle, minSectorAngle);
    const stripePatternId = `donut-stripes-${++donutStripePatternSeed}`;
    let cursor = 0;

    const arcs = filtered.map((segment, index) => {
      const sectorAngle = angles[index];
      const dashOffset = -cursor;
      cursor += sectorAngle + effectiveGap;

      return `
        <circle class="donut-segment-outline" cx="80" cy="80" r="61" pathLength="360" fill="none" stroke-dasharray="${sectorAngle} ${360 - sectorAngle}" stroke-dashoffset="${dashOffset}" aria-hidden="true"></circle>
        <circle class="donut-segment" cx="80" cy="80" r="61" pathLength="360" fill="none" stroke="${segment.color}" stroke-dasharray="${sectorAngle} ${360 - sectorAngle}" stroke-dashoffset="${dashOffset}"><title>${segment.label}: ${fmtINR(segment.value)}</title></circle>
        <circle class="donut-segment donut-segment-stripes" cx="80" cy="80" r="61" pathLength="360" fill="none" stroke="url(#${stripePatternId})" stroke-dasharray="${sectorAngle} ${360 - sectorAngle}" stroke-dashoffset="${dashOffset}" aria-hidden="true"></circle>
      `;
    }).join('');

    return `
    <div class="donut-wrap${hasDetailedLegend ? ' has-detailed-legend' : ''}">
      <div class="donut is-separated">
        <svg class="donut-svg" viewBox="0 0 160 160" role="img" aria-label="Spending breakdown">
          <defs>
            <pattern id="${stripePatternId}" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
              <rect class="donut-stripe-mark" x="0" y="0" width="5" height="10"></rect>
            </pattern>
          </defs>
          <g transform="rotate(-90 80 80)">
            ${arcs}
          </g>
        </svg>
        <div class="donut-center"><div class="v">${fmtINR(total)}</div><div class="t">Total</div></div>
      </div>
      <div class="legend${hasDetailedLegend ? ' is-detailed' : ''}">${legend}</div>
    </div>`;
  }

  let acc = 0;
  const stops = filtered.map((segment, index, arr) => {
    const start = acc / total * 360;
    acc += segment.value;
    const end = acc / total * 360;

    if (arr.length === 1) return `${segment.color} ${start}deg ${end}deg`;

    return `${segment.color} ${start}deg calc(${end}deg - var(--donut-gap-w, 0deg)), var(--donut-border, transparent) calc(${end}deg - var(--donut-gap-w, 0deg)) ${end}deg`;
  }).join(', ');

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

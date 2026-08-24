/* ---------- Shared axis/tick helpers for SVG + bar charts ---------- */

export function yAxisGrid(minV, maxV, w, h, padL, padR, padT, padB, count) {
  count = count || 4;
  const range = (maxV - minV) || 1;

  const maxAbs = Math.max(Math.abs(maxV), Math.abs(minV));
  let div = 1, suf = '';
  if (maxAbs >= 1e7) { div = 1e7; suf = 'Cr'; }
  else if (maxAbs >= 1e5) { div = 1e5; suf = 'L'; }
  else if (maxAbs >= 1e3) { div = 1e3; suf = 'K'; }

  let out = '';
  for (let i = 0; i <= count; i++) {
    const v = minV + (range * i / count);
    const y = h - padB - ((v - minV) / range) * (h - padT - padB);

    let cls = '';
    if (count === 8) {
      if (i % 2 !== 0) cls = 'y-tick-dense';
      else if (i % 4 !== 0) cls = 'y-tick-med';
    }

    const scaledV = v / div;
    const formattedNum = Math.abs(parseFloat(scaledV.toFixed(2)));
    const sign = (v < 0 && formattedNum !== 0) ? '-' : '';
    const textStr = `${sign}₹${formattedNum}${suf}`;

    out += `<g class="${cls}">`;
    out += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="var(--hair)" stroke-width="1" stroke-dasharray="3,4"/>`;
    out += `<text x="${(padL - 8).toFixed(1)}" y="${(y + 4).toFixed(1)}" fill="var(--muted)" text-anchor="end" font-family="IBM Plex Mono, monospace">${textStr}</text>`;
    out += `</g>`;
  }
  return out;
}

export function formatChartMoney(value) {
  const amount = Number(value) || 0;
  const abs = Math.abs(amount);
  let formatted;
  if (abs >= 10000000) formatted = (amount / 10000000).toFixed(2) + 'Cr';
  else if (abs >= 100000) formatted = (amount / 100000).toFixed(2) + 'L';
  else if (abs >= 1000) formatted = (amount / 1000).toFixed(2) + 'K';
  else formatted = Math.round(amount).toString();

  formatted = formatted
    .replace(/(\.\d*?[1-9])0+(?=[A-Za-z]|$)/, '$1')
    .replace(/\.0+(?=[A-Za-z]|$)/, '');

  return `₹${formatted}`;
}

export function niceChartStep(maxValue, tickCount = 5) {
  if (!maxValue || maxValue <= 0) return 1;
  const rawStep = maxValue / tickCount;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  let niceNormalized;
  if (normalized <= 1) niceNormalized = 1;
  else if (normalized <= 2) niceNormalized = 2;
  else if (normalized <= 2.5) niceNormalized = 2.5;
  else if (normalized <= 5) niceNormalized = 5;
  else niceNormalized = 10;
  return niceNormalized * magnitude;
}

export function buildNiceChartTicks(maxValue, tickCount = 5) {
  const step = niceChartStep(maxValue, tickCount);
  const niceMax = Math.ceil(maxValue / step) * step;
  const ticks = [];
  for (let value = 0; value <= niceMax + step * 0.001; value += step) {
    ticks.push(Math.round(value * 100) / 100);
  }
  return { ticks, max: niceMax };
}

/* ---------- SVG line charts (self-contained, no libraries) ---------- */
import { fmtINR } from '../../core/format.js';
import { yAxisGrid } from './axis-grid.js';

/* Home page: long-range daily balance trend, with 1/3/6-month tick spacing. */
export function dailyBalanceChart(series, rangeMonths) {
  if (!series.length) return `<div class="empty-chart">Add a month to see your balance trend here.</div>`;
  const w = 900, h = 220, padL = 85, padR = 20, padT = 16, padB = 34;
  const vals = series.map(p => p.balance);
  const rawMin = Math.min(...vals), rawMax = Math.max(...vals);
  const span = (rawMax - rawMin) || Math.max(Math.abs(rawMax) * 0.1, 1000);
  const pad = span * 0.18;
  const minV = rawMin - pad, maxV = rawMax + pad;
  const range = (maxV - minV) || 1;
  const stepX = series.length > 1 ? (w - padL - padR) / (series.length - 1) : 0;
  const coords = series.map((p, i) => {
    const x = series.length > 1 ? padL + i * stepX : (padL + w - padR) / 2;
    const y = h - padB - ((p.balance - minV) / range) * (h - padT - padB);
    return [x, y];
  });
  const pathD = coords.map((c, i) => (i === 0 ? 'M' : 'L') + c[0].toFixed(1) + ',' + c[1].toFixed(1)).join(' ');
  const areaD = pathD + ` L${coords[coords.length - 1][0].toFixed(1)},${h - padB} L${coords[0][0].toFixed(1)},${h - padB} Z`;
  const gridSvg = yAxisGrid(minV, maxV, w, h, padL, padR, padT, padB, 8);

  let tickIdxs = [];
  if (rangeMonths === 1) {
    for (let i = 0; i < series.length; i += 7) tickIdxs.push(i);
  } else {
    let lastMonth = null;
    series.forEach((p, i) => { const mk = p.date.slice(0, 7); if (mk !== lastMonth) { tickIdxs.push(i); lastMonth = mk; } });
  }
  const tickLabel = (p) => {
    const d = new Date(p.date + 'T00:00:00');
    return rangeMonths === 1
      ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
      : d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
  };
  const dots = coords.map(([x, y], i) => `<circle class="linechart-dot" data-val="${fmtINR(series[i].balance)}" data-label="${series[i].date}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="var(--blue)" opacity="${tickIdxs.includes(i) ? 1 : 0}" stroke="transparent" stroke-width="8" style="cursor:pointer;"></circle>`).join('');
  const labels = tickIdxs.map(i => {
    const [x] = coords[i];
    return `<text x="${x.toFixed(1)}" y="${h - 6}" fill="var(--muted)" text-anchor="right" font-family="IBM Plex Mono, monospace">${tickLabel(series[i])}</text>`;
  }).join('');
  const lastPoint = series[series.length - 1];
  return `
  <svg class="linechart" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="ofade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--blue)" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="var(--blue)" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${gridSvg}
    <path d="${areaD}" fill="url(#ofade)" stroke="none"/>
    <path d="${pathD}" fill="none" stroke="var(--blue)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    ${labels}
  </svg>
  <div class="subnote">Latest balance (${lastPoint.date}): <strong class="num">${fmtINR(lastPoint.balance)}</strong></div>`;
}

/* Month page: running balance across just that month's entries + recurring rows. */
export function lineChart(startingBalance, data, recurringRows) {
  const entries = [...data.entries, ...recurringRows]
    .filter(e => e.type === 'income' || e.type === 'investment' || e.type === 'emi' || e.type === 'sip' || (e.type === 'spend' && e.paymentMode !== 'card') || (e.type === 'spend' && e.paymentMode === 'card'))
    .filter(e => e.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  const start = Number(startingBalance) || 0;
  if (entries.length === 0) {
    return `<div class="empty-chart">Balance line will appear once you add entries with dates.</div>`;
  }
  let running = start;
  const points = [{ date: 'start', balance: running }];
  for (const e of entries) {
    const amt = Number(e.amount) || 0;
    if (e.type === 'income') running += amt; else running -= amt;
    points.push({ date: e.date, balance: running });
  }
  const w = 900, h = 170, padL = 85, padR = 20, padT = 16, padB = 30;
  const vals = points.map(p => p.balance);
  const minV = Math.min(...vals, start), maxV = Math.max(...vals, start);
  const range = (maxV - minV) || 1;
  const stepX = (w - padL - padR) / Math.max(1, (points.length - 1));
  const coords = points.map((p, i) => {
    const x = padL + i * stepX;
    const y = h - padB - ((p.balance - minV) / range) * (h - padT - padB);
    return [x, y];
  });
  const pathD = coords.map((c, i) => (i === 0 ? 'M' : 'L') + c[0].toFixed(1) + ',' + c[1].toFixed(1)).join(' ');
  const areaD = pathD + ` L${coords[coords.length - 1][0].toFixed(1)},${h - padB} L${coords[0][0].toFixed(1)},${h - padB} Z`;
  const gridSvg = yAxisGrid(minV, maxV, w, h, padL, padR, padT, padB, 8);
  const lastVal = points[points.length - 1].balance;
  const dots = coords.map(([x, y], i) => {
    const label = points[i].date === 'start' ? 'Start' : points[i].date;
    return `<circle class="linechart-dot" data-val="${fmtINR(points[i].balance)}" data-label="${label}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="var(--blue)" stroke="transparent" stroke-width="8" style="cursor:pointer;"></circle>`;
  }).join('');
  return `
  <svg class="linechart" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="lineFade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--blue)" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="var(--blue)" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${gridSvg}
    <path d="${areaD}" fill="url(#lineFade)" stroke="none"/>
    <path d="${pathD}" fill="none" stroke="var(--blue)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
  </svg>
  <div class="subnote">Latest balance: <strong class="num">${fmtINR(lastVal)}</strong></div>
  `;
}

/* Price Tracker: per-item price-history trend line. */
export function priceLineChart(hist) {
  if (!hist.length) {
    return `<div class="empty-chart">Log a price to see the trend line.</div>`;
  }
  if (hist.length === 1) {
    return `<div class="empty-chart">Log one more price to see a trend line. Latest: <strong>${fmtINR(hist[0].price)}</strong></div>`;
  }
  const w = 900, h = 170, padL = 85, padR = 20, padT = 16, padB = 30;
  const vals = hist.map(p => p.price);
  const minV = Math.min(...vals), maxV = Math.max(...vals);
  const range = (maxV - minV) || 1;
  const stepX = (w - padL - padR) / Math.max(1, (hist.length - 1));
  const coords = hist.map((p, i) => {
    const x = padL + i * stepX;
    const y = h - padB - ((p.price - minV) / range) * (h - padT - padB);
    return [x, y];
  });
  const pathD = coords.map((c, i) => (i === 0 ? 'M' : 'L') + c[0].toFixed(1) + ',' + c[1].toFixed(1)).join(' ');
  const areaD = pathD + ` L${coords[coords.length - 1][0].toFixed(1)},${h - padB} L${coords[0][0].toFixed(1)},${h - padB} Z`;
  const gridSvg = yAxisGrid(minV, maxV, w, h, padL, padR, padT, padB, 4);
  const dots = coords.map(([x, y], i) => {
    const dl = new Date(hist[i].date + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    return `<circle class="linechart-dot" data-val="${fmtINR(hist[i].price)}" data-label="${dl}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="var(--blue)" stroke="transparent" stroke-width="8" style="cursor:pointer;"></circle>`;
  }).join('');
  const lastVal = hist[hist.length - 1].price;
  return `
  <svg class="linechart" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="priceLineFade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--blue)" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="var(--blue)" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${gridSvg}
    <path d="${areaD}" fill="url(#priceLineFade)" stroke="none"/>
    <path d="${pathD}" fill="none" stroke="var(--blue)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
  </svg>
  <div class="subnote">Latest price: <strong class="num">${fmtINR(lastVal)}</strong></div>
  `;
}

let tooltipEl = null;

export function wireChartTooltips(root = document) {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'chart-tooltip';
    document.body.appendChild(tooltipEl);
  }

  const showTooltip = (ev) => {
    const dot = ev.target.closest('.linechart-dot, .stacked-segment');
    if (!dot) return;
    
    const val = dot.dataset.val;
    const label = dot.dataset.label || '';
    
    tooltipEl.innerHTML = `<div class="ct-val">${val}</div>${label ? `<div class="ct-label">${label}</div>` : ''}`;
    tooltipEl.classList.add('show');
    
    const rect = dot.getBoundingClientRect();
    const tooltipWidth = tooltipEl.offsetWidth || 120;
    const halfWidth = tooltipWidth / 2;
    const padding = 12; // Safety margin from screen edges
    
    let centerX = rect.left + window.scrollX + rect.width / 2;
    
    // Clamp horizontal position so tooltip stays completely within viewport width
    const minX = padding + halfWidth;
    const maxX = window.innerWidth - padding - halfWidth;
    
    if (centerX < minX) centerX = minX;
    if (centerX > maxX) centerX = maxX;
    
    tooltipEl.style.left = centerX + 'px';
    tooltipEl.style.top = (rect.top + window.scrollY - 6) + 'px';
  };

  const hideTooltip = () => {
    if (tooltipEl) tooltipEl.classList.remove('show');
  };

  root.addEventListener('mouseover', showTooltip);
  root.addEventListener('mouseout', (ev) => {
    if (ev.target.closest('.linechart-dot, .stacked-segment')) hideTooltip();
  });
  
  // Touch support for mobile
  root.addEventListener('touchstart', (ev) => {
    const dot = ev.target.closest('.linechart-dot, .stacked-segment');
    if (dot) {
      showTooltip(ev);
    }
  }, { passive: true });

  // Hide tooltip automatically when finger is lifted (unclicked)
  document.addEventListener('touchend', hideTooltip, { passive: true });
  document.addEventListener('touchcancel', hideTooltip, { passive: true });
  document.addEventListener('pointerup', hideTooltip, { passive: true });
}
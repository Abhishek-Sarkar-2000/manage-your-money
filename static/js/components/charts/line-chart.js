/* ---------- SVG line charts (self-contained, no libraries) ---------- */
import { fmtINR } from '../../core/format.js';

/*
 * Shared responsive Y-tick density classes.
 *
 * Top, middle and bottom are always "core", so responsive
 * CSS can never reduce a chart below three visible Y ticks.
 */
function yTickDensityClass(index, count) {
  const middleIndex =
    Math.round(
      (count - 1) / 2
    );

  if (
    index === 0 ||
    index === middleIndex ||
    index === count - 1
  ) {
    return 'is-core';
  }

  return index % 2 === 0
    ? 'is-medium'
    : 'is-dense';
}


/* =========================================================
   Home page: long-range daily balance trend
   ========================================================= */

export function dailyBalanceChart(series, rangeMonths) {
  if (!series.length) {
    return `<div class="empty-chart">Add a month to see your balance trend here.</div>`;
  }

  const useOriginalCompactChart =
    window.matchMedia('(max-width: 1023px)').matches;

  const w = 900;

  /*
   * Desktop gets the taller dashboard chart.
   * <=1023px returns completely to the original geometry.
   */
  const h = useOriginalCompactChart ? 220 : 276;

  const padL = 85;
  const padR = 20;
  const padT = useOriginalCompactChart ? 16 : 22;
  const padB = useOriginalCompactChart ? 34 : 42;

  const plotHeight = h - padT - padB;

  const vals = series.map(p => p.balance);
  const rawMin = Math.min(...vals);
  const rawMax = Math.max(...vals);

  const span =
    (rawMax - rawMin) ||
    Math.max(Math.abs(rawMax) * 0.1, 1000);

  const pad = span * 0.18;
  const minV = rawMin - pad;
  const maxV = rawMax + pad;
  const range = (maxV - minV) || 1;

  const stepX =
    series.length > 1
      ? (w - padL - padR) / (series.length - 1)
      : 0;

  const coords = series.map((p, i) => {
    const x =
      series.length > 1
        ? padL + i * stepX
        : (padL + w - padR) / 2;

    const y =
      h -
      padB -
      ((p.balance - minV) / range) *
        plotHeight;

    return [x, y];
  });

  const pathD = coords
    .map(
      (c, i) =>
        (i === 0 ? 'M' : 'L') +
        c[0].toFixed(1) +
        ',' +
        c[1].toFixed(1)
    )
    .join(' ');

  const areaD =
    pathD +
    ` L${coords[coords.length - 1][0].toFixed(1)},${h - padB}` +
    ` L${coords[0][0].toFixed(1)},${h - padB} Z`;

  /*
   * Increase Y-axis detail when the chart has more vertical room.
   * Keep the density bounded so labels never become excessive.
   */
  const homeYTickCount = useOriginalCompactChart
    ? 8
    : Math.max(
        6,
        Math.min(
          11,
          Math.round(plotHeight / 50) + 1
        )
      );

  const homeYTicks =
    Array.from(
      { length: homeYTickCount },
      (_, i) => {
        const ratio =
          homeYTickCount > 1
            ? i / (homeYTickCount - 1)
            : 0;

        return (
          maxV -
          ratio * (maxV - minV)
        );
      }
    );

  const gridSvg =
    homeYTicks
      .map((value, i) => {
        const y =
          padT +
          ((maxV - value) /
            (maxV - minV)) *
            plotHeight;

        const densityClass =
          yTickDensityClass(
            i,
            homeYTicks.length
          );

        return `
          <line
            class="home-y-grid ${densityClass}"
            x1="${padL}"
            y1="${y.toFixed(1)}"
            x2="${w - padR}"
            y2="${y.toFixed(1)}"
            stroke="var(--sky)"
            stroke-opacity="0.25"
            stroke-width="1"
            stroke-dasharray="4 4"
          ></line>

          <text
            class="home-y-tick ${densityClass}"
            x="${padL - 10}"
            y="${(y + 3).toFixed(1)}"
            fill="var(--muted)"
            text-anchor="end"
            font-family="IBM Plex Mono, monospace"
          >${formatYAxisTick(value)}</text>
        `;
      })
      .join('');

  let tickIdxs = [];

  if (rangeMonths === 1) {
    for (let i = 0; i < series.length; i += 7) {
      tickIdxs.push(i);
    }
  } else {
    let lastMonth = null;

    series.forEach((p, i) => {
      const mk = p.date.slice(0, 7);

      if (mk !== lastMonth) {
        tickIdxs.push(i);
        lastMonth = mk;
      }
    });
  }

  const tickLabel = (p) => {
    const d = new Date(p.date + 'T00:00:00');

    return rangeMonths === 1
      ? d.toLocaleDateString('en-IN', {
          day: 'numeric',
          month: 'short'
        })
      : d.toLocaleDateString('en-IN', {
          month: 'short',
          year: '2-digit'
        });
  };

  const dots = coords
    .map(([x, y], i) => {
      return `
        <circle
          class="linechart-dot"
          data-val="${fmtINR(series[i].balance)}"
          data-label="${series[i].date}"
          cx="${x.toFixed(1)}"
          cy="${y.toFixed(1)}"
          r="3"
          fill="var(--blue)"
          opacity="${tickIdxs.includes(i) ? 1 : 0}"
          stroke="transparent"
          stroke-width="8"
          style="cursor:pointer;"
        ></circle>
      `;
    })
    .join('');

  const labels = tickIdxs
    .map(i => {
      const [x] = coords[i];

      return `
        <text
          x="${x.toFixed(1)}"
          y="${h - 6}"
          fill="var(--muted)"
          text-anchor="middle"
          font-family="IBM Plex Mono, monospace"
        >${tickLabel(series[i])}</text>
      `;
    })
    .join('');

  const lastPoint = series[series.length - 1];

  return `
    <div class="responsive-linechart-container home-linechart-container">
    <svg
      class="linechart dashboard-balance-chart-svg"
      viewBox="0 0 ${w} ${h}"
    >
      <defs>
        <linearGradient
          id="ofade"
          x1="0"
          y1="0"
          x2="0"
          y2="1"
        >
          <stop
            offset="0%"
            stop-color="var(--blue)"
            stop-opacity="0.22"
          />
          <stop
            offset="100%"
            stop-color="var(--blue)"
            stop-opacity="0"
          />
        </linearGradient>
      </defs>

      ${gridSvg}

      <path
        d="${areaD}"
        fill="url(#ofade)"
        stroke="none"
      />

      <path
        d="${pathD}"
        fill="none"
        stroke="var(--blue)"
        stroke-width="2"
        stroke-linejoin="round"
        stroke-linecap="round"
      />

      ${dots}
      ${labels}
    </svg>

    <div class="subnote">
      Latest balance (${lastPoint.date}):
      <strong class="num">${fmtINR(lastPoint.balance)}</strong>
    </div>
    </div>
  `;
}


/* =========================================================
   Month page: interactive running-balance line chart
   ========================================================= */

let lineChartIdCounter = 0;

const lineChartStates = new Map();

const LINE_CHART_W = 900;
const LINE_CHART_H = 170;

/*
 * Both axes now live outside the SVG.
 *
 * The SVG therefore only needs a tiny inset on every side
 * so line caps and point circles are not clipped.
 */
const LINE_PAD_L = 4;
const LINE_PAD_R = 4;
const LINE_PAD_T = 4;
const LINE_PAD_B = 4;


/*
 * Each chart is rendered immediately.
 *
 * Drag interaction is delegated to document, so this also
 * works when the chart is inserted later with innerHTML.
 */
export function lineChart(
  startingBalance,
  data,
  recurringRows
) {
  const entries = [
    ...data.entries,
    ...recurringRows
  ]
    .filter(
      e =>
        e.type === 'income' ||
        e.type === 'investment' ||
        e.type === 'emi' ||
        e.type === 'sip' ||
        (e.type === 'spend' &&
          e.paymentMode !== 'card') ||
        (e.type === 'spend' &&
          e.paymentMode === 'card')
    )
    .filter(e => e.date)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date)
    );

  const start =
    Number(startingBalance) || 0;

  if (entries.length === 0) {
    return `
      <div class="empty-chart">
        Balance line will appear once you add entries with dates.
      </div>
    `;
  }

  let running = start;

  const points = [
    {
      date: 'start',
      balance: running
    }
  ];

  for (const e of entries) {
    const amt =
      Number(e.amount) || 0;

    if (e.type === 'income') {
      running += amt;
    } else {
      running -= amt;
    }

    points.push({
      date: e.date,
      balance: running
    });
  }

  const id =
    `linechart-${++lineChartIdCounter}`;

  lineChartStates.set(id, {
    points,
    zoomStart: 0,
    zoomEnd: points.length - 1
  });

  return renderInteractiveLineChart(
    id,
    points,
    0,
    points.length - 1
  );
}

function niceYAxisStep(value) {
  if (
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return 1;
  }

  const exponent =
    Math.floor(
      Math.log10(value)
    );

  const magnitude =
    Math.pow(10, exponent);

  const fraction =
    value / magnitude;

  let niceFraction;

  /*
   * Prefer familiar chart intervals:
   * 1, 2, 2.5, 5, 10 × powers of ten.
   */
  if (fraction <= 1) {
    niceFraction = 1;
  } else if (fraction <= 2) {
    niceFraction = 2;
  } else if (fraction <= 2.5) {
    niceFraction = 2.5;
  } else if (fraction <= 5) {
    niceFraction = 5;
  } else {
    niceFraction = 10;
  }

  return niceFraction * magnitude;
}


function buildYAxisScale(
  rawMin,
  rawMax
) {
  if (
    !Number.isFinite(rawMin) ||
    !Number.isFinite(rawMax)
  ) {
    return {
      min: 0,
      max: 1,
      ticks: [1, 0]
    };
  }

  let minV = rawMin;
  let maxV = rawMax;

  if (minV === maxV) {
    const padding =
      Math.max(
        Math.abs(minV) * 0.05,
        1
      );

    minV -= padding;
    maxV += padding;
  }

  const span =
    Math.max(
      maxV - minV,
      1
    );

  /*
   * Aim for roughly 5–7 readable grid levels.
   * niceYAxisStep() then chooses a sensible monetary interval.
   */
  const step =
    niceYAxisStep(
      span / 6
    );

  const niceMin =
    Math.floor(
      minV / step
    ) * step;

  const niceMax =
    Math.ceil(
      maxV / step
    ) * step;

  const ticks = [];

  /*
   * Build top → bottom because that matches the chart's
   * vertical coordinate system and external Y-axis markup.
   */
  for (
    let value = niceMax;
    value >= niceMin - step * 0.001;
    value -= step
  ) {
    /*
     * Avoid floating-point junk such as
     * 9999.999999999998.
     */
    const cleaned =
      Math.abs(value) <
      step * 0.000001
        ? 0
        : Number(
            value.toPrecision(12)
          );

    ticks.push(cleaned);

    /*
     * Safety guard.
     */
    if (ticks.length >= 9) {
      break;
    }
  }

  return {
    min: niceMin,
    max: niceMax,
    ticks
  };
}


/*
 * Compact Indian-number formatter specifically for
 * chart-axis labels.
 *
 * Examples:
 *   850       → ₹850
 *   1,250     → ₹1.3K
 *   18,000    → ₹18K
 *   1,25,000  → ₹1.3L
 *   12,50,000 → ₹12.5L
 *   1,50,00,000 → ₹1.5Cr
 */
function formatYAxisTick(value) {
  const n =
    Number(value);

  if (!Number.isFinite(n)) {
    return '';
  }

  const negative =
    n < 0;

  const abs =
    Math.abs(n);

  let scaled;
  let suffix;

  if (abs >= 10000000) {
    scaled =
      abs / 10000000;

    suffix = 'Cr';
  } else if (abs >= 100000) {
    scaled =
      abs / 100000;

    suffix = 'L';
  } else if (abs >= 1000) {
    scaled =
      abs / 1000;

    suffix = 'K';
  } else {
    const rounded =
      Math.round(abs);

    return `${
      negative ? '-' : ''
    }₹${rounded}`;
  }

  /*
   * Large scaled values do not need a decimal.
   * Smaller values retain one decimal where useful.
   */
  const decimals =
    scaled >= 100
      ? 0
      : scaled >= 10
        ? 1
        : 1;

  const formatted =
    scaled
      .toFixed(decimals)
      .replace(/\.0$/, '');

  return `${
    negative ? '-' : ''
  }₹${formatted}${suffix}`;
}

function buildUniqueXTickIndexes(visiblePoints) {
  const uniqueDateIndexes = [];
  const seenDates = new Set();

  visiblePoints.forEach((point, i) => {
    const key = point.date;

    if (!seenDates.has(key)) {
      seenDates.add(key);
      uniqueDateIndexes.push(i);
    }
  });

  const maxTicks =
    uniqueDateIndexes.length <= 10
      ? uniqueDateIndexes.length
      : uniqueDateIndexes.length <= 20
        ? 8
        : 7;

  if (uniqueDateIndexes.length <= maxTicks) {
    return uniqueDateIndexes;
  }

  const result = [];

  const step =
    (uniqueDateIndexes.length - 1) /
    (maxTicks - 1);

  for (let i = 0; i < maxTicks; i++) {
    const uniqueIndex =
      Math.round(i * step);

    const pointIndex =
      uniqueDateIndexes[uniqueIndex];

    if (!result.includes(pointIndex)) {
      result.push(pointIndex);
    }
  }

  return result;
}

/*
 * Render the complete current chart state.
 */
function renderInteractiveLineChart(
  id,
  points,
  zoomStart,
  zoomEnd
) {
  const visiblePoints =
    points.slice(
      zoomStart,
      zoomEnd + 1
    );

  let minV = Math.min(
    ...visiblePoints.map(
      p => p.balance
    )
  );

  let maxV = Math.max(
    ...visiblePoints.map(
      p => p.balance
    )
  );

  /*
   * If all visible values are identical,
   * create a small artificial Y range.
   */
  if (minV === maxV) {
    const padding =
      Math.max(
        Math.abs(minV) * 0.05,
        1
      );

    minV -= padding;
    maxV += padding;
  }

  /*
   * Expand the visible range onto clean monetary boundaries
   * and derive the grid ticks from that same scale.
   */
  const yScale =
    buildYAxisScale(
      minV,
      maxV
    );

  minV = yScale.min;
  maxV = yScale.max;

  const yTicks =
    yScale.ticks;

  const range =
    maxV - minV || 1;

  const stepX =
    (LINE_CHART_W -
      LINE_PAD_L -
      LINE_PAD_R) /
    Math.max(
      1,
      visiblePoints.length - 1
    );

  const coords =
    visiblePoints.map((p, i) => {
      const x =
        LINE_PAD_L +
        i * stepX;

      const y =
        LINE_CHART_H -
        LINE_PAD_B -
        ((p.balance - minV) /
          range) *
          (LINE_CHART_H -
            LINE_PAD_T -
            LINE_PAD_B);

      return [x, y];
    });

  const pathD =
    coords
      .map(
        ([x, y], i) =>
          (i === 0
            ? 'M'
            : 'L') +
          x.toFixed(1) +
          ',' +
          y.toFixed(1)
      )
      .join(' ');

  const areaD =
    pathD +
    ` L${coords[
      coords.length - 1
    ][0].toFixed(1)},${
      LINE_CHART_H - LINE_PAD_B
    }` +
    ` L${coords[0][0].toFixed(1)},${
      LINE_CHART_H - LINE_PAD_B
    } Z`;

  const plotHeight =
    LINE_CHART_H -
    LINE_PAD_T -
    LINE_PAD_B;

  const plotWidth =
    LINE_CHART_W -
    LINE_PAD_L -
    LINE_PAD_R;

  const horizontalGrid = yTicks
    .map((value, i) => {
      const y =
        LINE_PAD_T +
        ((maxV - value) /
          (maxV - minV)) *
          plotHeight;

      const densityClass =
        yTickDensityClass(
          i,
          yTicks.length
        );

      return `
        <line
          class="linechart-y-grid responsive-y-grid ${densityClass}"
          x1="${LINE_PAD_L}"
          y1="${y.toFixed(1)}"
          x2="${LINE_CHART_W - LINE_PAD_R}"
          y2="${y.toFixed(1)}"
          stroke="var(--sky)"
          stroke-opacity="0.5"
          stroke-width="1.5"
          stroke-dasharray="4 4"
        />
      `;
    })
    .join('');

  /*
   * Y-axis labels live outside the SVG.
   * Their vertical positions match the SVG grid lines.
   */
  const yTicksHtml = yTicks
    .map((value, i) => {
      const topPct =
        ((maxV - value) /
          (maxV - minV)) *
        100;

      const densityClass =
        yTickDensityClass(
          i,
          yTicks.length
        );

      return `
        <div
          class="linechart-y-tick responsive-y-tick ${densityClass}"
          style="top:${topPct}%;"
          title="${fmtINR(value)}"
        >
          ${formatYAxisTick(value)}
        </div>
      `;
    })
    .join('');

  const xTickIndexes =
    buildUniqueXTickIndexes(
      visiblePoints
    );

  const xTicksHtml = xTickIndexes
    .map(i => {
      const point =
        visiblePoints[i];

      const [x] =
        coords[i];

      const plotX =
        (x - LINE_PAD_L) /
        plotWidth;

      const leftPct =
        Math.max(
          0,
          Math.min(1, plotX)
        ) * 100;

      let label;

      if (point.date === 'start') {
        label = 'Day 0';
      } else {
        const d =
          new Date(
            point.date +
            'T00:00:00'
          );

        label =
          d.getDate();
      }

      return `
        <div
          class="linechart-x-tick ${point.date === 'start' ? 'is-day-zero' : ''}"
          style="left:${leftPct}%;"
        >
          ${label}
        </div>
      `;
    })
    .join('');

  const dots = visiblePoints
    .map((point, i) => {
      const [x, y] = coords[i];

      const label =
        point.date === 'start'
          ? 'Start'
          : point.date;

      return `
        <circle
          class="linechart-dot"
          data-val="${fmtINR(point.balance)}"
          data-label="${label}"
          cx="${x.toFixed(1)}"
          cy="${y.toFixed(1)}"
          r="3"
          fill="var(--blue)"
          stroke="transparent"
          stroke-width="8"
          style="cursor:pointer;"
        ></circle>
      `;
    })
    .join('');

  const firstX = coords[0][0];
  const lastX = coords[coords.length - 1][0];

  const isZoomed =
    zoomStart !== 0 ||
    zoomEnd !== points.length - 1;

  const lastPoint =
    visiblePoints[visiblePoints.length - 1];

  return `
    <div
      class="linechart-container"
      data-linechart-id="${id}"
    >

      <div class="linechart-layout">

        <!-- Separate Y axis -->
        <div class="linechart-y-axis">
          <div class="linechart-y-axis-inner">
            ${yTicksHtml}
          </div>
        </div>

        <!-- Main chart -->
        <div class="linechart-main">

          <div class="linechart-wrapper">
            <svg
              class="linechart"
              data-linechart-svg="${id}"
              viewBox="0 0 ${LINE_CHART_W} ${LINE_CHART_H}"
              preserveAspectRatio="none"
            >

              <defs>
                <linearGradient
                  id="lineFade-${id}"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    stop-color="var(--blue)"
                    stop-opacity="0.22"
                  />

                  <stop
                    offset="100%"
                    stop-color="var(--blue)"
                    stop-opacity="0"
                  />
                </linearGradient>
              </defs>

              <!-- Zoom layer below dots -->
              <rect
                class="linechart-zoom-hitbox"
                x="${LINE_PAD_L}"
                y="${LINE_PAD_T}"
                width="${plotWidth}"
                height="${plotHeight}"
                fill="transparent"
              />

              <g pointer-events="none">

                ${horizontalGrid}

                <path
                  d="${areaD}"
                  fill="url(#lineFade-${id})"
                  stroke="none"
                />

                <path
                  d="${pathD}"
                  fill="none"
                  stroke="var(--blue)"
                  stroke-width="2.5"
                  stroke-linejoin="round"
                  stroke-linecap="round"
                />

              </g>

              <!-- Dots remain interactive -->
              ${dots}

              <rect
                class="linechart-selection"
                x="0"
                y="${LINE_PAD_T}"
                width="0"
                height="${plotHeight}"
                fill="var(--blue)"
                fill-opacity="0.10"
                stroke="var(--blue)"
                stroke-opacity="0.35"
                pointer-events="none"
                hidden
              />

            </svg>
          </div>

          <!-- Separate X axis -->
          <div class="linechart-x-axis">
            ${xTicksHtml}
          </div>

        </div>

      </div>

      <div class="linechart-controls">
        <span class="linechart-hint">
          Drag to zoom
        </span>

        ${
          isZoomed
            ? `
              <button
                type="button"
                class="linechart-reset"
                data-linechart-reset="${id}"
              >
                Reset
              </button>
            `
            : ''
        }
      </div>

      <div class="subnote linechart-subnote">
        Latest balance:
        <strong class="num">
          ${fmtINR(lastPoint.balance)}
        </strong>
      </div>

    </div>
  `;
}


/* =========================================================
   Line chart interaction helpers
   ========================================================= */

function getLineChartSvgX(
  svg,
  clientX
) {
  const rect =
    svg.getBoundingClientRect();

  if (!rect.width) {
    return LINE_PAD_L;
  }

  return (
    ((clientX - rect.left) /
      rect.width) *
    LINE_CHART_W
  );
}


function lineChartXToIndex(
  x,
  visiblePointCount
) {
  const chartWidth =
    LINE_CHART_W -
    LINE_PAD_L -
    LINE_PAD_R;

  const ratio =
    (x - LINE_PAD_L) /
    chartWidth;

  const clamped =
    Math.max(
      0,
      Math.min(1, ratio)
    );

  return Math.round(
    clamped *
    Math.max(0, visiblePointCount - 1)
  );
}


/* =========================================================
   Pointer drag state
   ========================================================= */

const lineChartDrag = {
  id: null,
  pointerId: null,
  startX: 0,
  currentX: 0
};


function clearLineChartDrag() {
  if (lineChartDrag.id) {
    const svg =
      document.querySelector(
        `[data-linechart-svg="${lineChartDrag.id}"]`
      );

    if (svg) {
      svg.classList.remove(
        'is-zooming'
      );

      const selection =
        svg.querySelector(
          '.linechart-selection'
        );

      if (selection) {
        selection.hidden = true;
      }
    }
  }

  lineChartDrag.id = null;
  lineChartDrag.pointerId = null;
  lineChartDrag.startX = 0;
  lineChartDrag.currentX = 0;
}


/* =========================================================
   Document-level pointer handlers
   ========================================================= */

/*
 * POINTER DOWN
 *
 * Uses closest() so dynamically created charts work too.
 */
document.addEventListener(
  'pointerdown',
  e => {
    const hitbox =
      e.target.closest(
        '.linechart-zoom-hitbox'
      );

    if (!hitbox) return;

    const svg =
      hitbox.closest('svg');

    if (!svg) return;

    const id =
      svg.dataset.linechartSvg;

    const state =
      lineChartStates.get(id);

    if (!state) return;

    lineChartDrag.id = id;
    lineChartDrag.pointerId =
      e.pointerId;

    lineChartDrag.startX =
      getLineChartSvgX(
        svg,
        e.clientX
      );

    lineChartDrag.currentX =
      lineChartDrag.startX;

    svg.classList.add(
      'is-zooming'
    );

    try {
      hitbox.setPointerCapture(
        e.pointerId
      );
    } catch (_) {}

    const selection =
      svg.querySelector(
        '.linechart-selection'
      );

    if (selection) {
      selection.hidden = false;
      selection.setAttribute(
        'x',
        lineChartDrag.startX
      );
      selection.setAttribute(
        'width',
        '0'
      );
      selection.setAttribute(
        'fill-opacity',
        '0.10'
      );
    }

    e.preventDefault();
  },
  { passive: false }
);


/*
 * POINTER MOVE
 */
document.addEventListener(
  'pointermove',
  e => {
    if (
      !lineChartDrag.id ||
      lineChartDrag.pointerId !==
        e.pointerId
    ) {
      return;
    }

    const svg =
      document.querySelector(
        `[data-linechart-svg="${lineChartDrag.id}"]`
      );

    if (!svg) return;

    const rawX =
      getLineChartSvgX(
        svg,
        e.clientX
      );

    const x =
      Math.max(
        LINE_PAD_L,
        Math.min(
          LINE_CHART_W - LINE_PAD_R,
          rawX
        )
      );

    lineChartDrag.currentX = x;

    const left =
      Math.min(
        lineChartDrag.startX,
        x
      );

    const width =
      Math.abs(
        x -
          lineChartDrag.startX
      );

    const selection =
      svg.querySelector(
        '.linechart-selection'
      );

    if (selection) {
      selection.setAttribute(
        'x',
        left.toFixed(1)
      );

      selection.setAttribute(
        'width',
        width.toFixed(1)
      );
    }

    e.preventDefault();
  },
  { passive: false }
);


/*
 * POINTER UP
 */
document.addEventListener(
  'pointerup',
  e => {
    if (
      !lineChartDrag.id ||
      lineChartDrag.pointerId !==
        e.pointerId
    ) {
      return;
    }

    const id =
      lineChartDrag.id;

    const state =
      lineChartStates.get(id);

    if (!state) {
      clearLineChartDrag();
      return;
    }

    const startX =
      lineChartDrag.startX;

    const endX =
      lineChartDrag.currentX;

    /*
     * Ignore clicks/taps that are not
     * actually dragging.
     */
    if (
      Math.abs(
        endX - startX
      ) < 10
    ) {
      clearLineChartDrag();
      return;
    }

    const visibleStart = state.zoomStart;
    const visibleEnd = state.zoomEnd;

    const visiblePointCount =
      visibleEnd -
      visibleStart +
      1;

    const localStartIndex =
      lineChartXToIndex(
        Math.min(startX, endX),
        visiblePointCount
      );

    const localEndIndex =
      lineChartXToIndex(
        Math.max(startX, endX),
        visiblePointCount
      );

    // Convert indexes relative to the currently visible section
    // back into indexes in the original points array.
    let startIndex =
      visibleStart +
      localStartIndex;

    let endIndex =
      visibleStart +
      localEndIndex;

    if (startIndex > endIndex) {
      [startIndex, endIndex] =
        [endIndex, startIndex];
    }

    /*
     * Require at least two points.
     */
    if (endIndex - startIndex >= 1) {
      state.zoomStart = startIndex;
      state.zoomEnd = endIndex;
      redrawLineChart(id);
    }

    clearLineChartDrag();
  }
);


/*
 * POINTER CANCEL
 */
document.addEventListener(
  'pointercancel',
  e => {
    if (
      lineChartDrag.pointerId ===
      e.pointerId
    ) {
      clearLineChartDrag();
    }
  }
);


/* =========================================================
   Redraw after zoom
   ========================================================= */

function redrawLineChart(id) {
  const state =
    lineChartStates.get(id);

  if (!state) return;

  const container =
    document.querySelector(
      `[data-linechart-id="${id}"]`
    );

  if (!container) return;

  const newHtml =
    renderInteractiveLineChart(
      id,
      state.points,
      state.zoomStart,
      state.zoomEnd
    );

  /*
   * Replace the complete chart container.
   *
   * This is safe because interaction is delegated
   * at document level.
   */
  container.outerHTML =
    newHtml;
}


/* =========================================================
   Reset zoom
   ========================================================= */

document.addEventListener(
  'click',
  e => {
    const button =
      e.target.closest(
        '[data-linechart-reset]'
      );

    if (!button) return;

    const id =
      button.dataset.linechartReset;

    const state =
      lineChartStates.get(id);

    if (!state) return;

    state.zoomStart = 0;

    state.zoomEnd =
      state.points.length - 1;

    redrawLineChart(id);
  }
);


/* =========================================================
   Price Tracker: per-item price-history trend line
   ========================================================= */

export function priceLineChart(hist) {
  if (!hist.length) {
    return `
      <div class="empty-chart">
        Log a price to see the trend line.
      </div>
    `;
  }

  if (hist.length === 1) {
    return `
      <div class="empty-chart">
        Log one more price to see a trend line.
        Latest:
        <strong>
          ${fmtINR(hist[0].price)}
        </strong>
      </div>
    `;
  }

  const w = 900;
  const h = 170;

  /*
   * Y-axis labels are compact, so we do not need
   * the old 85-unit gutter.
   */
  const padL = 60;
  const padR = 20;
  const padT = 16;
  const padB = 30;

  const vals =
    hist.map(p => p.price);

  const minV =
    Math.min(...vals);

  const maxV =
    Math.max(...vals);

  const range =
    (maxV - minV) || 1;

  const stepX =
    (w - padL - padR) /
    Math.max(
      1,
      hist.length - 1
    );

  const coords =
    hist.map((p, i) => {
      const x =
        padL + i * stepX;

      const y =
        h -
        padB -
        ((p.price - minV) /
          range) *
          (h - padT - padB);

      return [x, y];
    });

  const pathD =
    coords
      .map(
        (c, i) =>
          (i === 0 ? 'M' : 'L') +
          c[0].toFixed(1) +
          ',' +
          c[1].toFixed(1)
      )
      .join(' ');

  const areaD =
    pathD +
    ` L${coords[
      coords.length - 1
    ][0].toFixed(1)},${
      h - padB
    }` +
    ` L${coords[0][0].toFixed(1)},${
      h - padB
    } Z`;

  const priceYTicks =
    Array.from(
      { length: 6 },
      (_, i) =>
        maxV -
        (i / 5) *
          (maxV - minV)
    );

  const gridSvg =
    priceYTicks
      .map((value, i) => {
        const y =
          padT +
          ((maxV - value) /
            ((maxV - minV) || 1)) *
            (h - padT - padB);

        const densityClass =
          yTickDensityClass(
            i,
            priceYTicks.length
          );

        return `
          <line
            class="responsive-y-grid ${densityClass}"
            x1="${padL}"
            y1="${y.toFixed(1)}"
            x2="${w - padR}"
            y2="${y.toFixed(1)}"
            stroke="var(--sky)"
            stroke-opacity="0.25"
            stroke-width="1"
            stroke-dasharray="4 4"
          ></line>

          <text
            class="responsive-y-tick ${densityClass}"
            x="${padL - 10}"
            y="${(y + 3).toFixed(1)}"
            fill="var(--muted)"
            text-anchor="end"
            font-family="IBM Plex Mono, monospace"
          >${formatYAxisTick(value)}</text>
        `;
      })
      .join('');

  const dots =
    coords
      .map(([x, y], i) => {
        const dl =
          new Date(
            hist[i].date +
              'T00:00:00'
          ).toLocaleDateString(
            'en-IN',
            {
              day: '2-digit',
              month: 'short',
              year: 'numeric'
            }
          );

        return `
          <circle
            class="linechart-dot"
            data-val="${fmtINR(hist[i].price)}"
            data-label="${dl}"
            cx="${x.toFixed(1)}"
            cy="${y.toFixed(1)}"
            r="3"
            fill="var(--blue)"
            stroke="transparent"
            stroke-width="8"
            style="cursor:pointer;"
          ></circle>
        `;
      })
      .join('');

  const lastVal =
    hist[hist.length - 1].price;

  return `
    <div class="price-linechart-container">
    <svg
      class="linechart price-linechart"
      viewBox="0 0 ${w} ${h}"
    >
      <defs>
        <linearGradient
          id="priceLineFade"
          x1="0"
          y1="0"
          x2="0"
          y2="1"
        >
          <stop
            offset="0%"
            stop-color="var(--blue)"
            stop-opacity="0.22"
          />
          <stop
            offset="100%"
            stop-color="var(--blue)"
            stop-opacity="0"
          />
        </linearGradient>
      </defs>

      ${gridSvg}

      <path
        d="${areaD}"
        fill="url(#priceLineFade)"
        stroke="none"
      />

      <path
        d="${pathD}"
        fill="none"
        stroke="var(--blue)"
        stroke-width="2.5"
        stroke-linejoin="round"
        stroke-linecap="round"
      />

      ${dots}
    </svg>

    <div class="subnote">
      Latest price:
      <strong class="num">
        ${fmtINR(lastVal)}
      </strong>
    </div>
    </div>
  `;
}


/* =========================================================
   Chart tooltips
   ========================================================= */

let tooltipEl = null;

export function wireChartTooltips(
  root = document
) {
  if (!tooltipEl) {
    tooltipEl =
      document.createElement('div');

    tooltipEl.className =
      'chart-tooltip';

    document.body.appendChild(
      tooltipEl
    );
  }

  const showTooltip = ev => {
    const dot =
      ev.target.closest(
        '.linechart-dot, .stacked-segment, .shared-debt-segment, .dashboard-cashflow-bar'
      );

    if (!dot) return;

    const val =
      dot.dataset.val;

    const label =
      dot.dataset.label || '';

    tooltipEl.innerHTML = `
      <div class="ct-val">
        ${val}
      </div>
      ${
        label
          ? `<div class="ct-label">${label}</div>`
          : ''
      }
    `;

    tooltipEl.classList.add(
      'show'
    );

    const rect =
      dot.getBoundingClientRect();

    const tooltipWidth =
      tooltipEl.offsetWidth || 120;

    const halfWidth =
      tooltipWidth / 2;

    const padding = 12;

    let centerX =
      rect.left +
      window.scrollX +
      rect.width / 2;

    const minX =
      padding + halfWidth;

    const maxX =
      window.innerWidth -
      padding -
      halfWidth;

    if (centerX < minX) {
      centerX = minX;
    }

    if (centerX > maxX) {
      centerX = maxX;
    }

    tooltipEl.style.left =
      centerX + 'px';

    tooltipEl.style.top =
      (
        rect.top +
        window.scrollY -
        6
      ) + 'px';
  };

  const hideTooltip = () => {
    if (tooltipEl) {
      tooltipEl.classList.remove(
        'show'
      );
    }
  };

  root.addEventListener(
    'mouseover',
    showTooltip
  );

  root.addEventListener(
    'mouseout',
    ev => {
      if (
        ev.target.closest(
          '.linechart-dot, .stacked-segment, .shared-debt-segment, .dashboard-cashflow-bar'
        )
      ) {
        hideTooltip();
      }
    }
  );

  // Touch support for mobile.
  root.addEventListener(
    'touchstart',
    ev => {
      const dot =
        ev.target.closest(
          '.linechart-dot, .stacked-segment, .shared-debt-segment, .dashboard-cashflow-bar'
        );

      if (dot) {
        showTooltip(ev);
      }
    },
    { passive: true }
  );

  document.addEventListener(
    'touchend',
    hideTooltip,
    { passive: true }
  );

  document.addEventListener(
    'touchcancel',
    hideTooltip,
    { passive: true }
  );

  document.addEventListener(
    'pointerup',
    hideTooltip,
    { passive: true }
  );
}
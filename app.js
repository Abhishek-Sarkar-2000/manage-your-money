/* =========================================================
   MANAGE YOUR MONEY — frontend
   Persistence via a local Flask + SQLite backend (see app.py)
   ========================================================= */

/* ---------- Utilities ---------- */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function fmtINR(n) {
  n = Number(n) || 0;
  const neg = n < 0;
  const v = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (neg ? '-' : '') + '₹' + v;
}

function fmtINRShort(n) {
  n = Number(n) || 0;
  const neg = n < 0;
  const abs = Math.abs(n);
  let val, suffix;
  if (abs >= 1e7) { val = abs / 1e7; suffix = 'Cr'; }
  else if (abs >= 1e5) { val = abs / 1e5; suffix = 'L'; }
  else if (abs >= 1e3) { val = abs / 1e3; suffix = 'K'; }
  else { val = abs; suffix = ''; }
  const str = suffix ? val.toFixed(1).replace(/\.0$/, '') : Math.round(val).toString();
  return (neg ? '-' : '') + '₹' + str + suffix;
}

// Horizontal gridlines + short-form value labels for the y-axis of a line chart
function yAxisGrid(minV, maxV, w, h, padL, padR, padT, padB, count) {
  count = count || 4;
  const range = (maxV - minV) || 1;
  
  // Determine a unified scale/suffix for the entire axis based on the largest absolute value
  const maxAbs = Math.max(Math.abs(maxV), Math.abs(minV));
  let div = 1, suf = '';
  if (maxAbs >= 1e7) { div = 1e7; suf = 'Cr'; }
  else if (maxAbs >= 1e5) { div = 1e5; suf = 'L'; }
  else if (maxAbs >= 1e3) { div = 1e3; suf = 'K'; }

  let out = '';
  for (let i = 0; i <= count; i++) {
    const v = minV + (range * i / count);
    const y = h - padB - ((v - minV) / range) * (h - padT - padB);
    
    // Assign responsive hiding classes based on fraction
    let cls = '';
    if (count === 8) {
      if (i % 2 !== 0) cls = 'y-tick-dense'; // 1, 3, 5, 7 hide on med/small screens
      else if (i % 4 !== 0) cls = 'y-tick-med'; // 2, 6 hide on small screens
    }

    // Expand up to 2 decimals dynamically to prevent duplicate consecutive ticks
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

function todayStr() { return new Date().toISOString().slice(0, 10); }
function currentMonthKey() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }

function monthKeyLabel(key) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

function monthKeyShort(key) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
}

function addMonths(key, n) {
  let [y, m] = key.split('-').map(Number);
  m += n;
  while (m > 12) { m -= 12; y += 1; }
  while (m < 1) { m += 12; y -= 1; }
  return y + '-' + String(m).padStart(2, '0');
}

function diffMonths(fromKey, toKey) {
  const [fy, fm] = fromKey.split('-').map(Number);
  const [ty, tm] = toKey.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showToast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._h);
  showToast._h = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- Storage layer ----------
   Talks to the local Flask backend (app.py), which persists
   everything in a SQLite database file (money.db) on disk. */
const Store = {
  async get(key, fallback) {
    try {
      const res = await fetch('/api/storage/' + encodeURIComponent(key));
      if (res.status === 404) return fallback;
      if (!res.ok) throw new Error('GET failed: ' + res.status);
      const body = await res.json();
      return JSON.parse(body.value);
    } catch (e) {
      console.error('storage get failed', key, e);
      showToast('Could not reach the server — is app.py running?');
      return fallback;
    }
  },
  async set(key, value) {
    try {
      const res = await fetch('/api/storage/' + encodeURIComponent(key), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: JSON.stringify(value) })
      });
      if (!res.ok) throw new Error('PUT failed: ' + res.status);
      return true;
    } catch (e) {
      console.error('storage set failed', key, e);
      showToast('Could not save — is app.py running?');
      return false;
    }
  }
};

/* ---------- Spend tags ---------- */
const DEFAULT_TAGS = ["Groceries", "Dining", "Fuel", "Subscription", "Rent", "Utility", "Recharge", "Transport", "Gift"];

/* ---------- App state ---------- */
const State = {
  view: 'home',
  cards: [],
  emiSeries: [],
  monthsIndex: [],
  monthCache: {},
  currentMonthKey: null,
  openForm: null,
  balanceChartRange: 1,
  customTags: [],
  splitsIndex: [],
  splitCache: {},
  splitFormOpen: false,
  splitExpandedId: null,
};

async function loadCore() {
  State.cards = await Store.get('creditcards', []);
  State.emiSeries = await Store.get('emiseries', []);
  State.monthsIndex = await Store.get('months-index', []);
  State.customTags = await Store.get('custom-spend-tags', []);
  State.splitsIndex = await Store.get('splits-index', []);
}

function allSpendTags() {
  const seen = new Set();
  const out = [];
  for (const t of [...DEFAULT_TAGS, ...State.customTags]) {
    const key = String(t).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

async function resolveTagFromForm() {
  const sel = $('#f-tag');
  if (!sel) return '';
  let val = sel.value;
  if (val === '__custom__') {
    const custom = ($('#f-tag-custom')?.value || '').trim();
    if (!custom) return '';
    const exists = allSpendTags().some(t => t.toLowerCase() === custom.toLowerCase());
    if (!exists) {
      State.customTags.push(custom);
      await Store.set('custom-spend-tags', State.customTags);
    }
    return custom;
  }
  return val;
}

async function loadMonth(key) {
  if (State.monthCache[key]) return State.monthCache[key];
  const data = await Store.get('month:' + key, { startingBalanceMode: 'manual', startingBalance: 0, entries: [], deletedEmi: [] });
  if (!data.startingBalanceMode) data.startingBalanceMode = 'manual';
  State.monthCache[key] = data;
  return data;
}

async function saveMonth(key) {
  await Store.set('month:' + key, State.monthCache[key]);
}

async function ensureMonthIndexed(key) {
  if (!State.monthsIndex.includes(key)) {
    State.monthsIndex.push(key);
    State.monthsIndex.sort();
    await Store.set('months-index', State.monthsIndex);
  }
}

async function loadAllMonths() {
  const out = {};
  for (const k of [...State.monthsIndex].sort()) {
    out[k] = await loadMonth(k);
  }
  return out;
}

/* ---------- Split Money: persistence ---------- */
const SPLIT_YOU = 'YOU';

async function loadSplit(id) {
  if (State.splitCache[id]) return State.splitCache[id];
  const data = await Store.get('split:' + id, null);
  if (data) {
    data.spends = data.spends || [];
    data.settlements = data.settlements || [];
    data.people = data.people && data.people.length ? data.people : [SPLIT_YOU];
    State.splitCache[id] = data;
  }
  return data;
}

async function saveSplit(id) {
  await Store.set('split:' + id, State.splitCache[id]);
}

async function createSplitGroup(description, people) {
  const id = 'split_' + uid();
  const group = { id, createdAt: todayStr(), description, people, spends: [], settlements: [] };
  State.splitCache[id] = group;
  await Store.set('split:' + id, group);
  State.splitsIndex.push(id);
  await Store.set('splits-index', State.splitsIndex);
  return id;
}

async function deleteSplitGroup(id) {
  State.splitsIndex = State.splitsIndex.filter(x => x !== id);
  await Store.set('splits-index', State.splitsIndex);
  delete State.splitCache[id];
  if (State.splitExpandedId === id) State.splitExpandedId = null;
}

async function loadAllSplitGroups() {
  const groups = [];
  for (const id of State.splitsIndex) {
    const g = await loadSplit(id);
    if (g) groups.push(g);
  }
  groups.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || (b.id || '').localeCompare(a.id || ''));
  return groups;
}

/* ---------- Domain helpers ---------- */
function cardById(id) { return State.cards.find(c => c.id === id); }

function emiRowsForMonth(monthKey, deletedEmi) {
  const rows = [];
  for (const series of State.emiSeries) {
    const inst = diffMonths(series.startMonth, monthKey) + 1;
    if (inst >= 1 && inst <= series.totalMonths) {
      if ((deletedEmi || []).includes(series.id)) continue;
      rows.push({
        id: 'emi-' + series.id + '-' + monthKey, type: 'emi', date: monthKey + '-01',
        description: series.description, amount: series.monthlyAmount,
        seriesId: series.id, installment: inst, totalMonths: series.totalMonths
      });
    }
  }
  return rows;
}

function computeMonthTotals(entries) {
  let income = 0, cashSpend = 0, cardPaymentSpend = 0, cardCharge = 0, invest = 0, emi = 0;
  for (const e of entries) {
    const amt = Number(e.amount) || 0;
    if (e.type === 'income') income += amt;
    else if (e.type === 'spend') {
      if (e.paymentMode === 'card') cardPaymentSpend += amt;
      else cashSpend += amt;
    }
    else if (e.type === 'cardcharge') cardCharge += amt;
    else if (e.type === 'investment') invest += amt;
    else if (e.type === 'emi') emi += amt;
  }
  return { income, cashSpend, cardPaymentSpend, cardCharge, invest, emi };
}

function monthCashOutflow(totals) {
  return totals.cashSpend + totals.cardPaymentSpend + totals.emi + totals.invest;
}

/* ---------- Global (cross-month) computations ---------- */
async function computeMonthlyBreakdown() {
  const sortedKeys = [...State.monthsIndex].sort();
  const rows = [];
  let prevEnding = null;
  for (const k of sortedKeys) {
    const data = await loadMonth(k);
    const emiRows = emiRowsForMonth(k, data.deletedEmi);
    const totals = computeMonthTotals(data.entries.concat(emiRows));
    let starting;
    if (data.startingBalanceMode === 'auto' && prevEnding !== null) {
      starting = prevEnding;
    } else {
      starting = Number(data.startingBalance) || 0;
    }
    const outflow = monthCashOutflow(totals);
    const ending = starting + totals.income - outflow;
    rows.push({ monthKey: k, starting, income: totals.income, outflow, ending, totals });
    prevEnding = ending;
  }
  return rows;
}

async function computeDailyBalanceSeries() {
  const breakdown = await computeMonthlyBreakdown();
  if (!breakdown.length) return [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const series = [];

  for (const b of breakdown) {
    const data = await loadMonth(b.monthKey);
    const emiRows = emiRowsForMonth(b.monthKey, data.deletedEmi);
    const relevant = [...data.entries, ...emiRows].filter(e =>
      e.type === 'income' || e.type === 'investment' || e.type === 'emi' || e.type === 'spend'
    );
    const deltaByDay = {};
    for (const e of relevant) {
      if (!e.date) continue;
      const amt = Number(e.amount) || 0;
      const signed = e.type === 'income' ? amt : -amt;
      deltaByDay[e.date] = (deltaByDay[e.date] || 0) + signed;
    }
    const [y, m] = b.monthKey.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    let running = b.starting;
    for (let d = 1; d <= daysInMonth; d++) {
      const dateObj = new Date(y, m - 1, d);
      if (dateObj > today) break;
      const dateStr = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      if (deltaByDay[dateStr]) running += deltaByDay[dateStr];
      series.push({ date: dateStr, balance: running });
    }
  }

  if (series.length) {
    let lastDate = new Date(series[series.length - 1].date + 'T00:00:00');
    const lastBalance = series[series.length - 1].balance;
    while (lastDate < today) {
      lastDate = new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate() + 1);
      const dateStr = lastDate.getFullYear() + '-' + String(lastDate.getMonth() + 1).padStart(2, '0') + '-' + String(lastDate.getDate()).padStart(2, '0');
      series.push({ date: dateStr, balance: lastBalance });
    }
  }
  return series;
}

function windowSeries(series, rangeMonths) {
  if (!series.length) return series;
  const lastDate = new Date(series[series.length - 1].date + 'T00:00:00');
  const cutoff = new Date(lastDate.getFullYear(), lastDate.getMonth() - rangeMonths, lastDate.getDate());
  return series.filter(p => new Date(p.date + 'T00:00:00') >= cutoff);
}

async function computeGlobalOwed() {
  const byPerson = {};
  for (const k of State.monthsIndex) {
    const data = await loadMonth(k);
    for (const e of data.entries) {
      if (e.type === 'owed' && !e.settled) {
        const name = e.description || 'Unknown';
        byPerson[name] = byPerson[name] || { amount: 0, items: [] };
        byPerson[name].amount += Number(e.amount) || 0;
        byPerson[name].items.push({ amount: e.amount, monthKey: k, source: 'Owed' });
      }
      if (e.type === 'spend' && Array.isArray(e.lent)) {
        for (const l of e.lent) {
          if (l.settled) continue;
          const name = l.person || 'Unknown';
          byPerson[name] = byPerson[name] || { amount: 0, items: [] };
          byPerson[name].amount += Number(l.amount) || 0;
          byPerson[name].items.push({ amount: l.amount, monthKey: k, source: 'Lent · ' + e.description });
        }
      }
    }
  }

  const { owedToYou } = await computeSplitPageData();
  for (const [person, amount] of Object.entries(owedToYou)) {
    if (amount > 0) {
      byPerson[person] = byPerson[person] || { amount: 0, items: [] };
      byPerson[person].amount += amount;
      byPerson[person].items.push({ amount, monthKey: 'Split', source: 'Split Money' });
    }
  }

  const list = Object.entries(byPerson).map(([person, v]) => ({ person, amount: v.amount, items: v.items }))
    .sort((a, b) => b.amount - a.amount);
  const total = list.reduce((s, x) => s + x.amount, 0);
  return { total, list };
}

async function computeGlobalInvestments() {
  const list = [];
  for (const k of State.monthsIndex) {
    const data = await loadMonth(k);
    for (const e of data.entries) {
      if (e.type === 'investment') {
        list.push({ description: e.description, amount: Number(e.amount) || 0, date: e.date, monthKey: k });
      }
    }
  }
  list.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const total = list.reduce((s, x) => s + x.amount, 0);
  return { total, list };
}

async function computeGlobalCardDues() {
  const perCard = {};
  for (const c of State.cards) perCard[c.id] = { card: c, dues: 0 };
  for (const k of State.monthsIndex) {
    const data = await loadMonth(k);
    for (const e of data.entries) {
      if (e.type === 'cardcharge' && e.cardId) {
        perCard[e.cardId] = perCard[e.cardId] || { card: cardById(e.cardId), dues: 0 };
        perCard[e.cardId].dues += Number(e.amount) || 0;
      }
      if (e.type === 'spend' && e.paymentMode === 'card' && e.cardId) {
        perCard[e.cardId] = perCard[e.cardId] || { card: cardById(e.cardId), dues: 0 };
        perCard[e.cardId].dues -= Number(e.amount) || 0;
      }
    }
  }
  const list = Object.values(perCard).filter(x => x.card).map(x => ({ name: x.card.name, dues: x.dues }));
  const total = list.reduce((s, x) => s + x.dues, 0);
  return { total, list };
}

async function computeGlobalStats() {
  const [owed, invested, cardDues, breakdown] = await Promise.all([
    computeGlobalOwed(), computeGlobalInvestments(), computeGlobalCardDues(), computeMonthlyBreakdown()
  ]);
  const amountLeft = breakdown.length ? breakdown[breakdown.length - 1].ending : 0;
  return { owed, invested, cardDues, breakdown, amountLeft };
}

/* ---------- Split Money: settlement engine ---------- */
function computeGroupPaid(group) {
  const paid = {};
  for (const p of group.people) paid[p] = 0;
  for (const s of group.spends) {
    paid[s.payee] = (paid[s.payee] || 0) + (Number(s.amount) || 0);
  }
  return paid;
}

function computeGroupNet(group) {
  const net = {};
  for (const p of group.people) net[p] = 0;
  for (const s of group.spends) {
    net[s.payee] = (net[s.payee] || 0) + (Number(s.amount) || 0);
    for (const [p, amt] of Object.entries(s.shares || {})) {
      net[p] = (net[p] || 0) - (Number(amt) || 0);
    }
  }
  return net;
}

function applySettledAdjustments(net, settlements) {
  const adjusted = { ...net };
  for (const st of (settlements || [])) {
    if (!st.settled) continue;
    adjusted[st.from] = (adjusted[st.from] || 0) + (Number(st.amount) || 0);
    adjusted[st.to] = (adjusted[st.to] || 0) - (Number(st.amount) || 0);
  }
  return adjusted;
}

function greedySettle(net) {
  const creditors = [], debtors = [];
  for (const [p, v] of Object.entries(net)) {
    const r = Math.round(v * 100) / 100;
    if (r > 0.004) creditors.push({ person: p, amt: r });
    else if (r < -0.004) debtors.push({ person: p, amt: -r });
  }
  creditors.sort((a, b) => b.amt - a.amt);
  debtors.sort((a, b) => b.amt - a.amt);
  const transfers = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i], c = creditors[j];
    const amt = Math.round(Math.min(d.amt, c.amt) * 100) / 100;
    if (amt > 0.004) transfers.push({ from: d.person, to: c.person, amount: amt });
    d.amt -= amt; c.amt -= amt;
    if (d.amt <= 0.004) i++;
    if (c.amt <= 0.004) j++;
  }
  return transfers;
}

function computeGroupSettlementView(group) {
  const rawNet = computeGroupNet(group);
  const paid = computeGroupPaid(group);
  const adjustedNet = applySettledAdjustments(rawNet, group.settlements);
  const outstanding = greedySettle(adjustedNet);
  const cards = [];
  for (const st of (group.settlements || [])) {
    if (!st.settled) continue;
    cards.push({ id: st.id, from: st.from, to: st.to, amount: Number(st.amount) || 0, settled: true, ledgerEntryId: st.ledgerEntryId, monthKey: st.monthKey });
  }
  for (const t of outstanding) {
    cards.push({ id: 'virtual-' + t.from + '-' + t.to, from: t.from, to: t.to, amount: t.amount, settled: false });
  }
  return { rawNet, paid, cards };
}

async function computeSplitPageData() {
  const groups = await loadAllSplitGroups();
  let allCards = [];
  for (const g of groups) {
    const { cards } = computeGroupSettlementView(g);
    for (const c of cards) allCards.push({ ...c, groupId: g.id, groupDesc: g.description });
  }
  const owedByYou = {}, owedToYou = {};
  for (const c of allCards) {
    if (c.settled) continue;
    if (c.from === SPLIT_YOU) owedByYou[c.to] = (owedByYou[c.to] || 0) + c.amount;
    if (c.to === SPLIT_YOU) owedToYou[c.from] = (owedToYou[c.from] || 0) + c.amount;
  }
  return { groups, allCards, owedByYou, owedToYou };
}

async function computeGlobalSplitOwedByYou() {
  const { owedByYou } = await computeSplitPageData();
  const list = Object.entries(owedByYou).map(([person, amount]) => ({ person, amount })).sort((a, b) => b.amount - a.amount);
  const total = list.reduce((s, x) => s + x.amount, 0);
  return { total, list };
}

/* ---------- Split Money: ledger sync ---------- */
async function toggleSplitSettlement(groupId, transferId, from, to, amount, groupDesc, willSettle) {
  const group = await loadSplit(groupId);
  if (!group) return;
  group.settlements = group.settlements || [];
  let record = group.settlements.find(s => s.id === transferId);
  
  if (willSettle) {
    if (record && record.settled) return;
    if (!record) {
      record = { id: transferId.startsWith('virtual-') ? uid() : transferId, from, to, amount };
      group.settlements.push(record);
    }
    record.from = from; record.to = to; record.amount = amount;
    
    let ledgerEntryId = null;
    if (from === SPLIT_YOU || to === SPLIT_YOU) {
      const mk = currentMonthKey();
      await ensureMonthIndexed(mk);
      const monthData = await loadMonth(mk);
      let entry;
      if (from === SPLIT_YOU) {
        entry = { id: uid(), type: 'spend', description: `Settled to ${to} - ${groupDesc}`, amount: Number(amount), date: todayStr(), paymentMode: 'cash', cardId: null, tag: '', lent: [] };
      } else {
        entry = { id: uid(), type: 'income', description: `Received settlement from ${from} - ${groupDesc}`, amount: Number(amount), date: todayStr(), category: 'Friends' };
      }
      monthData.entries.push(entry);
      await saveMonth(mk);
      ledgerEntryId = entry.id;
      record.monthKey = mk;
    }
    record.ledgerEntryId = ledgerEntryId;
    record.settled = true;
  } else {
    if (!record || !record.settled) return;
    if (record.ledgerEntryId && record.monthKey) {
      const monthData = await loadMonth(record.monthKey);
      monthData.entries = monthData.entries.filter(e => e.id !== record.ledgerEntryId);
      await saveMonth(record.monthKey);
    }
    record.settled = false;
    delete record.ledgerEntryId;
    delete record.monthKey;
  }
  await saveSplit(groupId);
}

async function settleAllInGroup(group) {
  const { cards } = computeGroupSettlementView(group);
  const outstanding = cards.filter(c => !c.settled);
  for (const c of outstanding) {
    await toggleSplitSettlement(group.id, c.id, c.from, c.to, c.amount, group.description, true);
  }
}

/* ---------- Rendering shell ---------- */
async function render() {
  const app = $('#app');
  const isNewView = State.view !== State.lastView;
  State.lastView = State.view;
  
  if (isNewView) {
    app.classList.remove('no-entrance-anim');
  } else {
    app.classList.add('no-entrance-anim');
  }

  if (State.view === 'home') app.innerHTML = await viewHome();
  else if (State.view === 'cards') app.innerHTML = viewCards();
  else if (State.view === 'months') app.innerHTML = await viewMonthsList();
  else if (State.view === 'month') app.innerHTML = await viewMonth();
  else if (State.view === 'split') app.innerHTML = await viewSplit();

  if (State.view !== 'home') {
    app.insertAdjacentHTML('beforeend', `<button class="fab-home" data-nav="home" title="Back to home" aria-label="Back to home">⌂</button>`);
  }
  app.insertAdjacentHTML('beforeend', `
    <div class="footer-block">
      <p class="privacy-note">Your figures are stored privately and only visible to you.</p>
      <div class="page-footer"><span>Don't you squander now ;)</span></div>
    </div>
  `);
  bindEvents();
  setupScrollWrappers();
}

/* ---------- Reusable horizontal scroll wrapper ---------- */
function scrollWrapper(trackHtml, trackClass = '') {
  return `
  <div class="scroll-wrapper" data-scroll-wrapper>
    <div class="scroll-track ${trackClass}" data-scroll-track>${trackHtml}</div>
    <button class="scroll-arrow left" data-scroll-prev type="button" aria-label="Scroll left" style="display:none;">←</button>
    <button class="scroll-arrow" data-scroll-next type="button" aria-label="Scroll right">→</button>
  </div>`;
}

function setupScrollWrappers() {
  $$('[data-scroll-wrapper]').forEach(w => {
    const track = w.querySelector('[data-scroll-track]');
    const nextArrow = w.querySelector('[data-scroll-next]');
    const prevArrow = w.querySelector('[data-scroll-prev]');
    if (!track) return;
    
    const checkScroll = () => {
      const maxScroll = track.scrollWidth - track.clientWidth;
      if (prevArrow) prevArrow.style.display = track.scrollLeft > 5 ? 'flex' : 'none';
      if (nextArrow) nextArrow.style.display = (maxScroll > 5 && track.scrollLeft < maxScroll - 5) ? 'flex' : 'none';
    };

    track.addEventListener('scroll', checkScroll, { passive: true });
    setTimeout(checkScroll, 50);
  });
}

/* ---------- Stat cards ---------- */
function renderStatCards(stats, splitOwed) {
  const owedPop = stats.owed.list.length
    ? stats.owed.list.map(p => `<div class="pop-row"><span class="pn">${escapeHtml(p.person)}</span><span class="pv" style="color:var(--amber)">${fmtINR(p.amount)}</span></div>`).join('')
    : `<div class="pop-empty">Nobody owes you anything right now.</div>`;

  const investPop = stats.invested.list.length
    ? stats.invested.list.map(i => `<div class="pop-row"><span class="pn">${escapeHtml(i.description)}<span class="ps">${monthKeyShort(i.monthKey)}</span></span><span class="pv" style="color:var(--blue)">${fmtINR(i.amount)}</span></div>`).join('')
    : `<div class="pop-empty">No investments logged yet.</div>`;

  const cardPop = stats.cardDues.list.length
    ? stats.cardDues.list.map(c => `<div class="pop-row"><span class="pn">${escapeHtml(c.name)}</span><span class="pv" style="color:${c.dues > 0 ? 'var(--debit)' : 'var(--credit)'}">${fmtINR(c.dues)}</span></div>`).join('')
    : `<div class="pop-empty">No credit cards added yet.</div>`;

  const balancePop = stats.breakdown.length
    ? stats.breakdown.map(b => `
        <div class="pop-row stacked">
          <div class="pop-line1">${monthKeyShort(b.monthKey)} (<span style="color:var(--credit)">+${fmtINR(b.income)}</span> / <span style="color:var(--debit)">-${fmtINR(b.outflow)}</span>)</div>
          <div class="pop-line2">Start: ${fmtINR(b.starting)}</div>
        </div>`).join('')
    : `<div class="pop-empty">Add a month to see balances here.</div>`;

  const splitOwedCard = splitOwed ? (() => {
    const splitPop = splitOwed.list.length
      ? splitOwed.list.map(p => `<div class="pop-row"><span class="pn">${escapeHtml(p.person)}</span><span class="pv" style="color:var(--debit)">${fmtINR(p.amount)}</span></div>`).join('')
      : `<div class="pop-empty">You're all settled up in Split Money.</div>`;
    return `
    <div class="stat-card owedbyyou" tabindex="0" data-stat-card>
      <div class="stat-back"><div class="pop-title">Who you owe</div>${splitPop}</div>
      <div class="stat-front" data-stat-toggle>
        <div class="label">Owed by you <span class="hoverdot">i</span></div>
        <div class="value" style="color:var(--debit)">${fmtINR(splitOwed.total)}</div>
      </div>
      <div class="stat-popover"><div class="pop-title">Who you owe</div>${splitPop}</div>
    </div>`;
  })() : '';

  const track = `
    <div class="stat-card left" tabindex="0" data-stat-card>
      <div class="stat-back"><div class="pop-title">starting balance + CR - DR</div>${balancePop}</div>
      <div class="stat-front" data-stat-toggle>
        <div class="label">Amount left <span class="hoverdot">i</span></div>
        <div class="value">${fmtINR(stats.amountLeft)}</div>
      </div>
      <div class="stat-popover"><div class="pop-title">starting balance + CR - DR</div>${balancePop}</div>
    </div>
    <div class="stat-card invest" tabindex="0" data-stat-card>
      <div class="stat-back"><div class="pop-title">Every investment</div>${investPop}</div>
      <div class="stat-front" data-stat-toggle>
        <div class="label">Amount invested <span class="hoverdot">i</span></div>
        <div class="value">${fmtINR(stats.invested.total)}</div>
      </div>
      <div class="stat-popover"><div class="pop-title">Every investment</div>${investPop}</div>
    </div>
    <div class="stat-card owed" tabindex="0" data-stat-card>
      <div class="stat-back"><div class="pop-title">Who owes you</div>${owedPop}</div>
      <div class="stat-front" data-stat-toggle>
        <div class="label">Owed to you <span class="hoverdot">i</span></div>
        <div class="value">${fmtINR(stats.owed.total)}</div>
      </div>
      <div class="stat-popover"><div class="pop-title">Who owes you</div>${owedPop}</div>
    </div>
    ${splitOwedCard}
    <div class="stat-card carddues" tabindex="0" data-stat-card>
      <div class="stat-back"><div class="pop-title">By card</div>${cardPop}</div>
      <div class="stat-front" data-stat-toggle>
        <div class="label">Credit card dues <span class="hoverdot">i</span></div>
        <div class="value">${fmtINR(stats.cardDues.total)}</div>
      </div>
      <div class="stat-popover"><div class="pop-title">By card</div>${cardPop}</div>
    </div>`;

  return `
  <div class="scroll-wrapper" data-scroll-wrapper>
    <div class="stats-grid" data-scroll-track>${track}</div>
    <button class="scroll-arrow left" data-scroll-prev type="button" aria-label="Scroll left" style="display:none;">←</button>
    <button class="scroll-arrow" data-scroll-next type="button" aria-label="Scroll right">→</button>
  </div>`;
}

function dailyBalanceChart(series, rangeMonths) {
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
  const dots = coords.map(([x, y], i) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="var(--blue)" opacity="${tickIdxs.includes(i) ? 1 : 0}"><title>${series[i].date}: ${fmtINR(series[i].balance)}</title></circle>`).join('');
  const labels = tickIdxs.map(i => {
    const [x] = coords[i];
    return `<text x="${x.toFixed(1)}" y="${h - 6}" fill="var(--muted)" text-anchor="middle" font-family="IBM Plex Mono, monospace">${tickLabel(series[i])}</text>`;
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

/* ---------- HOME ---------- */
async function renderCurrentMonthCard() {
  const key = currentMonthKey();
  const label = monthKeyLabel(key);
  if (!State.monthsIndex.includes(key)) {
    return `
    <div class="current-month-card empty" data-nav="addmonth">
      <div class="cm-left">
        <div class="cm-eyebrow">This month</div>
        <h3>${label}</h3>
        <div class="cm-sub">You haven't started logging this month yet — tap to begin.</div>
      </div>
    </div>`;
  }
  const data = await loadMonth(key);
  const emiRows = emiRowsForMonth(key, data.deletedEmi);
  const totals = computeMonthTotals(data.entries.concat(emiRows));
  const spends = totals.cashSpend + totals.cardPaymentSpend + totals.cardCharge + totals.emi;
  return `
  <div class="current-month-card" data-open-month="${key}">
    <div class="cm-left">
      <div class="cm-eyebrow">This month</div>
      <h3>${label}</h3>
      <div class="cm-sub">${data.entries.length} ${data.entries.length === 1 ? 'entry' : 'entries'} logged so far · tap to open</div>
    </div>
    <div class="current-month-mini">
      <div class="cm-stat income"><div class="cm-label">Income</div><div class="cm-value">${fmtINR(totals.income)}</div></div>
      <div class="cm-stat spend"><div class="cm-label">Spends</div><div class="cm-value">${fmtINR(spends)}</div></div>
      <div class="cm-stat invest"><div class="cm-label">Invested</div><div class="cm-value">${fmtINR(totals.invest)}</div></div>
    </div>
  </div>`;
}

async function viewHome() {
  const stats = await computeGlobalStats();
  const splitOwed = await computeGlobalSplitOwedByYou();
  const currentMonthCard = await renderCurrentMonthCard();
  const dailySeries = await computeDailyBalanceSeries();
  const windowed = windowSeries(dailySeries, State.balanceChartRange);
  const sinceLabel = dailySeries.length
    ? new Date(dailySeries[0].date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;
  return `
  <div class="topbar">
    <div class="brand" data-nav="home"><span class="mark">₹</span> Ledger &amp; Line</div>
  </div>
  <div class="hero">
    <div class="eyebrow">Personal finance, kept plainly</div>
    <h1>Manage your money <em>(made easy)</em></h1>
    <p>Log what comes in and what goes out, track what's lent, owed and invested — and watch your balance take shape, month by month.</p>
  </div>

  <div class="section" style="margin-top:6px;">
    <div class="section-title"><h2>This month</h2><span class="hint">Your current ledger, at a tap</span></div>
    <div class="current-month-grid">${currentMonthCard}</div>
  </div>

  <div class="section">
    <div class="section-title"><h2>Your finances, at a glance</h2><span class="hint">Hover a card for the breakdown</span></div>
    ${renderStatCards(stats, splitOwed)}
  </div>

  <div class="section">
    <div class="section-title"><h2>Running balance</h2><span class="hint">${sinceLabel ? 'Since ' + sinceLabel : 'Day by day'}</span></div>
    <div class="chart-card">
      <div class="chart-toolbar">
        <div class="range-toggle">
          <button class="range-btn ${State.balanceChartRange === 1 ? 'active' : ''}" data-range="1">1M</button>
          <button class="range-btn ${State.balanceChartRange === 3 ? 'active' : ''}" data-range="3">3M</button>
          <button class="range-btn ${State.balanceChartRange === 6 ? 'active' : ''}" data-range="6">6M</button>
        </div>
      </div>
      ${dailyBalanceChart(windowed, State.balanceChartRange)}
    </div>
  </div>

  <div class="section">
    <div class="section-title"><h2>Money Matters</h2></div>
    ${scrollWrapper(`
      <div class="action-card" data-nav="months">
        <div class="ac-icon">▤</div>
        <h3>Check previous months</h3>
        <p>Revisit any past month — full tables, charts and totals, exactly as recorded.</p>
      </div>
      <div class="action-card" data-nav="cards">
        <div class="ac-icon">▭</div>
        <h3>Manage credit cards</h3>
        <p>Add your cards so card charges and payments are tracked against the right one.</p>
      </div>
      <div class="action-card" data-nav="split">
        <div class="ac-icon">⇄</div>
        <h3>Split Money</h3>
        <p>Track group spends with friends, settle debts, and sync it straight into your ledger.</p>
      </div>
    `)}
  </div>
  `;
}

/* ---------- CREDIT CARDS ---------- */
function viewCards() {
  const rows = State.cards.map(c => `
    <div class="cc-item">
      <div>
        <div class="cc-name">${escapeHtml(c.name)}</div>
        <div class="cc-cycle">Billing date: ${c.billingDay}${ordinalSuffix(c.billingDay)} of the month</div>
      </div>
      <button class="icon-btn" data-del-card="${c.id}" title="Remove card">✕</button>
    </div>
  `).join('') || `<div class="empty-chart">No cards added yet — add one below.</div>`;

  return `
  <div class="topbar">
    <div class="brand" data-nav="home"><span class="mark">₹</span> Ledger &amp; Line</div>
  </div>
  <div class="section">
    <div class="section-title"><h2>Credit cards</h2><span class="hint">Card charges and payments are tracked per card</span></div>
    <div class="card">
      <div class="cc-list">${rows}</div>
      <div class="form-panel">
        <div class="form-row">
          <div class="field"><label>Card description</label><input id="cc-name" type="text" placeholder="e.g. HDFC Regalia" /></div>
          <div class="field"><label>Billing cycle (day of month bill is generated)</label><input id="cc-day" type="number" min="1" max="31" placeholder="e.g. 18" /></div>
        </div>
        <div class="form-actions"><button class="btn" id="cc-add">Add card</button></div>
      </div>
    </div>
  </div>
  `;
}

function ordinalSuffix(n) {
  n = Number(n);
  if (n >= 11 && n <= 13) return 'th';
  switch (n % 10) { case 1: return 'st'; case 2: return 'nd'; case 3: return 'rd'; default: return 'th'; }
}

/* ---------- MONTHS LIST ---------- */
async function viewMonthsList() {
  const keys = [...State.monthsIndex].sort().reverse();
  const breakdown = await computeMonthlyBreakdown();
  const byKey = Object.fromEntries(breakdown.map(b => [b.monthKey, b]));
  let rows = '';
  for (const k of keys) {
    const data = await loadMonth(k);
    const b = byKey[k];
    rows += `
      <div class="month-row" data-open-month="${k}">
        <div>
          <div class="mr-name">${monthKeyLabel(k)}</div>
          <div class="mr-sub">${data.entries.length} ${data.entries.length === 1 ? 'entry' : 'entries'} logged</div>
        </div>
        <div class="mr-val num" style="color:${b.ending >= 0 ? 'var(--credit)' : 'var(--debit)'}">${fmtINR(b.ending)}</div>
      </div>`;
  }
  if (!rows) rows = `<div class="empty-chart">No months recorded yet. Add your first month from the home screen.</div>`;
  return `
  <div class="topbar">
    <div class="brand" data-nav="home"><span class="mark">₹</span> Ledger &amp; Line</div>
  </div>
  <div class="section">
    <div class="section-title"><h2>Previous months</h2><span class="hint">Tap a month to open it</span></div>
    <div class="months-list">${rows}</div>
  </div>
  `;
}

/* ---------- ADD / OPEN MONTH ---------- */
async function promptAddMonth() {
  const key = currentMonthKey();
  await openMonth(key, true);
}

async function openMonth(key, isNew) {
  State.currentMonthKey = key;
  await ensureMonthIndexed(key);
  const data = await loadMonth(key);
  if (isNew && !data._touched) {
    const prevKey = addMonths(key, -1);
    if (State.monthsIndex.includes(prevKey)) {
      data.startingBalanceMode = 'auto';
    } else {
      data.startingBalanceMode = 'manual';
    }
    data._touched = true;
    await saveMonth(key);
  }
  State.view = 'month';
  State.openForm = null;
  await render();
}

/* ---------- MONTH VIEW ---------- */
async function viewMonth() {
  const key = State.currentMonthKey;
  const data = await loadMonth(key);
  const emiRows = emiRowsForMonth(key, data.deletedEmi);
  const allRows = [...data.entries, ...emiRows].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const monthTotals = computeMonthTotals(data.entries.concat(emiRows));

  const stats = await computeGlobalStats();
  const breakdownByKey = Object.fromEntries(stats.breakdown.map(b => [b.monthKey, b]));

  const prevKey = addMonths(key, -1);
  const hasPrev = State.monthsIndex.includes(prevKey) && !!breakdownByKey[prevKey];
  const prevEnding = hasPrev ? breakdownByKey[prevKey].ending : null;
  const mode = data.startingBalanceMode || 'manual';
  const displayedStarting = (mode === 'auto' && hasPrev) ? prevEnding : (Number(data.startingBalance) || 0);

  const dateCounts = {};
  for (const e of allRows) dateCounts[e.date] = (dateCounts[e.date] || 0) + 1;
  const seenDates = new Set();
  const rowsHtml = allRows.map(e => {
    let isFirst = false;
    if (!seenDates.has(e.date)) {
      seenDates.add(e.date);
      isFirst = true;
    }
    return renderRow(e, key, dateCounts[e.date], isFirst);
  }).join('');

  return `
  <div class="topbar">
    <div class="brand" data-nav="home"><span class="mark">₹</span> Ledger &amp; Line</div>
  </div>

  <div class="section">
    <div class="month-header">
      <h1>${monthKeyLabel(key)}</h1>
    </div>
    <div class="balance-box">
      <div class="bb-title">Starting balance</div>
      <div class="radio-row">
        <label class="radio-opt">
          <input type="radio" name="sbmode" value="auto" ${mode === 'auto' ? 'checked' : ''} ${!hasPrev ? 'disabled' : ''} />
          Carry from last month ${hasPrev ? `<span class="bb-computed">(${fmtINR(prevEnding)})</span>` : `<span class="subnote">(no previous month yet)</span>`}
        </label>
        <label class="radio-opt">
          <input type="radio" name="sbmode" value="manual" ${mode === 'manual' ? 'checked' : ''} />
          Set manually
        </label>
        ${mode === 'manual' ? `<input type="number" step="0.01" id="starting-balance-manual" value="${Number(data.startingBalance) || 0}" />` : ''}
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title"><h2>Add an entry</h2><span class="hint">Every entry needs a date</span></div>
    <div class="pill-grid">
      <button class="pill-btn ${State.openForm === 'spend' ? 'active' : ''}" data-form="spend">+ Spend</button>
      <button class="pill-btn alt ${State.openForm === 'cardcharge' ? 'active' : ''}" data-form="cardcharge">+ Credit card spend</button>
      <button class="pill-btn ${State.openForm === 'income' ? 'active' : ''}" data-form="income">+ Income</button>
      <button class="pill-btn ${State.openForm === 'owed' ? 'active' : ''}" data-form="owed">+ Owed to you</button>
      <button class="pill-btn ${State.openForm === 'emi' ? 'active' : ''}" data-form="emi">+ EMI</button>
      <button class="pill-btn ${State.openForm === 'invest' ? 'active' : ''}" data-form="invest">+ Investment</button>
    </div>
    ${State.openForm ? `
    <div id="form-panel-anim-inner" class="${State.formSlideDirection || ''}">
      ${renderForm(State.openForm, key)}
    </div>` : ''}
  </div>

  <div class="section">
    <div class="section-title"><h2>This month's charts</h2><span class="hint">${monthKeyLabel(key)} only</span></div>
    <div class="charts-grid">
      <div class="chart-card">
        <h4>Where it went</h4>
        ${donutChart([
          { label: 'Cash spend', value: monthTotals.cashSpend, color: 'var(--debit)' },
          { label: 'Card bill payments', value: monthTotals.cardPaymentSpend, color: '#C98A3C' },
          { label: 'Card charges (unpaid)', value: monthTotals.cardCharge, color: '#8E6FB0' },
          { label: 'EMI', value: monthTotals.emi, color: '#5B4B9E' },
          { label: 'Investment', value: monthTotals.invest, color: 'var(--blue)' },
        ])}
      </div>
      <div class="chart-card">
        <h4>Income vs expense</h4>
        ${(() => {
          let unsettledMonthLent = 0, unsettledCashLent = 0;
          for (const e of data.entries) {
            if (Array.isArray(e.lent)) {
              const sumUnsettled = e.lent.reduce((s, l) => !l.settled ? s + (Number(l.amount) || 0) : s, 0);
              unsettledMonthLent += sumUnsettled;
              if (e.type === 'spend') unsettledCashLent += sumUnsettled;
            }
          }
          const pureExpense = Math.max(0, monthCashOutflow(monthTotals) - monthTotals.invest - unsettledCashLent);
          
          return barChart([
            { label: 'Income', value: monthTotals.income, color: 'var(--credit)' },
            { label: 'Expense', value: pureExpense, color: 'var(--debit)' },
            { label: 'Invested', value: monthTotals.invest, color: 'var(--blue)' },
            { label: 'Lent', value: unsettledMonthLent, color: 'var(--amber)' }
          ]);
        })()}
      </div>
      <div class="chart-card">
        <h4>Spends by tag</h4>
        ${tagsBarChart(data.entries)}
      </div>
      <div class="chart-card" style="grid-column:1/-1;">
        <h4>Running balance through the month</h4>
        ${lineChart(displayedStarting, data, emiRows)}
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title"><h2>Transactions</h2><span class="hint">${allRows.length} entries</span></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Type</th><th>Details</th><th>Amount</th><th></th></tr></thead>
        <tbody>
          ${allRows.length ? rowsHtml : `<tr class="empty-row"><td colspan="5">No entries yet — add your first spend or income above.</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>

  <div class="section">
    <div class="section-title"><h2>Your finances, at a glance</h2><span class="hint">Same totals as the home page — hover for details</span></div>
    ${renderStatCards(stats)}
  </div>
  `;
}

/* ---------- SPLIT MONEY ---------- */
function splitDonut(segments, emptyMsg) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return `<div class="empty-chart">${emptyMsg}</div>`;
  return donutChart(segments);
}

const SPLIT_PALETTE = ['var(--blue)', '#C98A3C', '#8E6FB0', 'var(--debit)', 'var(--credit)', '#5B4B9E', 'var(--amber)', 'var(--blue-soft)', '#2E7D6B', '#AD4358'];

async function viewSplit() {
  const { groups, allCards, owedByYou, owedToYou } = await computeSplitPageData();

  const oweSegments = Object.entries(owedByYou).map(([person, amount], i) => ({ label: person, value: amount, color: SPLIT_PALETTE[i % SPLIT_PALETTE.length] }));
  const owedSegments = Object.entries(owedToYou).map(([person, amount], i) => ({ label: person, value: amount, color: SPLIT_PALETTE[i % SPLIT_PALETTE.length] }));

  const groupCardsHtml = groups.length
    ? groups.map(g => renderSplitGroupCard(g)).join('')
    : `<div class="empty-chart" style="flex:1 0 100%;">No split groups yet — add one above to get started.</div>`;

  const expandedGroup = State.splitExpandedId ? groups.find(g => g.id === State.splitExpandedId) : null;

  let settleCardsHtml = `<div class="empty-chart" style="flex:1 0 100%;">Tap a group card above to see settlement options.</div>`;
  
  if (expandedGroup) {
    const groupCards = allCards.filter(c => c.groupId === expandedGroup.id);
    settleCardsHtml = groupCards.length
      ? groupCards
          .sort((a, b) => (a.settled === b.settled) ? 0 : (a.settled ? 1 : -1))
          .map(c => renderSplitSettleCard(c)).join('')
      : `<div class="empty-chart" style="flex:1 0 100%;">No debts to settle in this group.</div>`;
  }

  let sharesTableHtml = `
  <div class="section">
    <div class="section-title"><h2>Shares</h2><span class="hint">Total spent per person</span></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Person</th><th>Amount</th></tr></thead>
        <tbody><tr class="empty-row"><td colspan="2">Tap a group card above to see shares.</td></tr></tbody>
      </table>
    </div>
  </div>`;

  if (expandedGroup) {
    const paid = computeGroupPaid(expandedGroup);
    const consumed = {};
    for (const p of expandedGroup.people) consumed[p] = 0;
    for (const s of expandedGroup.spends) {
      for (const [p, amt] of Object.entries(s.shares || {})) {
        consumed[p] = (consumed[p] || 0) + (Number(amt) || 0);
      }
    }

    const shareRows = expandedGroup.people.map(p => {
      const label = p === SPLIT_YOU ? 'YOU' : escapeHtml(p.toUpperCase());
      const amtPaid = paid[p] || 0;
      const amtShare = consumed[p] || 0;
      return `<tr>
        <td>${label}</td>
        <td class="num">${fmtINR(amtPaid)}</td>
        <td class="num">${fmtINR(amtShare)}</td>
      </tr>`;
    }).join('');

    sharesTableHtml = `
    <div class="section">
      <div class="section-title">
        <h2>Shares</h2>
        <span class="hint">Total paid vs. actual share per person in ${escapeHtml(expandedGroup.description)}</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Total Paid</th>
              <th>Total Share (Owed)</th>
            </tr>
          </thead>
          <tbody>
            ${shareRows || `<tr class="empty-row"><td colspan="3">No spends yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  return `
  <div class="topbar">
    <div class="brand" data-nav="home"><span class="mark">₹</span> Ledger &amp; Line</div>
  </div>

  <div class="section">
    <div class="month-header"><h1>Split Money</h1></div>
    <p style="color:var(--muted); max-width:56ch; margin-top:6px;">Track group spends with friends, see who owes what, and settle up — kept completely separate from your personal lent/owed tracking.</p>
  </div>

  <div class="section">
    <div class="section-title"><h2>Add split</h2><span class="hint">Start a new group</span></div>
    <div class="pill-grid">
      <button class="pill-btn ${State.splitFormOpen ? 'active' : ''}" data-split-form-toggle>+ Add Split</button>
    </div>
    ${State.splitFormOpen ? renderSplitAddForm() : ''}
  </div>

  <div class="section">
    <div class="section-title"><h2>Split charts</h2><span class="hint">Isolated from your main ledger</span></div>
    <div class="charts-grid">
      <div class="chart-card">
        <h4>Who I owe how much</h4>
        ${splitDonut(oweSegments, "You don't owe anyone in any split right now.")}
      </div>
      <div class="chart-card">
        <h4>Who owes me how much</h4>
        ${splitDonut(owedSegments, "No one owes you in any split right now.")}
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title"><h2>Groups</h2><span class="hint">Newest first · tap a card for details</span></div>
    ${scrollWrapper(groupCardsHtml)}
    ${expandedGroup ? `
    <div id="split-details-anim-inner" class="${State.splitSlideDirection || ''}">
      ${renderSplitDetailsPanel(expandedGroup)}
    </div>` : ''}
  </div>

  ${sharesTableHtml}

  <div class="section">
    <div class="section-title"><h2>Settle up</h2><span class="hint">Greedy debt-minimized transfers</span></div>
    ${scrollWrapper(settleCardsHtml)}
  </div>
  `;
}

function renderSplitAddForm() {
  return `
  <div class="form-panel">
    <div class="form-row">
      <div class="field"><label>Group description</label><input id="sf-desc" type="text" placeholder="e.g. Goa Trip" /></div>
    </div>
    <div id="sf-members">
      <div class="split-member-row">
        <div class="field"><label>Person 1</label><input class="sf-member" type="text" value="YOU" readonly style="background:var(--ice-2); color:var(--muted); cursor:not-allowed;" /></div>
        <button class="btn small ghost" data-remove-split-member type="button">Remove</button>
      </div>
      <div class="split-member-row">
        <div class="field"><label>Person 2</label><input class="sf-member" type="text" placeholder="Name" /></div>
        <button class="btn small ghost" data-remove-split-member type="button">Remove</button>
      </div>
    </div>
    <button class="btn small ghost" data-add-split-member type="button">+ Add person</button>
    <div class="form-actions">
      <button class="btn primary" data-submit-split type="button">Save split</button>
      <button class="btn ghost" data-close-split-form type="button">Cancel</button>
    </div>
  </div>`;
}

function renderSplitGroupCard(group) {
  const paid = computeGroupPaid(group);
  const dateLabel = group.createdAt ? new Date(group.createdAt + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
  const rows = group.people.map(p => `
    <div class="sgc-person"><span class="spn">${p === SPLIT_YOU ? 'YOU' : escapeHtml(p.toUpperCase())}</span><span class="spv">${fmtINR(paid[p] || 0)}</span></div>`).join('');
  const active = State.splitExpandedId === group.id ? 'active' : '';

  const { cards } = computeGroupSettlementView(group);
  const outstanding = cards.filter(c => !c.settled);
  const isFullySettled = cards.length > 0 && outstanding.length === 0;

  return `
  <div class="split-group-card ${active}" data-split-card="${group.id}">
    <div class="sgc-actions">
      <label class="toggle-switch" title="${isFullySettled ? 'Un-settle all' : 'Settle all'}">
        <input type="checkbox" data-settle-group-toggle="${group.id}" ${isFullySettled ? 'checked' : ''} />
      </label>
      <button class="icon-btn" data-del-split="${group.id}" title="Delete group" type="button">✕</button>
    </div>
    <h4>${escapeHtml(group.description)}</h4>
    <div class="sgc-date">${dateLabel}</div>
    <div class="sgc-people">${rows}</div>
  </div>`;
}

function renderSplitSettleCard(c) {
  const from = c.from === SPLIT_YOU ? 'YOU' : escapeHtml(c.from.toUpperCase());
  const to = c.to === SPLIT_YOU ? 'YOU' : escapeHtml(c.to.toUpperCase());
  return `
  <div class="split-settle-card ${c.settled ? 'settled' : ''}">
    <div class="ssc-group">${escapeHtml(c.groupDesc || '')}</div>
    <div class="ssc-line"><strong>${from}</strong> ${c.from === SPLIT_YOU ? 'pay' : 'pays'} <strong>${to}</strong></div>
    <div class="ssc-amount num">${fmtINR(c.amount)}</div>
    <label class="toggle-switch">
      <input type="checkbox" data-settle-toggle
        data-group-id="${c.groupId}" data-transfer-id="${c.id}"
        data-from="${escapeHtml(c.from)}" data-to="${escapeHtml(c.to)}"
        data-amount="${c.amount}" data-group-desc="${escapeHtml(c.groupDesc || '')}"
        ${c.settled ? 'checked' : ''} />
      ${c.settled ? 'Settled' : 'Mark settled'}
    </label>
  </div>`;
}

function renderSplitShareCallout(group, s){
  const shares = group.people.map(p => ({
    label: p===SPLIT_YOU ? 'YOU' : String(p).toUpperCase(),
    amount: Number((s.shares||{})[p]) || 0
  }));
  const dataAttr = escapeHtml(JSON.stringify(shares));
  return `<span class="split-spend-cell" tabindex="0" data-spend-toggle data-spend-shares="${dataAttr}">${escapeHtml(s.description)}</span>`;
}

function renderSplitDetailsPanel(group) {
  const memberOptions = group.people.map(p => `<option value="${escapeHtml(p)}">${p === SPLIT_YOU ? 'YOU' : escapeHtml(p.toUpperCase())}</option>`).join('');
  
  // Member share fields with toggle placed side-by-side with the input
  const shareInputs = group.people.map(p => {
    const personLabel = p === SPLIT_YOU ? 'YOUR share' : `${escapeHtml(p.toUpperCase())}'s share`;
    return `
    <div class="field split-person-share-box">
      <label>${personLabel} (₹)</label>
      <div style="display:flex; align-items:center; gap:8px;">
        <input class="sp-share" data-person="${escapeHtml(p)}" type="number" step="0.01" min="0" placeholder="0.00" style="flex:1;" />
        <label class="toggle-switch" title="Toggle inclusion in this spend" style="margin:0; flex-shrink:0;">
          <input type="checkbox" class="sp-member-toggle" data-person="${escapeHtml(p)}" checked />
        </label>
      </div>
    </div>`;
  }).join('');

  const sortedSpends = [...group.spends].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const dateCounts = {};
  for (const s of sortedSpends) dateCounts[s.date] = (dateCounts[s.date] || 0) + 1;
  const seenDates = new Set();
  const rowsHtml = sortedSpends.map(s => {
    const dateLabel = s.date ? new Date(s.date + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—';
    let dateCell = '';
    if (!seenDates.has(s.date)) {
      seenDates.add(s.date);
      dateCell = `<td class="dv-date" rowspan="${dateCounts[s.date]}">${dateLabel}</td>`;
    }
    const payeeLabel = s.payee === SPLIT_YOU ? 'YOU' : escapeHtml(String(s.payee).toUpperCase());
    return `<tr>${dateCell}<td>${renderSplitShareCallout(group, s)}</td><td>${payeeLabel}</td><td class="num">${fmtINR(s.amount)}</td><td class="actions-cell"><button class="icon-btn" data-del-split-spend="${group.id}|${s.id}" title="Remove spend">✕</button></td></tr>`;
  }).join('');

  return `
  <div class="split-details-panel" data-split-details="${group.id}">
    <div class="section-title"><h2>${escapeHtml(group.description)}</h2><span class="hint">${group.people.length} people</span></div>

    <div class="form-panel" style="margin-top:14px;">
      <div class="form-row">
        <div class="field"><label>Spend</label><input id="sp-desc" type="text" placeholder="e.g. Dinner" /></div>
        <div class="field"><label>Paid by</label><select id="sp-payee">${memberOptions}</select></div>
        <div class="field"><label>Date</label><input id="sp-date" type="date" value="${todayStr()}" /></div>
        <div class="field"><label>Total amount (₹)</label><input id="sp-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
      </div>
      <div class="split-share-grid">${shareInputs}</div>
      <div class="form-actions">
        <button class="btn primary" data-submit-split-spend="${group.id}" type="button">Add spend</button>
      </div>
    </div>

    <div class="table-wrap" style="margin-top:18px;">
      <table class="divisions-table">
        <thead><tr><th>Date</th><th>Details</th><th>Payee</th><th>Amount</th><th></th></tr></thead>
        <tbody>
          ${rowsHtml || `<tr class="empty-row"><td colspan="5">No spends logged in this group yet.</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>`;
}

function renderRow(e, monthKey, rowspan = 1, isFirstDateRow = true) {
  let dateCell = '';
  if (isFirstDateRow) {
    const dateLabel = e.date ? new Date(e.date + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—';
    dateCell = `<td class="dv-date num" rowspan="${rowspan}">${dateLabel}</td>`;
  }

  if (e.type === 'spend') {
    const card = e.paymentMode === 'card' ? cardById(e.cardId) : null;
    const lentChips = (e.lent || []).map(l => `
      <span class="chip ${l.settled ? 'settled' : ''}">${escapeHtml(l.person)} · ${fmtINR(l.amount)}
        ${!l.settled ? `<button data-settle-lent="${e.id}|${l.id}" title="Mark as paid back">✓</button>` : ''}
      </span>`).join('');
    return `<tr>
      ${dateCell}
      <td><span class="tag spend">Spend</span></td>
      <td>
        <strong>${escapeHtml(e.description)}</strong>${e.tag ? ` <span class="src-badge">${escapeHtml(e.tag)}</span>` : ''}
        <div class="subnote">${card ? 'Paid via ' + escapeHtml(card.name) + ' — reduces card dues' : 'Cash / debit'}</div>
        ${lentChips ? `<div>${lentChips}</div>` : ''}
      </td>
      <td class="num amt-debit">-${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-del-entry="${monthKey}|${e.id}" title="Delete">✕</button></span></td>
    </tr>`;
  }
  if (e.type === 'cardcharge') {
    const card = cardById(e.cardId);
    const lentChips = (e.lent || []).map(l => `
      <span class="chip ${l.settled ? 'settled' : ''}">${escapeHtml(l.person)} · ${fmtINR(l.amount)}
        ${!l.settled ? `<button data-settle-lent="${e.id}|${l.id}" title="Mark as paid back">✓</button>` : ''}
      </span>`).join('');
    return `<tr>
      ${dateCell}
      <td><span class="tag cardcharge">Card spend</span></td>
      <td>
        <strong>${escapeHtml(e.description)}</strong>${e.tag ? ` <span class="src-badge">${escapeHtml(e.tag)}</span>` : ''}
        <div class="subnote">On ${card ? escapeHtml(card.name) : 'a removed card'} — adds to card dues, not deducted from balance</div>
        ${lentChips ? `<div>${lentChips}</div>` : ''}
      </td>
      <td class="num amt-neutral">${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-del-entry="${monthKey}|${e.id}" title="Delete">✕</button></span></td>
    </tr>`;
  }
  if (e.type === 'income') {
    return `<tr>
      ${dateCell}
      <td><span class="tag income">Income</span></td>
      <td><strong>${escapeHtml(e.description)}</strong>${e.category ? ` <span class="src-badge">${escapeHtml(e.category)}</span>` : ''}</td>
      <td class="num amt-credit">+${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-del-entry="${monthKey}|${e.id}" title="Delete">✕</button></span></td>
    </tr>`;
  }
  if (e.type === 'owed') {
    return `<tr>
      ${dateCell}
      <td><span class="tag owed">Owed to you</span></td>
      <td>
        <strong>${escapeHtml(e.description)}</strong>
        ${e.settled ? `<div class="subnote">Settled</div>` : `<div class="subnote">Carries forward until settled</div>`}
      </td>
      <td class="num" style="color:var(--amber)">${fmtINR(e.amount)}</td>
      <td class="actions-cell">
        <span class="row-actions">
          ${!e.settled ? `<button class="icon-btn" data-settle-owed="${monthKey}|${e.id}" title="Mark as paid back">✓</button>` : ''}
          <button class="icon-btn" data-del-entry="${monthKey}|${e.id}" title="Delete">✕</button>
        </span>
      </td>
    </tr>`;
  }
  if (e.type === 'investment') {
    return `<tr>
      ${dateCell}
      <td><span class="tag invest">Investment</span></td>
      <td><strong>${escapeHtml(e.description)}</strong></td>
      <td class="num amt-debit">-${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-del-entry="${monthKey}|${e.id}" title="Delete">✕</button></span></td>
    </tr>`;
  }
  if (e.type === 'emi') {
    return `<tr>
      ${dateCell}
      <td><span class="tag emi">EMI</span></td>
      <td><strong>${escapeHtml(e.description)}</strong><div class="subnote">Installment ${e.installment} of ${e.totalMonths}</div></td>
      <td class="num amt-debit">-${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-del-emi="${monthKey}|${e.seriesId}" title="Remove this month's installment">✕</button></span></td>
    </tr>`;
  }
  return '';
}

/* ---------- Forms ---------- */
function renderTagField() {
  const tags = allSpendTags();
  const options = tags.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  return `
  <div class="field" id="f-tag-wrap">
    <label>Tag</label>
    <select id="f-tag">
      <option value="">No tag</option>
      ${options}
      <option value="__custom__">+ Add custom tag</option>
    </select>
  </div>
  <div class="field" id="f-tag-custom-wrap" style="display:none;">
    <label>New tag name</label>
    <input id="f-tag-custom" type="text" placeholder="e.g. Pets" />
  </div>`;
}

function renderForm(kind, monthKey) {
  if (!kind) return '';
  const cardOptions = State.cards.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if (kind === 'spend') {
    return `
    <div class="form-panel">
      <div class="form-row">
        <div class="field"><label>Spend</label><input id="f-desc" type="text" placeholder="e.g. Groceries" /></div>
        <div class="field"><label>Amount (₹)</label><input id="f-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div class="field"><label>Date</label><input id="f-date" type="date" value="${todayStr()}" /></div>
      </div>
      <div class="form-row">
        <div class="field">
          <label>Mode of payment</label>
          <select id="f-mode">
            <option value="cash">Cash / debit from account</option>
            <option value="card" ${State.cards.length ? '' : 'disabled'}>Credit card (pays off dues)</option>
          </select>
        </div>
        <div class="field" id="f-card-wrap" style="display:none;">
          <label>Card being paid off</label>
          <select id="f-card">${cardOptions || '<option value="">No cards added</option>'}</select>
        </div>
        <div id="f-tag-row" style="display:contents;">
          ${renderTagField()}
        </div>
      </div>
      <div class="form-note" id="f-mode-note" style="display:none;">This pays down the selected card's dues and is subtracted from Amount left, same as a cash spend. It's automatically tagged as "credit card".</div>
      <label class="checkline"><input type="checkbox" id="f-lent-toggle" /> Lent — someone owes me part of this</label>
      <div id="f-lent-wrap" style="display:none;">
        <div class="lent-rows" id="lent-rows">
          <div class="lent-row">
            <div class="field"><label>Person</label><input class="lent-person" type="text" placeholder="Name" /></div>
            <div class="field"><label>Amount (₹)</label><input class="lent-amount" type="number" step="0.01" placeholder="0.00" /></div>
            <button class="btn small ghost" data-add-lent-row type="button">+ Person</button>
          </div>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn" data-submit="spend">Add spend</button>
        <button class="btn ghost" data-close-form>Cancel</button>
      </div>
    </div>`;
  }
  if (kind === 'cardcharge') {
    return `
    <div class="form-panel">
      <div class="form-note" style="margin-top:0;margin-bottom:14px;">Money spent on credit — adds to that card's dues. Doesn't touch your cash balance until you pay it off via a "Spend" entry with mode "Credit card".</div>
      <div class="form-row">
        <div class="field"><label>Spend</label><input id="f-desc" type="text" placeholder="e.g. Dinner out" /></div>
        <div class="field"><label>Amount (₹)</label><input id="f-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div class="field"><label>Date</label><input id="f-date" type="date" value="${todayStr()}" /></div>
      </div>
      <div class="form-row">
        <div class="field">
          <label>Card</label>
          <select id="f-card">${cardOptions || '<option value="">No cards added — add one first</option>'}</select>
        </div>
        <div id="f-tag-row" style="display:contents;">
          ${renderTagField()}
        </div>
      </div>
      <label class="checkline"><input type="checkbox" id="f-lent-toggle" /> Lent — someone owes me part of this</label>
      <div id="f-lent-wrap" style="display:none;">
        <div class="lent-rows" id="lent-rows">
          <div class="lent-row">
            <div class="field"><label>Person</label><input class="lent-person" type="text" placeholder="Name" /></div>
            <div class="field"><label>Amount (₹)</label><input class="lent-amount" type="number" step="0.01" placeholder="0.00" /></div>
            <button class="btn small ghost" data-add-lent-row type="button">+ Person</button>
          </div>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn" data-submit="cardcharge" ${State.cards.length ? '' : 'disabled'}>Add card spend</button>
        <button class="btn ghost" data-close-form>Cancel</button>
      </div>
    </div>`;
  }
  if (kind === 'income') {
    return `
    <div class="form-panel">
      <div class="form-row">
        <div class="field"><label>Source</label><input id="f-desc" type="text" placeholder="e.g. Salary" /></div>
        <div class="field"><label>Amount (₹)</label><input id="f-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div class="field"><label>Date</label><input id="f-date" type="date" value="${todayStr()}" /></div>
      </div>
      <div class="form-row">
        <div class="field">
          <label>Category</label>
          <select id="f-income-category">
            <option value="">No category</option>
            <option value="Salary">Salary</option>
            <option value="Investments">Investments</option>
            <option value="Friends">Friends</option>
          </select>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn" data-submit="income">Add income</button>
        <button class="btn ghost" data-close-form>Cancel</button>
      </div>
    </div>`;
  }
  if (kind === 'owed') {
    return `
    <div class="form-panel">
      <div class="form-row">
        <div class="field"><label>Person</label><input id="f-desc" type="text" placeholder="Who owes you" /></div>
        <div class="field"><label>Amount (₹)</label><input id="f-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div class="field"><label>Date</label><input id="f-date" type="date" value="${todayStr()}" /></div>
      </div>
      <div class="form-note">Carries forward automatically in your totals every month until you mark it settled.</div>
      <div class="form-actions">
        <button class="btn" data-submit="owed">Add</button>
        <button class="btn ghost" data-close-form>Cancel</button>
      </div>
    </div>`;
  }
  if (kind === 'emi') {
    return `
    <div class="form-panel">
      <div class="form-row">
        <div class="field"><label>Description</label><input id="f-desc" type="text" placeholder="e.g. Laptop EMI" /></div>
        <div class="field"><label>Monthly deductible (₹)</label><input id="f-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div class="field"><label>Number of months</label><input id="f-months" type="number" step="1" min="1" placeholder="e.g. 12" /></div>
      </div>
      <div class="form-note">Starts this month (${monthKeyLabel(monthKey)}) and auto-carries forward each month until it's done. You can remove a single month's installment later.</div>
      <div class="form-actions">
        <button class="btn" data-submit="emi">Start EMI</button>
        <button class="btn ghost" data-close-form>Cancel</button>
      </div>
    </div>`;
  }
  if (kind === 'invest') {
    return `
    <div class="form-panel">
      <div class="form-row">
        <div class="field"><label>Description</label><input id="f-desc" type="text" placeholder="e.g. Mutual fund SIP" /></div>
        <div class="field"><label>Amount (₹)</label><input id="f-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div class="field"><label>Date</label><input id="f-date" type="date" value="${todayStr()}" /></div>
      </div>
      <div class="form-actions">
        <button class="btn" data-submit="invest">Add investment</button>
        <button class="btn ghost" data-close-form>Cancel</button>
      </div>
    </div>`;
  }
  return '';
}

/* ---------- Charts ---------- */
function donutChart(segments) {
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
      ${s.label}
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

function barChart(pairs) {
  const max = Math.max(1, ...pairs.map(p => p.value));
  const cols = pairs.map(p => `
    <div class="bar-col">
      <div class="bval num">${fmtINR(p.value)}</div>
      <div class="bar" style="height:${Math.max(4, (p.value / max * 130))}px; background:${p.color};"></div>
      <div class="blabel">${p.label}</div>
    </div>`).join('');
  return `<div class="bars">${cols}</div>`;
}

function tagsBarChart(entries) {
  const totals = {};
  for (const e of entries) {
    if (e.type === 'spend' || e.type === 'cardcharge') {
      const tag = (e.tag && String(e.tag).trim()) ? e.tag : 'Untagged';
      totals[tag] = (totals[tag] || 0) + (Number(e.amount) || 0);
    }
  }
  const pairs = Object.entries(totals).map(([label, value]) => ({ label, value })).filter(p => p.value > 0).sort((a, b) => b.value - a.value);
  if (!pairs.length) return `<div class="empty-chart">No tagged spends yet this month.</div>`;
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

function lineChart(startingBalance, data, emiRows) {
  const entries = [...data.entries, ...emiRows]
    .filter(e => e.type === 'income' || e.type === 'investment' || e.type === 'emi' || (e.type === 'spend' && e.paymentMode !== 'card') || (e.type === 'spend' && e.paymentMode === 'card'))
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
  const dots = coords.map(([x, y], i) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="var(--blue)"><title>${fmtINR(points[i].balance)}</title></circle>`).join('');
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

/* ---------- Event binding ---------- */
function bindEvents() {
  const app = $('#app');
  State.animTimeout = State.animTimeout || null;
  const PILL_ORDER = ['spend', 'cardcharge', 'income', 'owed', 'emi', 'invest'];

  app.onclick = async (ev) => {
    const scrollNext = ev.target.closest('[data-scroll-next]');
    if (scrollNext) {
      const wrapper = scrollNext.closest('[data-scroll-wrapper]');
      const track = wrapper ? wrapper.querySelector('[data-scroll-track]') : null;
      if (track) track.scrollBy({ left: 300, behavior: 'smooth' });
      return;
    }
    const scrollPrev = ev.target.closest('[data-scroll-prev]');
    if (scrollPrev) {
      const wrapper = scrollPrev.closest('[data-scroll-wrapper]');
      const track = wrapper ? wrapper.querySelector('[data-scroll-track]') : null;
      if (track) track.scrollBy({ left: -300, behavior: 'smooth' });
      return;
    }
    const rangeBtn = ev.target.closest('[data-range]');
    if (rangeBtn) {
      State.balanceChartRange = Number(rangeBtn.dataset.range);
      await render();
      return;
    }
    const statToggle = ev.target.closest('[data-stat-toggle]');
    if (statToggle && window.matchMedia('(hover: none)').matches) {
      const card = statToggle.closest('[data-stat-card]');
      const wasOpen = card.classList.contains('open');
      $$('[data-stat-card].open', app).forEach(c => { if (c !== card) c.classList.remove('open'); });
      card.classList.toggle('open', !wasOpen);
      return;
    }
    const statBack = ev.target.closest('.stat-back');
    if (statBack && window.matchMedia('(hover: none)').matches) {
      const card = statBack.closest('[data-stat-card]');
      if (card) card.classList.remove('open');
      return;
    }
    const nav = ev.target.closest('[data-nav]');
    if (nav) {
      const dest = nav.dataset.nav;
      if (dest === 'addmonth') { await promptAddMonth(); return; }
      State.view = dest;
      await render();
      return;
    }
    const openMonthEl = ev.target.closest('[data-open-month]');
    if (openMonthEl) { await openMonth(openMonthEl.dataset.openMonth, false); return; }

    const formBtn = ev.target.closest('[data-form]');
    if (formBtn) {
      const newForm = formBtn.dataset.form;
      const oldForm = State.openForm;
      if (State.animTimeout) clearTimeout(State.animTimeout);

      if (oldForm === newForm) {
        State.openForm = null; 
        render();
        return;
      }
      if (oldForm) {
        const oldIdx = PILL_ORDER.indexOf(oldForm);
        const newIdx = PILL_ORDER.indexOf(newForm);
        const isRight = newIdx > oldIdx;
        const inner = $('#form-panel-anim-inner');
        if (inner) {
          inner.className = isRight ? 'slide-out-left' : 'slide-out-right';
          State.animTimeout = setTimeout(() => {
            State.openForm = newForm;
            State.formSlideDirection = isRight ? 'slide-in-right' : 'slide-in-left';
            render();
          }, 300);
        } else { State.openForm = newForm; State.formSlideDirection = ''; render(); }
        return;
      }
      State.openForm = newForm;
      State.formSlideDirection = '';
      await render();
      return;
    }

    const closeForm = ev.target.closest('[data-close-form]');
    if (closeForm) {
      if (State.animTimeout) clearTimeout(State.animTimeout);
      State.openForm = null; 
      render();
      return;
    }

    const addLentRow = ev.target.closest('[data-add-lent-row]');
    if (addLentRow) {
      const wrap = $('#lent-rows');
      const row = document.createElement('div');
      row.className = 'lent-row';
      row.innerHTML = `
        <div class="field"><label>Person</label><input class="lent-person" type="text" placeholder="Name" /></div>
        <div class="field"><label>Amount (₹)</label><input class="lent-amount" type="number" step="0.01" placeholder="0.00" /></div>
        <button class="btn small ghost" data-remove-lent-row type="button">Remove</button>`;
      wrap.appendChild(row);
      return;
    }
    const removeLentRow = ev.target.closest('[data-remove-lent-row]');
    if (removeLentRow) { removeLentRow.closest('.lent-row').remove(); return; }

    const submitBtn = ev.target.closest('[data-submit]');
    if (submitBtn) { await handleSubmit(submitBtn.dataset.submit); return; }

    const delEntry = ev.target.closest('[data-del-entry]');
    if (delEntry) {
      const [mk, id] = delEntry.dataset.delEntry.split('|');
      const data = await loadMonth(mk);
      
      const entryToDel = data.entries.find(e => e.id === id);
      if (entryToDel && entryToDel.linkedLent) {
        const { spendId, lentId } = entryToDel.linkedLent;
        const originalSpend = data.entries.find(e => e.id === spendId);
        if (originalSpend && originalSpend.lent) {
          const lentChip = originalSpend.lent.find(x => x.id === lentId);
          if (lentChip) lentChip.settled = false;
        }
      }
      
      data.entries = data.entries.filter(e => e.id !== id);
      await saveMonth(mk);
      await render();
      showToast('Entry removed');
      return;
    }
    const delEmi = ev.target.closest('[data-del-emi]');
    if (delEmi) {
      const [mk, seriesId] = delEmi.dataset.delEmi.split('|');
      const data = await loadMonth(mk);
      data.deletedEmi = data.deletedEmi || [];
      if (!data.deletedEmi.includes(seriesId)) data.deletedEmi.push(seriesId);
      await saveMonth(mk);
      await render();
      showToast("Removed this month's installment");
      return;
    }
    const settleOwed = ev.target.closest('[data-settle-owed]');
    if (settleOwed) {
      const [mk, id] = settleOwed.dataset.settleOwed.split('|');
      const data = await loadMonth(mk);
      const entry = data.entries.find(e => e.id === id);
      if (entry && !entry.settled) {
        entry.settled = true;
        data.entries.push({
          id: uid(), type: 'income',
          description: `Payback @${entry.description}`,
          amount: entry.amount, date: todayStr(), category: 'Friends'
        });
      }
      await saveMonth(mk);
      await render();
      showToast('Marked as paid back — added as income');
      return;
    }
    const settleLent = ev.target.closest('[data-settle-lent]');
    if (settleLent) {
      const [entryId, lentId] = settleLent.dataset.settleLent.split('|');
      const mk = State.currentMonthKey;
      const data = await loadMonth(mk);
      const entry = data.entries.find(e => e.id === entryId);
      if (entry) {
        const l = (entry.lent || []).find(x => x.id === lentId);
        if (l && !l.settled) {
          l.settled = true;
          data.entries.push({
            id: uid(), type: 'income',
            description: `Payback @${l.person} - ${entry.description}`,
            amount: l.amount, date: todayStr(), category: 'Friends',
            linkedLent: { spendId: entry.id, lentId: l.id }
          });
        }
      }
      await saveMonth(mk);
      await render();
      showToast('Marked as paid back — added as income');
      return;
    }
    const delCard = ev.target.closest('[data-del-card]');
    if (delCard) {
      State.cards = State.cards.filter(c => c.id !== delCard.dataset.delCard);
      await Store.set('creditcards', State.cards);
      await render();
      showToast('Card removed');
      return;
    }
    const addCard = ev.target.closest('#cc-add');
    if (addCard) {
      const name = $('#cc-name').value.trim();
      const day = Number($('#cc-day').value);
      if (!name || !day || day < 1 || day > 31) { showToast('Enter a card name and a valid billing day (1–31)'); return; }
      State.cards.push({ id: uid(), name, billingDay: day });
      await Store.set('creditcards', State.cards);
      await render();
      showToast('Card added');
      return;
    }

    /* ----- Split Money ----- */
    const splitFormToggle = ev.target.closest('[data-split-form-toggle]');
    if (splitFormToggle) {
      if (State.animTimeout) clearTimeout(State.animTimeout);
      State.splitFormOpen = !State.splitFormOpen;
      await render();
      return;
    }

    const closeSplitForm = ev.target.closest('[data-close-split-form]');
    if (closeSplitForm) {
      if (State.animTimeout) clearTimeout(State.animTimeout);
      State.splitFormOpen = false;
      render();
      return;
    }

    const addSplitMember = ev.target.closest('[data-add-split-member]');
    if (addSplitMember) {
      const wrap = $('#sf-members');
      const idx = wrap.children.length + 1;
      const row = document.createElement('div');
      row.className = 'split-member-row';
      row.innerHTML = `
        <div class="field"><label>Person ${idx}</label><input class="sf-member" type="text" placeholder="Name" /></div>
        <button class="btn small ghost" data-remove-split-member type="button">Remove</button>`;
      wrap.appendChild(row);
      return;
    }
    const removeSplitMember = ev.target.closest('[data-remove-split-member]');
    if (removeSplitMember) { removeSplitMember.closest('.split-member-row').remove(); return; }

    const submitSplit = ev.target.closest('[data-submit-split]');
    if (submitSplit) {
      const desc = ($('#sf-desc').value || '').trim();
      const members = $$('.sf-member').map(i => i.value.trim()).filter(Boolean);
      if (!desc) { showToast('Enter a group description'); return; }
      if (members.length < 2) { showToast('Add at least two people to split with'); return; }
      const seen = new Set();
      const people = [];
      for (const m of members) {
        const key = m.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key); people.push(m);
      }
      await createSplitGroup(desc, people);
      State.splitFormOpen = false;
      await render();
      showToast('Split group created');
      return;
    }

    const delSplitBtn = ev.target.closest('[data-del-split]');
    if (delSplitBtn) {
      const id = delSplitBtn.dataset.delSplit;
      await deleteSplitGroup(id);
      await render();
      showToast('Split group deleted');
      return;
    }

    const spendToggle = ev.target.closest('[data-spend-toggle]');
    if(spendToggle){
      const key = spendToggle.dataset.spendShares;
      if(State.splitCalloutPinned === key){
        hideSplitCallout();
      } else {
        State.splitCalloutPinned = key;
        showSplitCallout(spendToggle);
      }
      return;
    }
    if(!ev.target.closest('#split-share-popover')){
      hideSplitCallout();
    }
	
    const splitCard = ev.target.closest('[data-split-card]');
    if (splitCard && !ev.target.closest('.sgc-actions')) {
      const id = splitCard.dataset.splitCard;
      if (State.animTimeout) clearTimeout(State.animTimeout);

      if (State.splitExpandedId === id) {
        State.splitExpandedId = null; 
        render();
        return;
      }
      if (State.splitExpandedId) {
        const groups = $$('.split-group-card');
        let oldIdx = -1, newIdx = -1;
        groups.forEach((c, i) => {
          if (c.dataset.splitCard === State.splitExpandedId) oldIdx = i;
          if (c.dataset.splitCard === id) newIdx = i;
        });
        const isRight = newIdx > oldIdx;
        const inner = $('#split-details-anim-inner');
        if (inner && oldIdx !== -1 && newIdx !== -1) {
          inner.className = isRight ? 'slide-out-left' : 'slide-out-right';
          State.animTimeout = setTimeout(() => {
            State.splitExpandedId = id;
            State.splitSlideDirection = isRight ? 'slide-in-right' : 'slide-in-left';
            render();
          }, 300);
        } else { State.splitExpandedId = id; State.splitSlideDirection = ''; render(); }
        return;
      }
      State.splitExpandedId = id;
      State.splitSlideDirection = '';
      await render();
      return;
    }
    
    const submitSplitSpend = ev.target.closest('[data-submit-split-spend]');
    if (submitSplitSpend) {
      const groupId = submitSplitSpend.dataset.submitSplitSpend;
      const desc = ($('#sp-desc').value || '').trim();
      const payee = $('#sp-payee').value;
      const date = $('#sp-date').value || todayStr();
      const amount = Number($('#sp-amount').value);
      if (!desc || !amount || amount <= 0) { showToast('Enter a spend description and amount'); return; }
      const shares = {};
      let shareSum = 0;
      $$('.sp-share').forEach(inp => {
        const v = Number(inp.value) || 0;
        shares[inp.dataset.person] = v;
        shareSum += v;
      });
      if (Math.abs(shareSum - amount) > 0.01) {
        showToast('Shares must add up to the total amount');
        return;
      }
      const group = await loadSplit(groupId);
      
      const spendId = uid();
      let ledgerEntryId = null;
      let ledgerMonthKey = null;

      if (payee === SPLIT_YOU) {
        ledgerMonthKey = currentMonthKey();
        await ensureMonthIndexed(ledgerMonthKey);
        const monthData = await loadMonth(ledgerMonthKey);
        
        const entryId = uid();
        const ledgerEntry = {
          id: entryId,
          type: 'spend',
          description: `${desc} (${group.description})`,
          amount: amount,
          date: date,
          paymentMode: 'cash',
          cardId: null,
          tag: 'split',
          lent: []
        };
        monthData.entries.push(ledgerEntry);
        await saveMonth(ledgerMonthKey);
        ledgerEntryId = entryId;
      }

      group.spends.push({ id: spendId, description: desc, payee, amount, date, shares, ledgerEntryId, monthKey: ledgerMonthKey });
      await saveSplit(groupId);
      await render();
      showToast('Spend added to split');
      return;
    }

    const delSplitSpend = ev.target.closest('[data-del-split-spend]');
    if (delSplitSpend) {
      const [groupId, spendId] = delSplitSpend.dataset.delSplitSpend.split('|');
      const group = await loadSplit(groupId);
      if (group) {
        const spend = group.spends.find(s => s.id === spendId);
        if (spend) {
          if (spend.payee === SPLIT_YOU && spend.ledgerEntryId && spend.monthKey) {
            const monthData = await loadMonth(spend.monthKey);
            monthData.entries = monthData.entries.filter(e => e.id !== spend.ledgerEntryId);
            await saveMonth(spend.monthKey);
          }
          group.spends = group.spends.filter(s => s.id !== spendId);
          await saveSplit(groupId);
          await render();
          showToast('Spend removed');
        }
      }
      return;
    }
  };

  app.onchange = async (ev) => {
    if (ev.target.id === 'f-mode') {
      const isCard = ev.target.value === 'card';
      const cardWrap = $('#f-card-wrap');
      if (cardWrap) cardWrap.style.display = isCard ? 'block' : 'none';
      const modeNote = $('#f-mode-note');
      if (modeNote) modeNote.style.display = isCard ? 'block' : 'none';
      
      const tagRow = $('#f-tag-row');
      if (tagRow) tagRow.style.display = isCard ? 'none' : 'contents';
    }
    if (ev.target.id === 'f-tag') {
      const customWrap = $('#f-tag-custom-wrap');
      if (customWrap) customWrap.style.display = ev.target.value === '__custom__' ? 'block' : 'none';
    }
    if (ev.target.id === 'f-lent-toggle') {
      const lentWrap = $('#f-lent-wrap');
      if (lentWrap) lentWrap.style.display = ev.target.checked ? 'block' : 'none';
    }
    if (ev.target.matches('.sp-member-toggle')) {
      const totalAmt = Number($('#sp-amount')?.value) || 0;
      distributeSplitShares(totalAmt);
      return;
    }
    if (ev.target.name === 'sbmode') {
      const mk = State.currentMonthKey;
      const data = await loadMonth(mk);
      data.startingBalanceMode = ev.target.value;
      await saveMonth(mk);
      await render();
    }
    if (ev.target.id === 'starting-balance-manual') {
      const mk = State.currentMonthKey;
      const data = await loadMonth(mk);
      data.startingBalance = Number(ev.target.value) || 0;
      await saveMonth(mk);
      await render();
    }
    if (ev.target.matches('[data-settle-toggle]')) {
      const el = ev.target;
      const groupId = el.dataset.groupId;
      const transferId = el.dataset.transferId;
      const from = el.dataset.from;
      const to = el.dataset.to;
      const amount = Number(el.dataset.amount);
      const groupDesc = el.dataset.groupDesc;
      const willSettle = el.checked;
      await toggleSplitSettlement(groupId, transferId, from, to, amount, groupDesc, willSettle);
      await render();
      showToast(willSettle ? 'Marked as settled — synced to this month\'s ledger' : 'Settlement undone — removed from ledger');
    }
    if (ev.target.matches('[data-settle-group-toggle]')) {
      const groupId = ev.target.dataset.settleGroupToggle;
      const willSettle = ev.target.checked;
      const group = await loadSplit(groupId);
      if (group) {
        if (willSettle) {
          await settleAllInGroup(group);
          showToast('Group settled');
        } else {
          const { cards } = computeGroupSettlementView(group);
          const settled = cards.filter(c => c.settled);
          for (const c of settled) {
            await toggleSplitSettlement(group.id, c.id, c.from, c.to, c.amount, group.description, false);
          }
          showToast('Group un-settled');
        }
        await render();
      }
    }
  };

  app.oninput = (ev) => {
    if (ev.target.id === 'sp-amount') {
      distributeSplitShares(Number(ev.target.value) || 0);
    }
  };
}

function distributeSplitShares(amount) {
  const shareInputs = $$('.sp-share');
  if (!shareInputs.length) return;

  // Filter inputs where the member's toggle is active
  const activeInputs = shareInputs.filter(inp => {
    const toggle = $(`.sp-member-toggle[data-person="${inp.dataset.person}"]`);
    return toggle ? toggle.checked : true;
  });

  // Zero-out and dim inactive member inputs
  const inactiveInputs = shareInputs.filter(inp => !activeInputs.includes(inp));
  inactiveInputs.forEach(inp => {
    inp.value = '0.00';
    inp.disabled = true;
    inp.style.opacity = '0.45';
  });

  const n = activeInputs.length;
  if (n === 0) return;

  activeInputs.forEach(inp => {
    inp.disabled = false;
    inp.style.opacity = '1';
  });

  // Divide total amount evenly among active members with rounding fix
  const baseCents = Math.floor((amount * 100) / n);
  let remainderCents = Math.round(amount * 100) - baseCents * n;

  activeInputs.forEach((inp) => {
    let cents = baseCents;
    if (remainderCents > 0) {
      cents += 1;
      remainderCents -= 1;
    }
    inp.value = (cents / 100).toFixed(2);
  });
}

async function handleSubmit(kind) {
  const mk = State.currentMonthKey;
  const data = await loadMonth(mk);
  const desc = ($('#f-desc')?.value || '').trim();
  const amount = Number($('#f-amount')?.value);
  const date = $('#f-date')?.value || todayStr();

  function collectLent() {
    let lent = [];
    if ($('#f-lent-toggle') && $('#f-lent-toggle').checked) {
      $$('.lent-row').forEach(row => {
        const person = row.querySelector('.lent-person').value.trim();
        const amt = Number(row.querySelector('.lent-amount').value);
        if (person && amt > 0) lent.push({ id: uid(), person, amount: amt, settled: false });
      });
    }
    return lent;
  }

  if (kind === 'spend') {
    if (!desc || !amount || amount <= 0) { showToast('Enter a spend description and amount'); return; }
    const mode = $('#f-mode').value;
    let cardId = null;
    let tag;
    if (mode === 'card') {
      cardId = $('#f-card').value;
      const c = cardById(cardId);
      if (!c) { showToast('Add a credit card first'); return; }
      tag = 'credit card';
    } else {
      tag = await resolveTagFromForm();
    }
    data.entries.push({ id: uid(), type: 'spend', description: desc, amount, date, paymentMode: mode, cardId, tag, lent: collectLent() });
  }
  else if (kind === 'cardcharge') {
    if (!desc || !amount || amount <= 0) { showToast('Enter a spend description and amount'); return; }
    const cardId = $('#f-card').value;
    const c = cardById(cardId);
    if (!c) { showToast('Add a credit card first'); return; }
    const tag = await resolveTagFromForm();
    data.entries.push({ id: uid(), type: 'cardcharge', description: desc, amount, date, cardId, tag, lent: collectLent() });
  }
  else if (kind === 'income') {
    if (!desc || !amount || amount <= 0) { showToast('Enter a source and amount'); return; }
    const category = $('#f-income-category')?.value || '';
    data.entries.push({ id: uid(), type: 'income', description: desc, amount, date, category });
  }
  else if (kind === 'owed') {
    if (!desc || !amount || amount <= 0) { showToast('Enter a person and amount'); return; }
    data.entries.push({ id: uid(), type: 'owed', description: desc, amount, date, settled: false });
  }
  else if (kind === 'invest') {
    if (!desc || !amount || amount <= 0) { showToast('Enter a description and amount'); return; }
    data.entries.push({ id: uid(), type: 'investment', description: desc, amount, date });
  }
  else if (kind === 'emi') {
    const months = Number($('#f-months')?.value);
    if (!desc || !amount || amount <= 0 || !months || months < 1) { showToast('Fill in description, amount and number of months'); return; }
    State.emiSeries.push({ id: uid(), description: desc, monthlyAmount: amount, totalMonths: months, startMonth: mk });
    await Store.set('emiseries', State.emiSeries);
  }

  await saveMonth(mk);
  State.openForm = null;
  await render();
  showToast('Added');
}

/* ---------- Boot ---------- */
(async function init() {
  await loadCore();
  await render();
})();
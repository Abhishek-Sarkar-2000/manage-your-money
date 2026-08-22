/* =========================================================
   MANAGE YOUR MONEY — frontend
   Persistence via a local Flask + SQLite backend (see app.py)
   ========================================================= */

/* ---------- Utilities ---------- */
const $ = (sel, el=document) => el.querySelector(sel);
const $$ = (sel, el=document) => Array.from(el.querySelectorAll(sel));
const uid = () => Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);

function fmtINR(n){
  n = Number(n)||0;
  const neg = n < 0;
  const v = Math.abs(n).toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2});
  return (neg?'-':'') + '₹' + v;
}
function fmtINRShort(n){
  n = Number(n)||0;
  const neg = n < 0;
  const abs = Math.abs(n);
  let val, suffix;
  if(abs >= 1e7){ val = abs/1e7; suffix = 'Cr'; }
  else if(abs >= 1e5){ val = abs/1e5; suffix = 'L'; }
  else if(abs >= 1e3){ val = abs/1e3; suffix = 'K'; }
  else { val = abs; suffix = ''; }
  const str = suffix ? val.toFixed(1).replace(/\.0$/,'') : Math.round(val).toString();
  return (neg?'-':'') + '₹' + str + suffix;
}
// Horizontal gridlines + short-form value labels for the y-axis of a line chart
function yAxisGrid(minV, maxV, w, h, padL, padR, padT, padB, count){
  count = count || 4;
  const range = (maxV - minV) || 1;
  
  // Determine a unified scale/suffix for the entire axis based on the largest absolute value
  const maxAbs = Math.max(Math.abs(maxV), Math.abs(minV));
  let div = 1, suf = '';
  if (maxAbs >= 1e7) { div = 1e7; suf = 'Cr'; }
  else if (maxAbs >= 1e5) { div = 1e5; suf = 'L'; }
  else if (maxAbs >= 1e3) { div = 1e3; suf = 'K'; }

  let out = '';
  for(let i=0; i<=count; i++){
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
    out += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w-padR}" y2="${y.toFixed(1)}" stroke="var(--hair)" stroke-width="1" stroke-dasharray="3,4"/>`;
    // Removed inline font-size so it obeys our CSS counter-scaling
    out += `<text x="${(padL-8).toFixed(1)}" y="${(y+4).toFixed(1)}" fill="var(--muted)" text-anchor="end" font-family="IBM Plex Mono, monospace">${textStr}</text>`;
    out += `</g>`;
  }
  return out;
}
function todayStr(){ return new Date().toISOString().slice(0,10); }
function currentMonthKey(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); }
function monthKeyLabel(key){
  const [y,m] = key.split('-').map(Number);
  const d = new Date(y, m-1, 1);
  return d.toLocaleDateString('en-IN', {month:'long', year:'numeric'});
}
function monthKeyShort(key){
  const [y,m] = key.split('-').map(Number);
  const d = new Date(y, m-1, 1);
  return d.toLocaleDateString('en-IN', {month:'short', year:'2-digit'});
}
function addMonths(key, n){
  let [y,m] = key.split('-').map(Number);
  m += n;
  while(m > 12){ m -= 12; y += 1; }
  while(m < 1){ m += 12; y -= 1; }
  return y + '-' + String(m).padStart(2,'0');
}
function diffMonths(fromKey, toKey){
  const [fy,fm] = fromKey.split('-').map(Number);
  const [ty,tm] = toKey.split('-').map(Number);
  return (ty-fy)*12 + (tm-fm);
}
function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function showToast(msg){
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._h);
  showToast._h = setTimeout(()=>t.classList.remove('show'), 2200);
}

/* ---------- Server-provided config ---------- */
const AppConfig = (() => {
  try{
    return JSON.parse(document.getElementById('app-config')?.textContent || '{}');
  }catch(e){
    console.error('Could not parse app-config', e);
    return {};
  }
})();

/* ---------- Auth ----------
   A signed-out session mid-use (cookie expired, server restarted, etc.)
   surfaces as 401s from the storage API. onAuthRequired() drops us back
   to the signed-out state once, without spamming toasts on every call. */
function onAuthRequired(){
  if(State.isShared) return; // public pages never need a session
  if(!State.user) return;    // already handled
  State.user = null;
  updateProfileBadge();
  showToast('Your session expired — please sign in again.');
  render();
}

/* ---------- Storage layer ----------
   Talks to the local Flask backend (app.py), which persists everything
   per-signed-in-user in a database (money.db locally, or Turso in prod). */
const Store = {
  async get(key, fallback){
    try{
      const res = await fetch('/api/storage/' + encodeURIComponent(key));
      if(res.status === 401){ onAuthRequired(); return fallback; }
      if(res.status === 404) return fallback;
      if(!res.ok) throw new Error('GET failed: ' + res.status);
      const body = await res.json();
      return JSON.parse(body.value);
    }catch(e){
      console.error('storage get failed', key, e);
      showToast('Could not reach the server — is app.py running?');
      return fallback;
    }
  },
  async set(key, value){
    try{
      const res = await fetch('/api/storage/' + encodeURIComponent(key), {
        method: 'PUT',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({value: JSON.stringify(value)})
      });
      if(res.status === 401){ onAuthRequired(); return false; }
      if(!res.ok) throw new Error('PUT failed: ' + res.status);
      return true;
    }catch(e){
      console.error('storage set failed', key, e);
      showToast('Could not save — is app.py running?');
      return false;
    }
  },
  async remove(key){
    try{
      const res = await fetch('/api/storage/' + encodeURIComponent(key), {
        method: 'DELETE'
      });
      if(res.status === 401){ onAuthRequired(); return false; }
      if(!res.ok) throw new Error('DELETE failed: ' + res.status);
      return true;
    }catch(e){
      console.error('storage delete failed', key, e);
      showToast('Could not delete — is app.py running?');
      return false;
    }
  }
};

/* ---------- Spend tags ---------- */
const DEFAULT_TAGS = ["Groceries","Dining","Fuel","Subscription","Rent","Utility","Recharge","Transport","Gift"];

/* ---------- App state ---------- */
const State = {
  view: 'home',
  cards: [],
  emiSeries: [],
  sipSeries: [],
  monthsIndex: [],
  monthCache: {},
  currentMonthKey: null,
  openForm: null,
  balanceChartRange: 1,
  existingInvestments: 0,
  customTags: [],
  splitsIndex: [],
  splitCache: {},
  splitFormOpen: false,
  splitSpendFormOpen: false,
  splitExpandedId: null,
  splitCalloutPinned: null,
  priceTrackDictionary: {},
  priceItems: [],
  priceFormOpen: false,
  priceExpandedId: null,
  priceLogFormOpen: false,
  priceSlideDirection: null,
  isShared: false,
  sharedSplitId: null,
  sharedOwner: null,
  user: null,
};

let googleBtnLocation = null;

async function loadCore(){
  State.cards = await Store.get('creditcards', []);
  State.emiSeries = await Store.get('emiseries', []);
  State.sipSeries = await Store.get('sipseries', []);
  State.monthsIndex = await Store.get('months-index', []);
  State.customTags = await Store.get('custom-spend-tags', []);
  State.splitsIndex = await Store.get('splits-index', []);
  State.existingInvestments = await Store.get('existinginvestments', 0);
  State.priceTrackDictionary = await Store.get('price-track-dict', {});
  State.priceItems = await Store.get('price-items', []);
}

function allSpendTags(){
  const seen = new Set();
  const out = [];
  for(const t of [...DEFAULT_TAGS, ...State.customTags]){
    const key = String(t).trim().toLowerCase();
    if(!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

async function resolveTagFromForm(){
  const sel = $('#f-tag');
  if(!sel) return '';
  let val = sel.value;
  if(val === '__custom__'){
    const custom = ($('#f-tag-custom')?.value || '').trim();
    if(!custom) return '';
    const exists = allSpendTags().some(t => t.toLowerCase() === custom.toLowerCase());
    if(!exists){
      State.customTags.push(custom);
      await Store.set('custom-spend-tags', State.customTags);
    }
    return custom;
  }
  return val;
}
async function loadMonth(key){
  if(State.monthCache[key]) return State.monthCache[key];
  const data = await Store.get('month:'+key, {startingBalanceMode:'manual', startingBalance:0, entries:[], deletedEmi:[], deletedSip:[]});
  if(!data.startingBalanceMode) data.startingBalanceMode = 'manual';
  if(!data.deletedSip) data.deletedSip = [];
  State.monthCache[key] = data;
  return data;
}
async function saveMonth(key){
  await Store.set('month:'+key, State.monthCache[key]);
}
async function ensureMonthIndexed(key){
  if(!State.monthsIndex.includes(key)){
    State.monthsIndex.push(key);
    State.monthsIndex.sort();
    await Store.set('months-index', State.monthsIndex);
  }
}
async function loadAllMonths(){
  const out = {};
  for(const k of [...State.monthsIndex].sort()){
    out[k] = await loadMonth(k);
  }
  return out;
}

/* ---------- Split Money: persistence ---------- */
const SPLIT_YOU = 'YOU';
function getYouLabel(possessive = false) {
  if (State.isShared) {
    const rawName = (State.sharedOwner && State.sharedOwner.name);
    const name = rawName ? rawName.split(' ')[0].toUpperCase() : 'OWNER';
    return possessive ? `${name}'s` : name;
  }
  return possessive ? "YOUR" : "YOU";
}
async function loadSplit(id){
  if(State.isShared){
    // Public split data is fetched once at boot via loadSharedSplit() and
    // never touches the authenticated /api/storage endpoints.
    return State.splitCache[id] || null;
  }
  if(State.splitCache[id]) return State.splitCache[id];
  const data = await Store.get('split:'+id, null);
  if(data){
    data.spends = data.spends || [];
    data.settlements = data.settlements || [];
    data.people = data.people && data.people.length ? data.people : [SPLIT_YOU];
    State.splitCache[id] = data;
  }
  return data;
}
async function loadSharedSplit(){
  try{
    const res = await fetch('/api/public/split/' + encodeURIComponent(State.sharedSplitId));
    if(!res.ok){
      const body = await res.json().catch(() => ({}));
      State.splitCache[State.sharedSplitId] = null;
      State.sharedOwner = null;
      if(body.error) showToast(body.error);
      return;
    }
    const body = await res.json();
    const group = body.group || null;
    if(group){
      group.spends = group.spends || [];
      group.settlements = group.settlements || [];
      group.people = group.people && group.people.length ? group.people : [SPLIT_YOU];
    }
    State.splitCache[State.sharedSplitId] = group;
    State.sharedOwner = body.owner || null;
  }catch(e){
    console.error('failed to load shared split', e);
    State.splitCache[State.sharedSplitId] = null;
    State.sharedOwner = null;
    showToast('Could not load this shared split.');
  }
}
async function saveSplit(id){
  await Store.set('split:'+id, State.splitCache[id]);
}
async function createSplitGroup(description, people){
  const id = 'split_' + uid();
  const group = {id, createdAt: todayStr(), description, people, spends: [], settlements: []};
  State.splitCache[id] = group;
  await Store.set('split:'+id, group);
  State.splitsIndex.push(id);
  await Store.set('splits-index', State.splitsIndex);
  return id;
}
async function deleteSplitGroup(id){
  State.splitsIndex = State.splitsIndex.filter(x=>x!==id);
  await Store.set('splits-index', State.splitsIndex);
  delete State.splitCache[id];
  if(State.splitExpandedId === id) State.splitExpandedId = null;
  await Store.remove('split:' + id);
}
async function loadAllSplitGroups(){
  const groups = [];
  for(const id of State.splitsIndex){
    const g = await loadSplit(id);
    if(g) groups.push(g);
  }
  groups.sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||'') || (b.id||'').localeCompare(a.id||''));
  return groups;
}

/* ---------- Domain helpers ---------- */
function cardById(id){ return State.cards.find(c=>c.id===id); }

function emiRowsForMonth(monthKey, deletedEmi){
  const rows = [];
  for(const series of State.emiSeries){
    const inst = diffMonths(series.startMonth, monthKey) + 1;
    if(inst >= 1 && inst <= series.totalMonths){
      if((deletedEmi||[]).includes(series.id)) continue;
      rows.push({
        id: 'emi-'+series.id+'-'+monthKey, type:'emi', date: monthKey+'-01',
        description: series.description, amount: series.monthlyAmount,
        seriesId: series.id, installment: inst, totalMonths: series.totalMonths
      });
    }
  }
  return rows;
}
function sipRowsForMonth(monthKey, deletedSip){
  const rows = [];
  for(const series of State.sipSeries){
    if(series.startMonth > monthKey) continue; // hasn't started yet
    if((deletedSip||[]).includes(series.id)) continue;
    rows.push({
      id: 'sip-'+series.id+'-'+monthKey, type:'sip', date: monthKey+'-01',
      description: series.description, amount: series.amount,
      seriesId: series.id
    });
  }
  return rows;
}

// Per-month totals — used for that month's own charts only
function computeMonthTotals(entries){
  let income=0, cashSpend=0, cardPaymentSpend=0, cardCharge=0, invest=0, emi=0, sip=0;

  // New Spend Division Trackers
  let regularDebit=0, cashPayments=0, ccSpends=0, others=0;

  for(const e of entries){
    const amt = Number(e.amount)||0;
    if(e.type==='income') {
      income += amt;
    }
    else if(e.type==='spend'){
      if(e.paymentMode==='card') {
        cardPaymentSpend += amt; // Cashflow out (reduces bank balance)
      } else {
        cashSpend += amt; // Cashflow out (reduces bank balance)
        if(e.tag !== 'ATM') regularDebit += amt; // Actual consumption
      }
    }
    else if(e.type==='cardcharge'){
      cardCharge += amt;
      ccSpends += amt; // Actual consumption
    }
    else if(e.type==='cashpayment'){
      cashPayments += amt; // Actual consumption
    }
    else if(e.type==='investment'){
      invest += amt; // Cashflow out
      others += amt;
    }
    else if(e.type==='emi'){
      emi += amt; // Cashflow out
      others += amt;
    }
    else if(e.type==='sip'){
      sip += amt; // Cashflow out (recurring investment)
      others += amt;
    }
  }
  
  // Total actual consumption (ignores internal transfers like ATM and CC dues)
  const totalConsumption = regularDebit + cashPayments + ccSpends + emi;

  return {
    income, cashSpend, cardPaymentSpend, cardCharge, invest, emi, sip,
    regularDebit, cashPayments, ccSpends, others, totalConsumption
  };
}
function monthCashOutflow(totals){
  return totals.cashSpend + totals.cardPaymentSpend + totals.emi + totals.invest + totals.sip;
}

/* ---------- Global (cross-month) computations ---------- */
// Chronological per-month running balance, honouring each month's carry/manual mode.
async function computeMonthlyBreakdown(){
  const sortedKeys = [...State.monthsIndex].sort();
  const rows = [];
  let prevEnding = null;
  for(const k of sortedKeys){
    const data = await loadMonth(k);
    const emiRows = emiRowsForMonth(k, data.deletedEmi);
    const sipRows = sipRowsForMonth(k, data.deletedSip);
    const totals = computeMonthTotals(data.entries.concat(emiRows, sipRows));
    let starting;
    if(data.startingBalanceMode === 'auto' && prevEnding !== null){
      starting = prevEnding;
    } else {
      starting = Number(data.startingBalance)||0;
    }
    const outflow = monthCashOutflow(totals);
    const ending = starting + totals.income - outflow;
    rows.push({monthKey:k, starting, income:totals.income, outflow, ending, totals});
    prevEnding = ending;
  }
  return rows;
}

// Day-by-day running balance, from the 1st of the earliest logged month
// through today, carried flat on days with no transactions.
async function computeDailyBalanceSeries(){
  const breakdown = await computeMonthlyBreakdown();
  if(!breakdown.length) return [];
  const today = new Date(); today.setHours(0,0,0,0);
  const series = [];

  for(const b of breakdown){
    const data = await loadMonth(b.monthKey);
    const emiRows = emiRowsForMonth(b.monthKey, data.deletedEmi);
    const sipRows = sipRowsForMonth(b.monthKey, data.deletedSip);
    const relevant = [...data.entries, ...emiRows, ...sipRows].filter(e =>
      e.type==='income' || e.type==='investment' || e.type==='emi' || e.type==='sip' || e.type==='spend'
    );
    const deltaByDay = {};
    for(const e of relevant){
      if(!e.date) continue;
      const amt = Number(e.amount)||0;
      const signed = e.type==='income' ? amt : -amt;
      deltaByDay[e.date] = (deltaByDay[e.date]||0) + signed;
    }
    const [y,m] = b.monthKey.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    let running = b.starting;
    for(let d=1; d<=daysInMonth; d++){
      const dateObj = new Date(y, m-1, d);
      if(dateObj > today) break;
      const dateStr = y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
      if(deltaByDay[dateStr]) running += deltaByDay[dateStr];
      series.push({date:dateStr, balance:running});
    }
  }

  // Carry flat to today if the latest logged month doesn't reach today
  if(series.length){
    let lastDate = new Date(series[series.length-1].date+'T00:00:00');
    const lastBalance = series[series.length-1].balance;
    while(lastDate < today){
      lastDate = new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate()+1);
      const dateStr = lastDate.getFullYear()+'-'+String(lastDate.getMonth()+1).padStart(2,'0')+'-'+String(lastDate.getDate()).padStart(2,'0');
      series.push({date:dateStr, balance:lastBalance});
    }
  }
  return series;
}

function windowSeries(series, rangeMonths){
  if(!series.length) return series;
  const lastDate = new Date(series[series.length-1].date+'T00:00:00');
  const cutoff = new Date(lastDate.getFullYear(), lastDate.getMonth()-rangeMonths, lastDate.getDate());
  return series.filter(p => new Date(p.date+'T00:00:00') >= cutoff);
}

async function computeGlobalOwed(){
  const byPerson = {}; // name -> {amount, items:[]}
  for(const k of State.monthsIndex){
    const data = await loadMonth(k);
    for(const e of data.entries){
      if(e.type==='owed' && !e.settled){
        const name = e.description || 'Unknown';
        byPerson[name] = byPerson[name] || {amount:0, items:[]};
        byPerson[name].amount += Number(e.amount)||0;
        byPerson[name].items.push({amount:e.amount, monthKey:k, source:'Owed'});
      }
      if(e.type==='spend' && Array.isArray(e.lent)){
        for(const l of e.lent){
          if(l.settled) continue;
          const name = l.person || 'Unknown';
          byPerson[name] = byPerson[name] || {amount:0, items:[]};
          byPerson[name].amount += Number(l.amount)||0;
          byPerson[name].items.push({amount:l.amount, monthKey:k, source:'Lent · '+e.description});
        }
      }
    }
  }

  // Inject "Owed to you" from the Split Money page
  const {owedToYou} = await computeSplitPageData();
  for(const [person, amount] of Object.entries(owedToYou)){
    if(amount > 0){
      byPerson[person] = byPerson[person] || {amount:0, items:[]};
      byPerson[person].amount += amount;
      byPerson[person].items.push({amount, monthKey:'Split', source:'Split Money'});
    }
  }

  const list = Object.entries(byPerson).map(([person, v]) => ({person, amount:v.amount, items:v.items}))
    .sort((a,b)=>b.amount-a.amount);
  const total = list.reduce((s,x)=>s+x.amount,0);
  return {total, list};
}

async function computeGlobalInvestments(){
  let total = Number(State.existingInvestments) || 0;
  const monthlyAggregates = [];

  for(const k of State.monthsIndex){
    const data = await loadMonth(k);
    let monthSum = 0;
    
    // Add manual investments
    for(const e of data.entries){
      if(e.type==='investment') monthSum += Number(e.amount)||0;
    }
    
    // Add executed SIPs
    const sipRows = sipRowsForMonth(k, data.deletedSip);
    for(const s of sipRows){
      monthSum += Number(s.amount)||0;
    }

    if(monthSum > 0){
      monthlyAggregates.push({
        description: 'Investments for', 
        amount: monthSum, 
        monthKey: k
      });
      total += monthSum;
    }
  }

  // Sort monthly aggregates with newest months first
  monthlyAggregates.sort((a,b)=> b.monthKey.localeCompare(a.monthKey));

  const list = [];
  
  // Inject the base amount with a shorter text and no date key
  if (Number(State.existingInvestments) > 0) {
    list.push({
      description: 'Base Portfolio', 
      amount: Number(State.existingInvestments), 
      monthKey: null // Set to null to explicitly hide the date string
    });
  }
  
  list.push(...monthlyAggregates);

  return {total, list};
}

async function computeGlobalCardDues(){
  const perCard = {};
  for(const c of State.cards) perCard[c.id] = {card:c, dues:0};
  for(const k of State.monthsIndex){
    const data = await loadMonth(k);
    for(const e of data.entries){
      if(e.type==='cardcharge' && e.cardId){
        perCard[e.cardId] = perCard[e.cardId] || {card:cardById(e.cardId), dues:0};
        perCard[e.cardId].dues += Number(e.amount)||0;
      }
      if(e.type==='spend' && e.paymentMode==='card' && e.cardId){
        perCard[e.cardId] = perCard[e.cardId] || {card:cardById(e.cardId), dues:0};
        perCard[e.cardId].dues -= Number(e.amount)||0;
      }
    }
  }
  const list = Object.values(perCard).filter(x=>x.card).map(x=>({name:x.card.name, dues:x.dues}));
  const total = list.reduce((s,x)=>s+x.dues,0);
  return {total, list};
}

async function computeGlobalStats(){
  const [owed, invested, cardDues, breakdown] = await Promise.all([
    computeGlobalOwed(), computeGlobalInvestments(), computeGlobalCardDues(), computeMonthlyBreakdown()
  ]);
  const amountLeft = breakdown.length ? breakdown[breakdown.length-1].ending : 0;
  return {owed, invested, cardDues, breakdown, amountLeft};
}

/* ---------- Split Money: greedy settlement engine ---------- */
function computeGroupPaid(group){
  const paid = {};
  for(const p of group.people) paid[p] = 0;
  for(const s of group.spends){
    paid[s.payee] = (paid[s.payee]||0) + (Number(s.amount)||0);
  }
  return paid;
}
function computeGroupNet(group){
  const net = {};
  for(const p of group.people) net[p] = 0;
  for(const s of group.spends){
    net[s.payee] = (net[s.payee]||0) + (Number(s.amount)||0);
    for(const [p, amt] of Object.entries(s.shares||{})){
      net[p] = (net[p]||0) - (Number(amt)||0);
    }
  }
  return net;
}
function applySettledAdjustments(net, settlements){
  const adjusted = {...net};
  for(const st of (settlements||[])){
    if(!st.settled) continue;
    adjusted[st.from] = (adjusted[st.from]||0) + (Number(st.amount)||0);
    adjusted[st.to] = (adjusted[st.to]||0) - (Number(st.amount)||0);
  }
  return adjusted;
}
function greedySettle(net){
  const creditors = [], debtors = [];
  for(const [p,v] of Object.entries(net)){
    const r = Math.round(v*100)/100;
    if(r > 0.004) creditors.push({person:p, amt:r});
    else if(r < -0.004) debtors.push({person:p, amt:-r});
  }
  creditors.sort((a,b)=>b.amt-a.amt);
  debtors.sort((a,b)=>b.amt-a.amt);
  const transfers = [];
  let i=0, j=0;
  while(i<debtors.length && j<creditors.length){
    const d = debtors[i], c = creditors[j];
    const amt = Math.round(Math.min(d.amt, c.amt)*100)/100;
    if(amt > 0.004) transfers.push({from:d.person, to:c.person, amount:amt});
    d.amt -= amt; c.amt -= amt;
    if(d.amt <= 0.004) i++;
    if(c.amt <= 0.004) j++;
  }
  return transfers;
}
// Returns {rawNet, paid, cards} where cards = settled records (from storage) + freshly
// computed outstanding transfers (virtual, unsaved until toggled).
function computeGroupSettlementView(group){
  const rawNet = computeGroupNet(group);
  const paid = computeGroupPaid(group);
  const adjustedNet = applySettledAdjustments(rawNet, group.settlements);
  const outstanding = greedySettle(adjustedNet);
  const cards = [];
  for(const st of (group.settlements||[])){
    if(!st.settled) continue;
    cards.push({id:st.id, from:st.from, to:st.to, amount:Number(st.amount)||0, settled:true, ledgerEntryId:st.ledgerEntryId, monthKey:st.monthKey});
  }
  for(const t of outstanding){
    cards.push({id:'virtual-'+t.from+'-'+t.to, from:t.from, to:t.to, amount:t.amount, settled:false});
  }
  return {rawNet, paid, cards};
}
async function computeSplitPageData(){
  let groups = [];
  if (State.isShared) {
    const singleGroup = await loadSplit(State.sharedSplitId);
    if (singleGroup) groups.push(singleGroup);
  } else {
    groups = await loadAllSplitGroups();
  }
  let allCards = [];
  for(const g of groups){
    const {cards} = computeGroupSettlementView(g);
    for(const c of cards) allCards.push({...c, groupId:g.id, groupDesc:g.description});
  }
  const owedByYou = {}, owedToYou = {};
  for(const c of allCards){
    if(c.settled) continue;
    if(c.from===SPLIT_YOU) owedByYou[c.to] = (owedByYou[c.to]||0) + c.amount;
    if(c.to===SPLIT_YOU) owedToYou[c.from] = (owedToYou[c.from]||0) + c.amount;
  }
  return {groups, allCards, owedByYou, owedToYou};
}
async function computeGlobalSplitOwedByYou(){
  const {owedByYou} = await computeSplitPageData();
  const list = Object.entries(owedByYou).map(([person,amount])=>({person,amount})).sort((a,b)=>b.amount-a.amount);
  const total = list.reduce((s,x)=>s+x.amount,0);
  return {total, list};
}

/* ---------- Split Money: ledger sync (reversible) ---------- */
async function toggleSplitSettlement(groupId, transferId, from, to, amount, groupDesc, willSettle){
  const group = await loadSplit(groupId);
  if(!group) return;
  group.settlements = group.settlements || [];
  let record = group.settlements.find(s=>s.id===transferId);
  
  if(willSettle){
    if(record && record.settled) return;
    if(!record){
      record = {id: transferId.startsWith('virtual-') ? uid() : transferId, from, to, amount};
      group.settlements.push(record);
    }
    record.from = from; record.to = to; record.amount = amount;
    
    let ledgerEntryId = null;
    if(from===SPLIT_YOU || to===SPLIT_YOU){
      const mk = currentMonthKey();
      await ensureMonthIndexed(mk);
      const monthData = await loadMonth(mk);
      let entry;
      if(from===SPLIT_YOU){
        entry = {id:uid(), type:'spend', description:`Settled to ${to} - ${groupDesc}`, amount:Number(amount), date:todayStr(), paymentMode:'cash', cardId:null, tag:'', lent:[]};
      } else {
        entry = {id:uid(), type:'income', description:`Received settlement from ${from} - ${groupDesc}`, amount:Number(amount), date:todayStr(), category:'Friends'};
      }
      monthData.entries.push(entry);
      await saveMonth(mk);
      ledgerEntryId = entry.id;
      record.monthKey = mk;
    }
    record.ledgerEntryId = ledgerEntryId;
    record.settled = true;
  } else {
    if(!record || !record.settled) return;
    if(record.ledgerEntryId && record.monthKey){
      const monthData = await loadMonth(record.monthKey);
      monthData.entries = monthData.entries.filter(e=>e.id!==record.ledgerEntryId);
      await saveMonth(record.monthKey);
    }
    record.settled = false;
    delete record.ledgerEntryId;
    delete record.monthKey;
  }
  await saveSplit(groupId);
}
async function settleAllInGroup(group){
  const {cards} = computeGroupSettlementView(group);
  const outstanding = cards.filter(c=>!c.settled);
  for(const c of outstanding){
    await toggleSplitSettlement(group.id, c.id, c.from, c.to, c.amount, group.description, true);
  }
}

/* ---------- Rendering shell ---------- */
async function render(){
  const app = $('#app');
  
  // Track if we are changing pages or just updating the current one
  const isNewView = State.view !== State.lastView;
  State.lastView = State.view;
  
  if (isNewView) {
    app.classList.remove('no-entrance-anim');
  } else {
    app.classList.add('no-entrance-anim');
  }

  const authBar = document.getElementById('auth-bar');
  const signinBtn = document.getElementById('google-signin-btn');
  if(authBar && signinBtn && signinBtn.parentElement !== authBar){
    authBar.insertBefore(signinBtn, authBar.firstChild);
  }
  const showLoginHero = !State.isShared && !State.user;

  if(showLoginHero) app.innerHTML = viewLoginHero();
  else if(State.view === 'home') app.innerHTML = await viewHome();
  else if(State.view === 'cards') app.innerHTML = viewCards();
  else if(State.view === 'sips') app.innerHTML = viewSips();
  else if(State.view === 'months') app.innerHTML = await viewMonthsList();
  else if(State.view === 'month') app.innerHTML = await viewMonth();
  else if(State.view === 'split') app.innerHTML = await viewSplit();
  else if(State.view === 'pricetrack') app.innerHTML = await viewPriceTrack();

  if(!showLoginHero && State.view !== 'home'){
    app.insertAdjacentHTML('beforeend', `<button class="fab-home" data-nav="home" title="Back to home" aria-label="Back to home">⌂</button>`);
  }
  if(!showLoginHero){
    const footerNote = State.isShared
      ? "You're viewing a read-only, shared Split Money group."
      : "Your figures are stored privately and only visible to you.";
    app.insertAdjacentHTML('beforeend', `
      <div class="footer-block">
        <p class="privacy-note">${footerNote}</p>
        <div class="page-footer"><span>Don't you squander now ;)</span></div>
      </div>
    `);
    app.insertAdjacentHTML(
      'beforeend',
      `<div id="split-share-popover" class="split-row-popover"></div>`
    );
    app.insertAdjacentHTML(
      'beforeend',
      `<div id="del-popover" class="del-popover"></div>`
    );
  }
  bindEvents();
  setupScrollWrappers();
  setupTableScrollIndicators();
  if(showLoginHero && signinBtn){
    const heroSlot = document.getElementById('hero-google-signin-slot');
    if(heroSlot){
      heroSlot.appendChild(signinBtn);
      if(googleBtnLocation !== 'hero'){
        renderGoogleButton(signinBtn, {
          type: 'standard', theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with', logo_alignment: 'left',
          width: '280',
        });
        googleBtnLocation = 'hero';
      }
    }
  } else if(authBar && signinBtn && signinBtn.parentElement === authBar){
    if(googleBtnLocation !== 'corner'){
      renderGoogleButton(signinBtn, {
        type: 'standard', theme: 'outline', size: 'medium', shape: 'pill', text: 'signin_with', logo_alignment: 'left',
        width: '200',
      });
      googleBtnLocation = 'corner';
    }
  }
}

/* ---------- Signed-out landing ---------- */
function viewLoginHero(){
  return `
  <div class="topbar-login">
    <div class="brand-line">
      <div class="brand-login">
        <span class="mark">₹</span>
        <div class="brand-login-text">
          <span class="brand-login-name">LedgerNote</span>
          <div class="eyebrow">Personal finance, kept plainly</div>
        </div>
      </div>
    </div>
    <div class="hero login-hero"> 
      <div class="hero-signin-text">
        <h1>Manage your money <em>(made easy)</em></h1>
        <p>Log what comes in and what goes out, track what's lent, owed and invested, split group spends with friends — all synced privately to your Google account.</p>
      </div>
      <div id="hero-google-signin-slot" class="hero-google-signin-btn"></div>
      <div class="login-hero-note">Your Google account is used only to keep your data yours — sign in to continue.</div>
    </div>
  </div>
  `;
}

/* ---------- Reusable horizontal scroll wrapper ---------- */
function scrollWrapper(trackHtml, trackClass=''){
  return `
  <div class="scroll-wrapper" data-scroll-wrapper>
    <div class="scroll-track ${trackClass}" data-scroll-track>${trackHtml}</div>
    <button class="scroll-arrow left" data-scroll-prev type="button" aria-label="Scroll left" style="display:none;">←</button>
    <button class="scroll-arrow" data-scroll-next type="button" aria-label="Scroll right">→</button>
  </div>`;
}
function setupScrollWrappers(){
  $$('[data-scroll-wrapper]').forEach(w=>{
    const track = w.querySelector('[data-scroll-track]');
    const nextArrow = w.querySelector('[data-scroll-next]');
    const prevArrow = w.querySelector('[data-scroll-prev]');
    if(!track) return;

    const checkScroll = () => {
      const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
      const canScrollLeft = track.scrollLeft > 5;
      const canScrollRight = maxScroll > 5 && track.scrollLeft < maxScroll - 5;

      if (prevArrow) {
        prevArrow.style.display = canScrollLeft ? 'flex' : 'none';
      }

      if (nextArrow) {
        nextArrow.style.display = canScrollRight ? 'flex' : 'none';
      }

      track.classList.toggle('can-scroll-left', canScrollLeft && !canScrollRight);
      track.classList.toggle('can-scroll-right', canScrollRight && !canScrollLeft);
      track.classList.toggle('can-scroll-both', canScrollLeft && canScrollRight);
    };

    track.addEventListener('scroll', checkScroll, { passive: true });

    // Recalculate when the viewport/layout changes.
    const resizeObserver = new ResizeObserver(checkScroll);
    resizeObserver.observe(track);

    // Ensure initial dimensions are available.
    setTimeout(checkScroll, 50);
  });
}
function setupTableScrollIndicators(){
  $$('.table-wrap').forEach(wrap => {
    let shell = wrap.parentElement;

    // Create a non-scrolling visual shell around the table scroller.
    if (!shell || !shell.classList.contains('table-scroll-shell')) {
      shell = document.createElement('div');
      shell.className = 'table-scroll-shell';

      wrap.parentNode.insertBefore(shell, wrap);
      shell.appendChild(wrap);
    }

    const checkScroll = () => {
      const maxScroll = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
      const canScrollLeft = wrap.scrollLeft > 5;
      const canScrollRight =
        maxScroll > 5 &&
        wrap.scrollLeft < maxScroll - 5;

      shell.classList.toggle('can-scroll-left', canScrollLeft);
      shell.classList.toggle('can-scroll-right', canScrollRight);
      shell.classList.toggle(
        'can-scroll-both',
        canScrollLeft && canScrollRight
      );
    };

    wrap.addEventListener('scroll', checkScroll, { passive: true });

    const resizeObserver = new ResizeObserver(checkScroll);
    resizeObserver.observe(wrap);

    setTimeout(checkScroll, 50);
  });
}
/* ---------- Split spend share callout (positioned via JS so it always
   escapes table/scroll-container clipping, regardless of overflow ancestors) ---------- */
function positionSplitCallout(pop, triggerEl){
  const rect = triggerEl.getBoundingClientRect();
  const popWidth = pop.offsetWidth || 260;
  let viewLeft = rect.left;
  if(viewLeft + popWidth > window.innerWidth - 12) {
    viewLeft = Math.max(12, window.innerWidth - popWidth - 12);
  }
  let viewTop = rect.bottom + 6;
  const popHeight = pop.offsetHeight || 0;
  if(popHeight && viewTop + popHeight > window.innerHeight - 12){
    viewTop = rect.top - popHeight - 6; // flip above if there's no room below
  }
  pop.style.left = (viewLeft + window.scrollX) + 'px';
  pop.style.top = (viewTop + window.scrollY) + 'px';
}
function showSplitCallout(triggerEl){
  const pop = $('#split-share-popover');
  if(!pop) return;
  let shares = [];
  try{ shares = JSON.parse(triggerEl.dataset.spendShares || '[]'); }catch(e){ shares = []; }
  const rows = shares.map(sh => `<div class="pop-row"><span class="pn">${escapeHtml(sh.label)}</span><span class="pv">${fmtINR(sh.amount)}</span></div>`).join('');
  pop.innerHTML = `<div class="pop-title">Split breakdown</div>${rows}`;
  pop.classList.add('show');
  positionSplitCallout(pop, triggerEl);
}
function hideSplitCallout(){
  const pop = $('#split-share-popover');
  if(pop) pop.classList.remove('show');
  State.splitCalloutPinned = null;
}
function showDeleteCallout(triggerEl, actionName, id, label = 'Delete?') {
  const pop = $('#del-popover');
  if (!pop) return;
  
  pop.innerHTML = `
    <span style="font-size: 0.9rem; font-weight: 600; color: var(--navy);">${escapeHtml(label)}</span>
    <div style="display: flex; gap: 6px;">
      <button class="icon-btn" data-${actionName}="${id}" style="color: var(--credit);" title="Confirm">✓</button>
      <button class="icon-btn" data-cancel-del style="color: var(--debit);" title="Cancel">✕</button>
    </div>
  `;
  
  pop.classList.add('show');
  
  const rect = triggerEl.getBoundingClientRect();
  const popWidth = pop.offsetWidth || 130; 
  let viewLeft = rect.left - popWidth - 10;
  let viewTop = rect.top + (rect.height / 2) - ((pop.offsetHeight || 44) / 2);
  
  pop.style.left = (viewLeft + window.scrollX) + 'px';
  pop.style.top = (viewTop + window.scrollY) + 'px';
}

function hideDeleteCallout() {
  const pop = $('#del-popover');
  if (pop) pop.classList.remove('show');
}
async function deleteMonth(key) {
  State.monthsIndex = State.monthsIndex.filter(k => k !== key);
  await Store.set('months-index', State.monthsIndex);
  delete State.monthCache[key];
  
  // Overwrite the month data with a blank slate in the database
  await Store.set('month:' + key, {
    startingBalanceMode: 'manual', 
    startingBalance: 0, 
    entries: [], 
    deletedEmi: []
  });
  await Store.remove('month:' + key);
}

/* ---------- Stat cards (shared by Home + Month view) ---------- */
function renderStatCards(stats, splitOwed){
  const owedPop = stats.owed.list.length
    ? stats.owed.list.map(p=>`<div class="pop-row"><span class="pn">${escapeHtml(p.person)}</span><span class="pv" style="color:var(--amber)">${fmtINR(p.amount)}</span></div>`).join('')
    : `<div class="pop-empty">Nobody owes you anything right now.</div>`;

  const investPop = stats.invested.list.length
    ? stats.invested.list.map(i=>`<div class="pop-row"><span class="pn">${escapeHtml(i.description)}${i.monthKey ? `<span class="ps">${monthKeyShort(i.monthKey)}</span>` : ''}</span><span class="pv" style="color:var(--blue)">${fmtINR(i.amount)}</span></div>`).join('')
    : `<div class="pop-empty">No investments logged yet.</div>`;

  const cardPop = stats.cardDues.list.length
    ? stats.cardDues.list.map(c=>`<div class="pop-row"><span class="pn">${escapeHtml(c.name)}</span><span class="pv" style="color:${c.dues>0?'var(--debit)':'var(--credit)'}">${fmtINR(c.dues)}</span></div>`).join('')
    : `<div class="pop-empty">No credit cards added yet.</div>`;

  const balancePop = stats.breakdown.length
    ? stats.breakdown.map(b=>`
        <div class="pop-row stacked">
          <div class="pop-line1">${monthKeyShort(b.monthKey)} (<span style="color:var(--credit)">+${fmtINR(b.income)}</span> / <span style="color:var(--debit)">-${fmtINR(b.outflow)}</span>)</div>
          <div class="pop-line2">Start: ${fmtINR(b.starting)}</div>
        </div>`).join('')
    : `<div class="pop-empty">Add a month to see balances here.</div>`;

  const splitOwedCard = splitOwed ? (() => {
    const splitPop = splitOwed.list.length
      ? splitOwed.list.map(p=>`<div class="pop-row"><span class="pn">${escapeHtml(p.person)}</span><span class="pv" style="color:var(--debit)">${fmtINR(p.amount)}</span></div>`).join('')
      : `<div class="pop-empty">You're all settled up.</div>`;
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
      <div class="stat-back"><div class="pop-title">${stats.invested.title || 'Every investment'}</div>${investPop}</div>
      <div class="stat-front" data-stat-toggle>
        <div class="label">Amount invested <span class="hoverdot">i</span></div>
        <div class="value">${fmtINR(stats.invested.total)}</div>
      </div>
      <div class="stat-popover"><div class="pop-title">${stats.invested.title || 'Every investment'}</div>${investPop}</div>
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

function dailyBalanceChart(series, rangeMonths){
  if(!series.length) return `<div class="empty-chart">Add a month to see your balance trend here.</div>`;
  const w = 900, h = 220, padL = 85, padR = 20, padT = 16, padB = 34;
  const vals = series.map(p=>p.balance);
  const rawMin = Math.min(...vals), rawMax = Math.max(...vals);
  // Pad the range so small month-to-month moves are visible as real slope,
  // rather than always anchoring the axis at zero.
  const span = (rawMax - rawMin) || Math.max(Math.abs(rawMax) * 0.1, 1000);
  const pad = span * 0.18;
  const minV = rawMin - pad, maxV = rawMax + pad;
  const range = (maxV-minV) || 1;
  const stepX = series.length>1 ? (w-padL-padR)/(series.length-1) : 0;
  const coords = series.map((p,i)=>{
    const x = series.length>1 ? padL + i*stepX : (padL+w-padR)/2;
    const y = h - padB - ((p.balance-minV)/range)*(h-padT-padB);
    return [x,y];
  });
  const pathD = coords.map((c,i)=> (i===0?'M':'L')+c[0].toFixed(1)+','+c[1].toFixed(1)).join(' ');
  const areaD = pathD + ` L${coords[coords.length-1][0].toFixed(1)},${h-padB} L${coords[0][0].toFixed(1)},${h-padB} Z`;
  const gridSvg = yAxisGrid(minV, maxV, w, h, padL, padR, padT, padB, 8);

  // Tick selection: 1-month view -> a date every 7 days; 3/6-month view -> one tick per calendar month
  let tickIdxs = [];
  if(rangeMonths === 1){
    for(let i=0; i<series.length; i+=7) tickIdxs.push(i);
  } else {
    let lastMonth = null;
    series.forEach((p,i)=>{ const mk = p.date.slice(0,7); if(mk!==lastMonth){ tickIdxs.push(i); lastMonth=mk; } });
  }
  const tickLabel = (p) => {
    const d = new Date(p.date+'T00:00:00');
    return rangeMonths === 1
      ? d.toLocaleDateString('en-IN', {day:'numeric', month:'short'})
      : d.toLocaleDateString('en-IN', {month:'short', year:'2-digit'});
  };
  const dots = coords.map(([x,y],i)=>`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="var(--blue)" opacity="${tickIdxs.includes(i)?1:0}"><title>${series[i].date}: ${fmtINR(series[i].balance)}</title></circle>`).join('');
  const labels = tickIdxs.map(i => {
    const [x] = coords[i];
    return `<text x="${x.toFixed(1)}" y="${h-6}" fill="var(--muted)" text-anchor="middle" font-family="IBM Plex Mono, monospace">${tickLabel(series[i])}</text>`;
  }).join('');
  const lastPoint = series[series.length-1];
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
/* ---------- Current month quick-access card ---------- */
async function renderCurrentMonthCard(){
  const key = currentMonthKey();
  const label = monthKeyLabel(key);
  if(!State.monthsIndex.includes(key)){
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
  const sipRows = sipRowsForMonth(key, data.deletedSip);
  const totals = computeMonthTotals(data.entries.concat(emiRows, sipRows));
  const spends = totals.totalConsumption;
  return `
  <div class="current-month-card" data-open-month="${key}">
    <div class="cm-left">
      <div class="cm-eyebrow">This month</div>
      <h3>${label}</h3>
      <div class="cm-sub">${data.entries.length} ${data.entries.length===1?'entry':'entries'} logged so far · tap to open</div>
    </div>
    <div class="current-month-mini">
      <div class="cm-stat income"><div class="cm-label">Income</div><div class="cm-value">${fmtINR(totals.income)}</div></div>
      <div class="cm-stat spend"><div class="cm-label">Spends</div><div class="cm-value">${fmtINR(spends)}</div></div>
      <div class="cm-stat invest"><div class="cm-label">Invested</div><div class="cm-value">${fmtINR(totals.invest)}</div></div>
    </div>
  </div>`;
}

/* ---------- HOME ---------- */
async function viewHome(){
  const stats = await computeGlobalStats();
  const splitOwed = await computeGlobalSplitOwedByYou();
  const currentMonthCard = await renderCurrentMonthCard();
  const dailySeries = await computeDailyBalanceSeries();
  const windowed = windowSeries(dailySeries, State.balanceChartRange);
  const sinceLabel = dailySeries.length
    ? new Date(dailySeries[0].date+'T00:00:00').toLocaleDateString('en-IN', {day:'numeric', month:'short', year:'numeric'})
    : null;
  return `
  <div class="topbar">
    <div class="brand" data-nav="home"><span class="mark">₹</span> LedgerNote</div>
  </div>
  <div class="hero">
    <div class="eyebrow">Personal finance, kept plainly : For ${escapeHtml((State.user?.name || '').split(' ')[0])}</div>
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
    <div class="section-title"><h2>Running balance</h2><span class="hint">${sinceLabel ? 'Since '+sinceLabel : 'Day by day'}</span></div>
    <div class="chart-card">
      <div class="chart-toolbar">
        <div class="range-toggle">
          <button class="range-btn ${State.balanceChartRange===1?'active':''}" data-range="1">1M</button>
          <button class="range-btn ${State.balanceChartRange===3?'active':''}" data-range="3">3M</button>
          <button class="range-btn ${State.balanceChartRange===6?'active':''}" data-range="6">6M</button>
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
      <div class="action-card" data-nav="sips">
        <div class="ac-icon">↻</div>
        <h3>Manage SIPs</h3>
        <p>Set up recurring investments so they're auto-tracked every month until you stop them.</p>
      </div>
      <div class="action-card" data-nav="split">
        <div class="ac-icon">⇄</div>
        <h3>Split Money</h3>
        <p>Track group spends with friends, settle debts, and sync it straight into your ledger.</p>
      </div>
      <div class="action-card" data-nav="pricetrack">
        <div class="ac-icon">↗</div>
        <h3>Price Tracker</h3>
        <p>Note down what things cost — groceries, transport, subscriptions — and watch prices move over time.</p>
      </div>
    `, 'money-track')}
  </div>
  `;
}

/* ---------- CREDIT CARDS ---------- */
function viewCards(){
  const rows = State.cards.map(c => `
    <div class="cc-item">
      <div>
        <div class="cc-name">${escapeHtml(c.name)}</div>
        <div class="cc-cycle">Billing date: ${c.billingDay}${ordinalSuffix(c.billingDay)} of the month</div>
      </div>
      <button class="icon-btn" data-popover-trigger data-del-card="${c.id}" title="Remove card">✕</button>
    </div>
  `).join('') || `<div class="empty-chart">No cards added yet — add one below.</div>`;

  return `
  <div class="topbar">
    <div class="brand" data-nav="home"><span class="mark">₹</span> LedgerNote</div>
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
function ordinalSuffix(n){
  n = Number(n);
  if(n>=11 && n<=13) return 'th';
  switch(n%10){ case 1: return 'st'; case 2: return 'nd'; case 3: return 'rd'; default: return 'th'; }
}

/* ---------- SIPs ---------- */
function viewSips(){
  const rows = State.sipSeries.map(s => `
    <div class="cc-item">
      <div>
        <div class="cc-name">${escapeHtml(s.description)}</div>
        <div class="cc-cycle">${fmtINR(s.amount)} / month · started ${monthKeyLabel(s.startMonth)}</div>
      </div>
      <button class="icon-btn" data-popover-trigger data-del-sip-series="${s.id}" title="Delete SIP">✕</button>
    </div>
  `).join('') || `<div class="empty-chart">No SIPs added yet — add one below.</div>`;

  return `
  <div class="topbar">
    <div class="brand" data-nav="home"><span class="mark">₹</span> LedgerNote</div>
  </div>

  <div class="section">
    <div class="section-title"><h2>Existing Investments</h2><span class="hint">Base portfolio built prior to this ledger</span></div>
    <div class="card">
      <div class="form-panel" style="margin-top:0;">
        <div class="form-row" style="align-items: end;">
          <div class="field"><label>Total Existing Amount (₹)</label><input id="ext-invest-amount" type="number" step="0.01" min="0" value="${State.existingInvestments || 0}" /></div>
          <div class="form-actions" style="margin-top:0; margin-bottom:2px;"><button class="btn" id="ext-invest-save">Save Amount</button></div>
        </div>
        <div class="form-note" style="margin-top:8px; margin-bottom:0; border:none;">This amount serves as your base and will be dynamically added to your total investments along with manual entries and SIPs.</div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title"><h2>SIPs</h2><span class="hint">Recurring investments, tracked every month automatically</span></div>
    <div class="card">
      <div class="cc-list">${rows}</div>
      <div class="form-panel">
        <div class="form-note" style="margin-top:0;">Starts this month (${monthKeyLabel(currentMonthKey())}) and recurs every month until you delete it.</div>
        <div class="form-row">
          <div class="field"><label>Description</label><input id="sip-desc" type="text" placeholder="e.g. Nifty Index Fund" /></div>
          <div class="field"><label>Amount (₹ / month)</label><input id="sip-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        </div>
        <div class="form-actions"><button class="btn" id="sip-add">Add SIP</button></div>
      </div>
    </div>
  </div>
  `;
}

/* ---------- MONTHS LIST ---------- */
async function viewMonthsList(){
  const keys = [...State.monthsIndex].sort().reverse();
  const breakdown = await computeMonthlyBreakdown();
  const byKey = Object.fromEntries(breakdown.map(b=>[b.monthKey,b]));
  let rows = '';
  for(const k of keys){
    const data = await loadMonth(k);
    const b = byKey[k];
    rows += `
      <div class="month-row" data-open-month="${k}">
        <div>
          <div class="mr-name">${monthKeyLabel(k)}</div>
          <div class="mr-sub">${data.entries.length} ${data.entries.length===1?'entry':'entries'} logged</div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px;">
          <div class="mr-val num" style="color:${b.ending>=0?'var(--credit)':'var(--debit)'}">${fmtINR(b.ending)}</div>
          <button class="icon-btn" data-popover-trigger data-del-month="${k}" title="Delete month" type="button">✕</button>
        </div>
      </div>`;
  }
  if(!rows) rows = `<div class="empty-chart">No months recorded yet. Add your first month from the home screen.</div>`;
  return `
  <div class="topbar">
    <div class="brand" data-nav="home"><span class="mark">₹</span> LedgerNote</div>
  </div>
  <div class="section">
    <div class="section-title"><h2>Previous months</h2><span class="hint">Tap a month to open it</span></div>
    <div class="months-list">${rows}</div>
  </div>
  `;
}

/* ---------- ADD MONTH (prompt) ---------- */
async function promptAddMonth(){
  const key = currentMonthKey();
  await openMonth(key, true);
}
async function openMonth(key, isNew){
  State.currentMonthKey = key;
  await ensureMonthIndexed(key);
  const data = await loadMonth(key);
  if(isNew && !data._touched){
    const prevKey = addMonths(key, -1);
    if(State.monthsIndex.includes(prevKey)){
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
async function viewMonth(){
  const key = State.currentMonthKey;
  const data = await loadMonth(key);
  const emiRows = emiRowsForMonth(key, data.deletedEmi);
  const sipRows = sipRowsForMonth(key, data.deletedSip);
  
  // Exclude EMIs/SIPs from the table rows so they don't duplicate (since they will be cards now)
  const allRows = [...data.entries].sort((a,b)=> (b.date||'').localeCompare(a.date||''));
  const monthTotals = computeMonthTotals(data.entries.concat(emiRows, sipRows));

  const stats = await computeGlobalStats();

  // Override the global investments with only this month's individual entries
  const monthInvestList = [];
  for(const e of data.entries){
    if(e.type === 'investment'){
      // Set monthKey to null so the redundant month label doesn't clutter the popover
      monthInvestList.push({description: e.description, amount: Number(e.amount)||0, monthKey: null}); 
    }
  }
  for(const s of sipRows){
    monthInvestList.push({description: s.description + ' (SIP)', amount: Number(s.amount)||0, monthKey: null});
  }
  
  stats.invested = {
    total: monthTotals.invest + monthTotals.sip,
    list: monthInvestList,
    title: "This month's investments"
  };

  const breakdownByKey = Object.fromEntries(stats.breakdown.map(b=>[b.monthKey,b]));
  const thisMonthCalc = breakdownByKey[key] || {starting:Number(data.startingBalance)||0};

  const prevKey = addMonths(key, -1);
  const hasPrev = State.monthsIndex.includes(prevKey) && !!breakdownByKey[prevKey];
  const prevEnding = hasPrev ? breakdownByKey[prevKey].ending : null;
  const mode = data.startingBalanceMode || 'manual';
  const displayedStarting = (mode==='auto' && hasPrev) ? prevEnding : (Number(data.startingBalance)||0);

  // Calculate rowspans for grouped dates (now without EMIs)
  const dateCounts = {};
  for(const e of allRows) dateCounts[e.date] = (dateCounts[e.date]||0) + 1;
  const seenDates = new Set();
  const rowsHtml = allRows.map(e => {
    let isFirst = false;
    if(!seenDates.has(e.date)){
      seenDates.add(e.date);
      isFirst = true;
    }
    return renderRow(e, key, dateCounts[e.date], isFirst);
  }).join('');

  // Generate EMI Cards
  const emiCardsHtml = emiRows.length ? `<div class="emi-list" style="margin-bottom: 20px;">` + emiRows.map(e => {
    const totalBill = e.amount * e.totalMonths;
    const totalPaid = e.amount * e.installment;
    const left = e.totalMonths - e.installment;
    return `
    <div class="emi-card">
      <div>
        <h4><span class="tag emi">EMI</span> ${escapeHtml(e.description)}</h4>
        <div class="emi-stats">
          Instalment ${e.installment}/${e.totalMonths}(${left} left) <span style="opacity:0.5; margin:0 4px;"></span></br>Paid ${fmtINR(totalPaid)} of ${fmtINR(totalBill)}
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 16px;">
        <div class="num amt-debit recurring-card">-${fmtINR(e.amount)}</div>
        <button class="icon-btn" data-popover-trigger data-del-emi-series="${e.seriesId}" title="Delete EMI series entirely">✕</button>
      </div>
    </div>`;
  }).join('') + `</div>` : '';

  const sipCardsHtml = sipRows.length ? `<div class="emi-list">` + sipRows.map(e => `
    <div class="emi-card">
      <div>
        <h4>${escapeHtml(e.description)}</h4>
        <div class="emi-stats">Recurring monthly investment</div>
      </div>
      <div style="display: flex; align-items: center; gap: 16px;">
        <div class="num recurring-card">-${fmtINR(e.amount)}</div>
        <button class="icon-btn" data-popover-trigger data-skip-sip="${key}|${e.seriesId}" title="Skip this month">⤵</button>
      </div>
    </div>`
  ).join('') + `</div>` : '';
  
  return `
  <div class="topbar">
    <div class="brand" data-nav="home"><span class="mark">₹</span> LedgerNote</div>
  </div>

  <div class="section">
    <div class="month-header">
      <h1>${monthKeyLabel(key)}</h1>
      <h3 style="margin-bottom: 2px;">Starting balance: ${fmtINR(displayedStarting)}</h3>
    </div>
    <div class="balance-box">
      <div class="balance-set">
        <div class="balance-set-input">
          Set starting balance: 
          <input type="number" step="0.01" id="starting-balance-manual" value="${Number(data.startingBalance)||0}" ${mode === 'auto' ? 'disabled' : ''} style="opacity: ${mode === 'auto' ? '0.5' : '1'}; transition: opacity 0.2s ease;" />
        </div>
        <button class="pill-btn ${mode === 'manual' ? '' : 'active'}" id="toggle-manual-balance-btn" type="button">${mode === 'manual' ? 'Custom starting balance' : 'Carry from last month'}</button>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title"><h2>Add an entry</h2><span class="hint">Log every credit and debit</span></div>
    <div class="pill-grid">
      <button class="pill-btn ${State.openForm==='spend'?'active':''}" data-form="spend">+ Spend</button>
      <button class="pill-btn alt ${State.openForm==='cardcharge'?'active':''}" data-form="cardcharge">+ Credit card spend</button>
      <button class="pill-btn alt ${State.openForm==='cashpayment'?'active':''}" data-form="cashpayment">+ Cash Payments</button>
      <button class="pill-btn ${State.openForm==='income'?'active':''}" data-form="income">+ Income</button>
      <button class="pill-btn ${State.openForm==='owed'?'active':''}" data-form="owed">+ Owed to you</button>
      <button class="pill-btn ${State.openForm==='emi'?'active':''}" data-form="emi">+ EMI</button>
      <button class="pill-btn ${State.openForm==='invest'?'active':''}" data-form="invest">+ Investment</button>
    </div>
    ${State.openForm ? `
    <div id="form-panel-anim-inner" class="${State.formSlideDirection || ''}">
      ${renderForm(State.openForm, key)}
    </div>` : ''}
  </div>
  <div class="section">
    <div class="section-title"><h2>This month's finances, at a glance</h2><span class="hint">Hover a card for the breakdown</span></div>
    ${renderStatCards(stats)}
  </div>
  <div class="section">
    <div class="section-title"><h2>This month's charts</h2><span class="hint">${monthKeyLabel(key)} only</span></div>
    <div class="charts-grid">
      <div class="chart-card" style="min-width: 0; overflow-x: auto;">
        <h4>Spending Breakdown</h4>
        ${donutChart([
          {label:'Regular debit', value:monthTotals.regularDebit, color:'var(--debit)'},
          {label:'Credit card spends', value:monthTotals.ccSpends, color:'#8E6FB0'},
          {label:'Cash payments', value:monthTotals.cashPayments, color:'#C98A3C'},
          {label:'EMI', value:monthTotals.emi, color:'#5B4B9E'},
          {label:'SIP', value:monthTotals.sip, color:'#2E8B77'},
          {label:'Investment', value:monthTotals.invest, color:'var(--blue)'}
        ])}
      </div>
      
      <div class="chart-card" style="min-width: 0; overflow-x: auto;">
        <h4>Income vs expense</h4>
        ${(() => {
          let unsettledMonthLent = 0, unsettledConsumptionLent = 0;
          for (const e of data.entries) {
            if (Array.isArray(e.lent)) {
              const sumUnsettled = e.lent.reduce((s, l) => !l.settled ? s + (Number(l.amount) || 0) : s, 0);
              unsettledMonthLent += sumUnsettled;
              
              // Only offset actual consumption expenses (ignores CC Dues / ATMs)
              if (e.type === 'spend' || e.type === 'cardcharge' || e.type === 'cashpayment') {
                unsettledConsumptionLent += sumUnsettled;
              }
            }
          }
          
          // Calculate pure expense directly from actual consumption
          const pureExpense = Math.max(0, monthTotals.totalConsumption - unsettledConsumptionLent);
          
          return barChart([
            {label:'Income', value:monthTotals.income, color:'var(--credit)'},
            {label:'Expense', value:pureExpense, color:'var(--debit)'},
            {label:'Invested', value:monthTotals.invest + monthTotals.sip, color:'var(--blue)'},
            {label:'Lent', value:unsettledMonthLent, color:'var(--amber)'}
          ]);
        })()}
      </div>
      <div class="chart-card" style="grid-column:1/-1;">
        <h4>Running balance through the month</h4>
        ${lineChart(displayedStarting, data, emiRows.concat(sipRows))}
      </div>
      <div style="grid-column: 1 / -1; margin-top: 8px;">
        <h3 style="font-size: 1.15rem; margin-bottom: 12px; font-weight: 600; font-family: 'Fraunces', serif;">Spends by Tags</h3>
		${scrollWrapper(`
      <div class="chart-card tag-chart-card">
        <h4>Debit by tag</h4>
        ${tagsBarChart(data.entries, 'spend')}
      </div>
      <div class="chart-card tag-chart-card">
        <h4>Credit card spends by tag</h4>
        ${tagsBarChart(data.entries, 'cardcharge')}
      </div>
      <div class="chart-card tag-chart-card">
        <h4>Cash spends by tag</h4>
        ${tagsBarChart(data.entries, 'cashpayment')}
      </div>
      `, 'tags-track')}
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title"><h2>Transactions</h2><span class="hint">${allRows.length} entries</span></div>
    ${emiCardsHtml}
    <div class="table-wrap">
      <table ${allRows.length ? '' : 'style="width: 100%;"'}}>
        <thead><tr><th>Date</th><th>Type</th><th>Details</th><th class="table-numeric">Amount</th><th></th></tr></thead>
        <tbody>
          ${allRows.length ? rowsHtml : `<tr class="empty-row"><td colspan="5">No entries yet — add your first spend or income above.</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>
  ${sipRows.length ? `
  <div class="section">
    <div class="section-title"><h2>SIPs</h2><span class="hint">${sipRows.length} running this month - skip by clicking ⤵</span></div>
    ${sipCardsHtml}
  </div>` : ''}
  `;
}

/* ---------- SPLIT MONEY ---------- */
function splitDonut(segments, emptyMsg){
  const total = segments.reduce((s,x)=>s+x.value,0);
  if(total <= 0) return `<div class="empty-chart">${emptyMsg}</div>`;
  return donutChart(segments);
}
const SPLIT_PALETTE = ['var(--blue)','#C98A3C','#8E6FB0','var(--debit)','var(--credit)','#5B4B9E','var(--amber)','var(--blue-soft)','#2E7D6B','#AD4358'];

function formatChartMoney(value) {
  const amount = Number(value) || 0;
  const abs = Math.abs(amount);

  let formatted;

  if (abs >= 10000000) {
    formatted = (amount / 10000000).toFixed(2) + 'Cr';
  } else if (abs >= 100000) {
    formatted = (amount / 100000).toFixed(2) + 'L';
  } else if (abs >= 1000) {
    formatted = (amount / 1000).toFixed(2) + 'K';
  } else {
    formatted = Math.round(amount).toString();
  }

  // Remove unnecessary trailing zeroes.
  formatted = formatted
    .replace(/(\.\d*?[1-9])0+(?=[A-Za-z]|$)/, '$1')
    .replace(/\.0+(?=[A-Za-z]|$)/, '');

  return `₹${formatted}`;
}


function niceChartStep(maxValue, tickCount = 5) {
  if (!maxValue || maxValue <= 0) {
    return 1;
  }

  const rawStep = maxValue / tickCount;

  const magnitude =
    Math.pow(10, Math.floor(Math.log10(rawStep)));

  const normalized = rawStep / magnitude;

  let niceNormalized;

  if (normalized <= 1) {
    niceNormalized = 1;
  } else if (normalized <= 2) {
    niceNormalized = 2;
  } else if (normalized <= 2.5) {
    niceNormalized = 2.5;
  } else if (normalized <= 5) {
    niceNormalized = 5;
  } else {
    niceNormalized = 10;
  }

  return niceNormalized * magnitude;
}


function buildNiceChartTicks(maxValue, tickCount = 5) {
  const step = niceChartStep(maxValue, tickCount);

  const niceMax =
    Math.ceil(maxValue / step) * step;

  const ticks = [];

  for (
    let value = 0;
    value <= niceMax + step * 0.001;
    value += step
  ) {
    ticks.push(Math.round(value * 100) / 100);
  }

  return {
    ticks,
    max: niceMax
  };
}

function sharedStackedDebtChart(group) {
  const { cards } = computeGroupSettlementView(group);

  // Only outstanding transfers belong in this chart.
  const outstanding = cards.filter(
    c => !c.settled && Number(c.amount) > 0.004
  );

  if (!outstanding.length) {
    return `<div class="empty-chart">No outstanding debts in this group.</div>`;
  }

  // Build:
  // debtor -> creditor -> amount
  const byDebtor = {};

  for (const transfer of outstanding) {
    if (!byDebtor[transfer.from]) {
      byDebtor[transfer.from] = {};
    }

    byDebtor[transfer.from][transfer.to] =
      (byDebtor[transfer.from][transfer.to] || 0) +
      Number(transfer.amount || 0);
  }

  const debtors = Object.entries(byDebtor)
    .map(([debtor, creditors]) => ({
      debtor,
      creditors: Object.entries(creditors)
        .filter(([, amount]) => amount > 0.004)
        .map(([creditor, amount]) => ({
          creditor,
          amount
        }))
    }))
    .filter(x => x.creditors.length);

  if (!debtors.length) {
    return `<div class="empty-chart">No outstanding debts in this group.</div>`;
  }

  // Find every creditor for the legend.
  const allCreditors = [];

  for (const debtor of debtors) {
    for (const { creditor } of debtor.creditors) {
      if (!allCreditors.includes(creditor)) {
        allCreditors.push(creditor);
      }
    }
  }

  // Total outstanding amount for each debtor.
  const debtorTotals = debtors.map(({ debtor, creditors }) => ({
    debtor,
    creditors,
    total: creditors.reduce(
      (sum, item) => sum + Number(item.amount || 0),
      0
    )
  }));

  // The longest bar represents 100% of the chart width.
  const actualMaxTotal = Math.max(
    1,
    ...debtorTotals.map(item => item.total)
  );
  
  const debtAxis = buildNiceChartTicks(actualMaxTotal, 4);
  const maxTotal = debtAxis.max;

  /*
   * Use five responsive x-axis intervals:
   *
   * 0%
   * 25%
   * 50%
   * 75%
   * 100%
   *
   * The actual monetary scale is based on the largest debtor.
   */

  const xTicks = debtAxis.ticks.map(value => ({
    value,
    percent:
      debtAxis.max > 0
        ? (value / debtAxis.max) * 100
        : 0
  }));

  const gridLines = xTicks
    .map(
      tick => `
        <div
          class="shared-debt-grid-line"
          style="left:${tick.percent}%"
        ></div>
      `
    )
    .join('');

  const xLabels = xTicks
    .map(
      tick => `
        <span
          class="shared-debt-x-tick"
          style="left:${tick.percent}%"
        >
          ${formatChartMoney(tick.value)}
        </span>
      `
    )
    .join('');

  const bars = debtorTotals
    .map(({ debtor, creditors, total }) => {

      /*
       * IMPORTANT:
       *
       * The complete bar width is now proportional to the
       * debtor's total outstanding amount relative to maxTotal.
       *
       * Individual stacked segments then divide that bar
       * according to the creditor amounts.
       */
      const totalWidth =
	    maxTotal > 0
	      ? (total / maxTotal) * 100
	      : 0;

      const segments = creditors
        .map(({ creditor, amount }) => {
          const color =
            SPLIT_PALETTE[
              allCreditors.indexOf(creditor) % SPLIT_PALETTE.length
            ];

          const segmentWidth =
            total > 0
              ? (amount / total) * 100
              : 0;

          const creditorLabel =
            creditor === SPLIT_YOU
              ? getYouLabel()
              : escapeHtml(String(creditor).toUpperCase());

          return `
            <div
              class="shared-debt-segment"
              style="
                width:${segmentWidth}%;
                background:${color};
              "
              title="${creditorLabel}: ${fmtINR(amount)}"
            ></div>
          `;
        })
        .join('');

      const debtorLabel =
        debtor === SPLIT_YOU
          ? getYouLabel()
          : escapeHtml(String(debtor).toUpperCase());

      const isInside = totalWidth > 50;

      return `
        <div class="shared-debt-row">

          <div
            class="shared-debt-label"
            title="${debtorLabel}"
          >
            ${debtorLabel}
          </div>

          <div class="shared-debt-plot">

            <div class="shared-debt-grid">
              ${gridLines}
            </div>

            <div
              class="shared-debt-bar"
              style="width:${totalWidth}%; --bar-end:${totalWidth}%"
            >
              ${segments}
              
              <!-- INSIDE: Rendered only if > 50% -->
              ${isInside ? `<div class="shared-debt-total inside num">${fmtINR(total)}</div>` : ''}
            </div>

            <!-- OUTSIDE: Rendered only if <= 50% -->
            ${!isInside ? `<div class="shared-debt-total outside num" style="left:${totalWidth}%;">${fmtINR(total)}</div>` : ''}

          </div>

        </div>
      `;
    })
    .join('');

  const legend = allCreditors
    .map((creditor, i) => {
      const color = SPLIT_PALETTE[i % SPLIT_PALETTE.length];

      const label =
        creditor === SPLIT_YOU
          ? getYouLabel()
          : escapeHtml(String(creditor).toUpperCase());

      return `
        <div class="shared-chart-legend-item">
          <span
            class="shared-chart-legend-dot"
            style="background:${color};"
          ></span>

          <span>${label}</span>
        </div>
      `;
    })
    .join('');

  return `
    <div class="shared-debt-chart">

      <div class="shared-debt-bars">
        ${bars}
      </div>

      <div class="shared-debt-axis">

        <div class="shared-debt-axis-line"></div>

        ${xLabels}

      </div>

      <div class="shared-chart-axis-title">
        Amount (₹)
      </div>

      <div class="shared-chart-legend">
        ${legend}
      </div>

    </div>
  `;
}


function sharedSharesBarChart(group) {
  const totals = {};

  for (const person of group.people) {
    totals[person] = 0;
  }

  for (const spend of (group.spends || [])) {
    for (const [person, amount] of Object.entries(spend.shares || {})) {
      totals[person] =
        (totals[person] || 0) + (Number(amount) || 0);
    }
  }

  const pairs = Object.entries(totals)
    .map(([person, value]) => ({
      person,
      value: Math.round(value * 100) / 100
    }))
    .filter(x => x.value > 0.004)
    .sort((a, b) => b.value - a.value);

  if (!pairs.length) {
    return `<div class="empty-chart">No shares recorded in this group yet.</div>`;
  }

  /*
   * The y-axis is scaled against the largest member share.
   *
   * Five responsive ticks:
   * 0
   * 25%
   * 50%
   * 75%
   * 100%
   */
  const actualMaxValue = Math.max(
    1,
    ...pairs.map(x => x.value)
  );
  
  const shareAxis =
    buildNiceChartTicks(actualMaxValue, 4);
  
  const maxValue = shareAxis.max;
  
  const yTicks = shareAxis.ticks.map(value => ({
    value,
    percent:
      shareAxis.max > 0
        ? (value / shareAxis.max) * 100
        : 0
  }));

  /*
   * Grid lines are positioned from the bottom:
   *
   * 0%  -> bottom
   * 25% -> 75% from top
   * 50% -> 50% from top
   * 75% -> 25% from top
   * 100% -> top
   */
  const gridLines = yTicks
    .map(tick => {
      const bottom = tick.percent;

      return `
        <div
          class="shared-share-grid-line"
          style="bottom:${bottom}%"
        ></div>
      `;
    })
    .join('');

  const yLabels = yTicks
    .map(tick => {
      const bottom = tick.percent;

      return `
        <span
          class="shared-share-y-tick"
          style="bottom:${bottom}%"
        >
          ${formatChartMoney(tick.value)}
        </span>
      `;
    })
    .join('');

  const bars = pairs
    .map((pair, i) => {
      const height =
        maxValue > 0
          ? (pair.value / maxValue) * 100
          : 0;

      const label =
        pair.person === SPLIT_YOU
          ? getYouLabel()
          : escapeHtml(String(pair.person).toUpperCase());

      const color = SPLIT_PALETTE[i % SPLIT_PALETTE.length];
      const isInside = height > 50;
      const formattedValue = fmtINR(pair.value);

      return `
        <div class="shared-share-bar-col">
          <div class="shared-share-bar-area">
            
            <div
              class="shared-share-bar"
              style="height:${height}%; background:${color};"
              title="${label}: ${formattedValue}"
            >
              <!-- Value inside if > 50% -->
              ${isInside ? `
              <div class="shared-share-value-wrap inside">
                <div class="shared-share-value-text num">${formattedValue}</div>
              </div>` : ''}
            </div>

            <!-- Value outside if <= 50% -->
            ${!isInside ? `
            <div class="shared-share-value-wrap outside" style="bottom:${height}%;">
              <div class="shared-share-value-text num">${formattedValue}</div>
            </div>` : ''}

          </div>
        </div>
      `;
    })
    .join('');

  // The labels remain separated at the bottom as you requested previously
  const labels = pairs
    .map((pair) => {
      const label = pair.person === SPLIT_YOU ? getYouLabel() : escapeHtml(String(pair.person).toUpperCase());
      return `<div class="shared-share-label" title="${label}">${label}</div>`;
    })
    .join('');

  return `
    <div class="shared-share-chart">

      <div class="shared-share-y-axis">
        ${yLabels}
      </div>

      <div class="shared-share-plot">
        <div class="shared-share-grid">
          ${gridLines}
        </div>
        <div class="shared-share-bars">
          ${bars}
        </div>
        <div class="shared-share-axis-line"></div>
      </div>
      
      <div class="shared-share-corner"></div>

      <!-- Labels stay outside the plot -->
      <div class="shared-share-x-labels">
        ${labels}
      </div>

    </div>

    <div class="shared-share-axis-title">
      Total Share (₹)
    </div>
  `;
}


async function renderSharedSplitPage(group) {
  if (!group) {
    return `
      <div class="section">
        <div class="empty-chart">
          This shared Split Money group could not be found.
        </div>
      </div>`;
  }

  const { cards } = computeGroupSettlementView(group);

  const outstandingCards = cards.filter(c => !c.settled);
  const settledCards = cards.filter(c => c.settled);

  const groupCardHtml = renderSplitGroupCard(group);
  const paid = computeGroupPaid(group);

  const settlementHtml = cards.length
    ? cards
        .sort((a, b) =>
          (a.settled === b.settled) ? 0 : (a.settled ? 1 : -1)
        )
        .map(c => renderSplitSettleCard({
          ...c,
          groupId: group.id,
          groupDesc: group.description
        }))
        .join('')
    : `<div class="empty-chart">No settlement transfers for this group.</div>`;

  // Total share per member.
  const shareTotals = {};
  for (const person of group.people) {
    shareTotals[person] = 0;
  }

  for (const spend of (group.spends || [])) {
    for (const [person, amount] of Object.entries(spend.shares || {})) {
      shareTotals[person] =
        (shareTotals[person] || 0) + (Number(amount) || 0);
    }
  }

  const shareRows = group.people.map(person => {
    const label =
      person === SPLIT_YOU
        ? getYouLabel()
        : escapeHtml(String(person).toUpperCase());
    const amtPaid = paid[person] || 0;
    const amtShare = shareTotals[person] || 0;
    return `<tr>
      <td>${label}</td>
      <td class="num">${fmtINR(amtPaid)}</td>
      <td class="num">${fmtINR(amtShare)}</td>
    </tr>`;
  }).join('');

  return `
    <div class="topbar">
      <div class="brand">
        <span class="mark">₹</span> LedgerNote
      </div>
    </div>

    <div class="section shared-page-header">
      <div class="month-header">
        <h1>${escapeHtml(group.description)}</h1>
      </div>

      <p class="shared-page-subtitle">
        Shared Split Money group · ${group.people.length} people
      </p>
    </div>

    <div class="section">
      <div class="section-title">
        <h2>Group</h2>
        <span class="hint">Shared view</span>
      </div>

      ${groupCardHtml}
    </div>

    <div class="section">
      <div class="section-title">
        <h2>Split charts</h2>
        <span class="hint">Outstanding balances and group shares</span>
      </div>

      <div class="charts-grid shared-split-charts">
        <div class="chart-card shared-chart-card">
          <h4>Who owes how much</h4>
          <p class="shared-chart-description">
            Outstanding amount each person owes to other members.
          </p>
          ${sharedStackedDebtChart(group)}
        </div>

        <div class="chart-card shared-chart-card">
          <h4>Shares by members</h4>
          <p class="shared-chart-description">
            Total share each member is responsible for paying.
          </p>
          ${sharedSharesBarChart(group)}
        </div>

      </div>
    </div>

    <div class="shared-details-always-visible">
      ${renderSplitDetailsPanel(group)}
    </div>

    <div class="section">
      <div class="section-title">
        <h2>Shares</h2>
        <span class="hint">Total share per member</span>
      </div>

      <div class="table-wrap">
	    <table class="shared-shares-table" ${shareRows ? '' : 'style="width: 100%;"'}>
	  	  <thead>
	  	    <tr>
	  	  	  <th>Person</th>
	  	  	  <th class="table-numeric">Total Paid</th>
	  	  	  <th class="table-numeric">Total Share</th>
	  	    </tr>
	  	  </thead>

          <tbody>
            ${shareRows ||
              `<tr class="empty-row">
                <td colspan="2">No shares recorded.</td>
              </tr>`}
          </tbody>
        </table>
      </div>
    </div>

    <div class="section">
      <div class="section-title">
        <h2>Settle up</h2>
        <span class="hint">
          ${outstandingCards.length
            ? `${outstandingCards.length} outstanding transfer${outstandingCards.length === 1 ? '' : 's'}`
            : 'All outstanding transfers settled'}
        </span>
      </div>

      ${scrollWrapper(settlementHtml)}
    </div>
  `;
}

async function viewSplit(){
  if (State.isShared) {
    const group = await loadSplit(State.sharedSplitId);
    return renderSharedSplitPage(group);
  }

  const {groups, allCards, owedByYou, owedToYou} = await computeSplitPageData();

  const oweSegments = Object.entries(owedByYou).map(([person,amount],i)=>({label:person, value:amount, color:SPLIT_PALETTE[i%SPLIT_PALETTE.length]}));
  const owedSegments = Object.entries(owedToYou).map(([person,amount],i)=>({label:person, value:amount, color:SPLIT_PALETTE[i%SPLIT_PALETTE.length]}));

  const groupCardsHtml = groups.length
    ? groups.map(g => renderSplitGroupCard(g)).join('')
    : `<div class="empty-chart" style="flex:1 0 100%;">No split groups yet — add one above to get started.</div>`;

  const expandedGroup = State.splitExpandedId ? groups.find(g=>g.id===State.splitExpandedId) : null;

  let settleCardsHtml = `<div class="empty-chart" style="flex:1 0 100%;">Tap a group card above to see settlement options.</div>`;
  
  // 1. Setup the fallback UI for the charts when no group is expanded
  let groupChartsHtml = `
  <div class="section">
    <div class="section-title">
      <h2>Group charts</h2>
      <span class="hint">Outstanding balances and group shares</span>
    </div>
    <div class="charts-grid shared-split-charts">
      <div class="empty-chart" style="grid-column: 1 / -1;">Tap a group card above to see its charts.</div>
    </div>
  </div>`;

  let sharesTableHtml = `
  <div class="section">
    <div class="section-title"><h2>Shares</h2><span class="hint">Total spent per person</span></div>
    <div class="table-wrap">
      <table style="width: 100%;">
        <thead><tr><th>Person</th><th>Total Paid</th><th>Total Share (Owed)</th></tr></thead>
        <tbody><tr class="empty-row"><td colspan="3">Tap a group card above to see shares.</td></tr></tbody>
      </table>
    </div>
  </div>`;

  if (expandedGroup) {
    const groupCards = allCards.filter(c => c.groupId === expandedGroup.id);
    settleCardsHtml = groupCards.length
      ? groupCards
          .sort((a,b)=> (a.settled===b.settled) ? 0 : (a.settled ? 1 : -1))
          .map(c => renderSplitSettleCard(c)).join('')
      : `<div class="empty-chart" style="flex:1 0 100%;">No debts to settle in this group.</div>`;

    // 2. Override the fallback with the actual charts when a group IS expanded
    groupChartsHtml = `
    <div class="section">
      <div class="section-title">
        <h2>Group charts</h2>
        <span class="hint">Outstanding balances and group shares for ${escapeHtml(expandedGroup.description)}</span>
      </div>
      <div class="charts-grid shared-split-charts">
        <div class="chart-card shared-chart-card">
          <h4>Who owes how much</h4>
          <p class="shared-chart-description">
            Outstanding amount each person owes to other members.
          </p>
          ${sharedStackedDebtChart(expandedGroup)}
        </div>
        <div class="chart-card shared-chart-card">
          <h4>Shares by members</h4>
          <p class="shared-chart-description">
            Total share each member is responsible for paying.
          </p>
          ${sharedSharesBarChart(expandedGroup)}
        </div>
      </div>
    </div>`;

    const paid = computeGroupPaid(expandedGroup);
    
    // Calculate total share (what each person owes in aggregate, including to themselves)
    const consumed = {};
    for (const p of expandedGroup.people) consumed[p] = 0;
    for (const s of expandedGroup.spends) {
      for (const [p, amt] of Object.entries(s.shares || {})) {
        consumed[p] = (consumed[p] || 0) + (Number(amt) || 0);
      }
    }

    const shareRows = expandedGroup.people.map(p => {
      // getYouLabel() automatically changes the current user to "YOU"
      const label = p === SPLIT_YOU ? getYouLabel() : escapeHtml(p.toUpperCase());
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
              <th class="table-numeric">Total Paid</th>
              <th class="table-numeric">Total Share (Owed)</th>
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
    <div class="brand" data-nav="home"><span class="mark">₹</span> LedgerNote</div>
  </div>

  <div class="section">
    <div class="month-header"><h1>Split Money</h1></div>
    <p style="color:var(--muted); max-width:56ch; margin-top:6px;">Track group spends with friends, see who owes what, and settle up — kept completely separate from your personal lent/owed tracking.</p>
  </div>

  <div class="section">
    <div class="section-title"><h2>Add split</h2><span class="hint">Start a new group</span></div>
    <div class="pill-grid">
      <button class="pill-btn ${State.splitFormOpen?'active':''}" data-split-form-toggle>+ Add Split</button>
    </div>
    ${State.splitFormOpen ? renderSplitAddForm() : ''}
  </div>

  <div class="section">
    <div class="section-title"><h2>Global charts</h2><span class="hint">Isolated from your main ledger</span></div>
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

  ${groupChartsHtml}

  ${sharesTableHtml}

  <div class="section">
    <div class="section-title"><h2>Settle up</h2><span class="hint">Greedy debt-minimized transfers</span></div>
    ${scrollWrapper(settleCardsHtml)}
  </div>
  `;
}

function renderSplitAddForm(){
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

function renderSplitGroupCard(group){
  const paid = computeGroupPaid(group);
  const dateLabel = group.createdAt ? new Date(group.createdAt+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '';
  const rows = group.people.map(p => `
	<div class="sgc-person"><span class="spn">${p===SPLIT_YOU ? getYouLabel() : escapeHtml(p.toUpperCase())}</span><span class="spv">${fmtINR(paid[p]||0)}</span></div>`).join('');
  const active = State.splitExpandedId === group.id ? 'active' : '';

  const {cards} = computeGroupSettlementView(group);
  const outstanding = cards.filter(c => !c.settled);
  const isFullySettled = cards.length > 0 && outstanding.length === 0;

  const actionsHtml = State.isShared ? '' : `
    <div class="sgc-actions">
      <label class="toggle-switch" title="${isFullySettled ? 'Un-settle all' : 'Settle all'}">
        <input type="checkbox" data-settle-group-toggle="${group.id}" ${isFullySettled ? 'checked' : ''} />
      </label>
      <button class="icon-btn" data-share-split="${group.id}" title="Share link" type="button">🔗</button>
      <button class="icon-btn" data-popover-trigger data-del-split="${group.id}" title="Delete group" type="button">✕</button>
    </div>`;

  return `
  <div class="split-group-card ${active}" data-split-card="${group.id}">
    ${actionsHtml}
    <h4>${escapeHtml(group.description)}</h4>
    <div class="sgc-date">${dateLabel}</div>
    <div class="sgc-people">${rows}</div>
  </div>`;
}

function renderSplitSettleCard(c){
  const from = c.from===SPLIT_YOU ? getYouLabel() : escapeHtml(c.from.toUpperCase());
  const to = c.to===SPLIT_YOU ? getYouLabel() : escapeHtml(c.to.toUpperCase());
  return `
  <div class="split-settle-card ${c.settled?'settled':''}">
    <div class="ssc-group">${escapeHtml(c.groupDesc||'')}</div>
    <div class="ssc-line"><strong>${from}</strong> ${c.from===SPLIT_YOU && !State.isShared ? 'pay' : 'pays'} <strong>${to}</strong></div>
    <div class="ssc-amount num">${fmtINR(c.amount)}</div>
    <label class="toggle-switch">
      <input type="checkbox" data-settle-toggle
        data-group-id="${c.groupId}" data-transfer-id="${c.id}"
        data-from="${escapeHtml(c.from)}" data-to="${escapeHtml(c.to)}"
        data-amount="${c.amount}" data-group-desc="${escapeHtml(c.groupDesc||'')}"
        ${c.settled?'checked':''} />
      ${c.settled ? 'Settled' : 'Mark settled'}
    </label>
  </div>`;
}

function renderSplitShareCallout(group, s){
  const shares = group.people.map(p => ({
    label: p===SPLIT_YOU ? getYouLabel() : String(p).toUpperCase(),
    amount: Number((s.shares||{})[p]) || 0
  }));
  const dataAttr = escapeHtml(JSON.stringify(shares));
  return `<span class="split-spend-cell" tabindex="0" data-spend-toggle data-spend-shares="${dataAttr}">${escapeHtml(s.description)}</span>`;
}

function renderSplitDetailsPanel(group) {
  const memberOptions = group.people.map(p => `<option value="${escapeHtml(p)}">${p === SPLIT_YOU ? getYouLabel() : escapeHtml(p.toUpperCase())}</option>`).join('');
  
  // Member share fields with toggle placed side-by-side with the input
  const shareInputs = group.people.map(p => {
    const personLabel = p === SPLIT_YOU ? getYouLabel(true) + ' share' : `${escapeHtml(p.toUpperCase())}'s share`;
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
    const payeeLabel = s.payee === SPLIT_YOU ? getYouLabel() : escapeHtml(String(s.payee).toUpperCase());
    return `
    <tr>${dateCell}
      <td>
        ${renderSplitShareCallout(group, s)}
        <span class="src-badge">${escapeHtml(s.payee)}</span>
      </td>
      <td class="num">${fmtINR(s.amount)}</td>
      <td class="actions-cell"><button class="icon-btn" data-del-split-spend="${group.id}|${s.id}" title="Remove spend">✕</button></td>
    </tr>`;
  }).join('');
  const formHtml = State.splitSpendFormOpen ? `
  <div class="form-panel slide-down-fade" style="margin-top:14px;">
    <div class="form-note" style="margin-top:0; margin-bottom:14px;">Add a transaction. The amount is split equally among active members by default.</div>
    <div class="form-row">
      <div class="field"><label>Spend</label><input id="sp-desc" type="text" placeholder="e.g. Dinner" /></div>
      <div class="field"><label>Paid by</label><select id="sp-payee">${memberOptions}</select></div>
      <div class="field"><label>Date</label><input id="sp-date" type="date" value="${todayStr()}" /></div>
      <div class="field"><label>Total amount (₹)</label><input id="sp-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
    </div>
    <div class="split-share-grid">${shareInputs}</div>
    <div class="form-actions">
      <button class="btn primary" data-submit-split-spend="${group.id}" type="button">Add spend</button>
      <button class="btn ghost" data-close-split-spend-form type="button">Cancel</button>
    </div>
  </div>` : '';
  const addBtnHtml = !State.splitSpendFormOpen ? `
  <div class="pill-grid" style="margin-top: 14px;">
    <button class="pill-btn" data-open-split-spend-form type="button">+ Add Spend</button>
  </div>` : '';

  return `
  <div class="split-details-panel" data-split-details="${group.id}" style="margin-top: 2px;">
    <div class="section-title"><h2>${escapeHtml(group.description)} - Ledger</h2><span class="hint">${group.people.length} people</span></div>

    ${addBtnHtml}
    ${formHtml}

    <div class="form-note" style="margin-top:18px; margin-bottom:8px;">All group spends are listed here. Click a spend name to view share divisions.</div>
    <div class="table-wrap">
      <table class="divisions-table" ${rowsHtml ? '' : `style="width: 100%;"`}>
        <thead><tr><th>Date</th><th>Details</th><th ${rowsHtml ? `class="num"` : ''}>Amount</th><th></th></tr></thead>
        <tbody>
          ${rowsHtml || `<tr class="empty-row"><td colspan="5">No spends logged in this group yet.</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>`;
}

/* ---------- Price Tracker ---------- */
function sortedPriceHistory(item){
  return [...(item.history || [])].sort((a,b) => (a.date||'').localeCompare(b.date||''));
}

async function viewPriceTrack(){
  const items = [...State.priceItems].sort((a,b) => a.name.localeCompare(b.name));
  const expandedItem = State.priceExpandedId ? State.priceItems.find(i => i.id === State.priceExpandedId) : null;

  const addFormHtml = State.priceFormOpen ? `
  <div class="form-panel">
    <div class="form-row">
      <div class="field"><label>Item name</label><input id="pi-name" type="text" placeholder="e.g. Milk 1L" /></div>
      ${renderTagField()}
      <div id="pt-dynamic-fields" style="display:contents;"></div>
    </div>
    <div class="form-actions">
      <button class="btn primary" data-submit-price-item type="button">Save item</button>
      <button class="btn ghost" data-close-price-form type="button">Cancel</button>
    </div>
  </div>` : '';

  // 1. Group items by tag/category
  const groupedItems = {};
  for(const item of items) {
    const cat = item.category || 'Other';
    if(!groupedItems[cat]) groupedItems[cat] = [];
    groupedItems[cat].push(item);
  }

  // 2. Generate separate sections for each category
  let categoriesHtml = '';
  if (items.length === 0) {
    categoriesHtml = `<div class="empty-chart" style="grid-column:1/-1;">No items tracked yet — add one above to get started.</div>`;
  } else {
    const sortedCategories = Object.keys(groupedItems).sort((a,b) => a.localeCompare(b));
    for (const category of sortedCategories) {
      const catItems = groupedItems[category];
      const cardsHtml = catItems.map(i => renderPriceItemCard(i)).join('');
      
      const isExpandedInThisCategory = expandedItem && catItems.some(i => i.id === expandedItem.id);
      
      // Inject details panel directly below this specific category's row if active
      const detailsHtml = isExpandedInThisCategory 
        ? `<div id="price-details-anim-inner" class="${State.priceSlideDirection || ''}">
            ${renderPriceDetailsPanel(expandedItem)}
           </div>` 
        : '';

      categoriesHtml += `
      <div class="price-category-section">
        <div class="price-category-title">${escapeHtml(category)}</div>
        ${scrollWrapper(cardsHtml, 'price-category-track')}
        ${detailsHtml}
      </div>`;
    }
  }

  return `
  <div class="topbar">
    <div class="brand" data-nav="home"><span class="mark">₹</span> LedgerNote</div>
  </div>

  <div class="section">
    <div class="month-header"><h1>Price Tracker</h1></div>
    <p style="color:var(--muted); max-width:56ch; margin-top:6px;">Note down what things cost over time — groceries, transport, subscriptions — and watch how prices move.</p>
  </div>

  <div class="section">
    <div class="section-title"><h2>Track an item</h2><span class="hint">Add anything you want to watch the price of</span></div>
    <div class="pill-grid">
      <button class="pill-btn ${State.priceFormOpen ? 'active' : ''}" data-price-form-toggle type="button">+ Add New Item</button>
    </div>
    ${addFormHtml}
  </div>

  <div class="section">
    <div class="section-title"><h2>Tracked items</h2><span class="hint">Tap a card for its full price history</span></div>
    ${categoriesHtml}
  </div>
  `;
}

function renderPriceItemCard(item){
  const hist = sortedPriceHistory(item);
  const latest = hist.length ? hist[hist.length - 1] : null;
  const prev = hist.length > 1 ? hist[hist.length - 2] : null;
  const active = State.priceExpandedId === item.id ? 'active' : '';

  let trendHtml = '';
  if(latest && prev){
    const diff = latest.price - prev.price;
    const pct = prev.price ? (diff / prev.price * 100) : 0;
    const cls = diff === 0 ? 'flat' : (diff > 0 ? 'up' : 'down');
    const arrow = diff === 0 ? '→' : (diff > 0 ? '↑' : '↓');
    trendHtml = `<span class="price-trend ${cls}">${arrow} ${Math.abs(pct).toFixed(1)}%</span>`;
  }

  const dateLabel = latest && latest.date
    ? new Date(latest.date + 'T00:00:00').toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'})
    : null;

  // Extract metadata directly from the item
  let metaHtml = '';
  if (item.meta) {
    if (item.meta.quantity) {
      metaHtml = ` <span class="meta-text">${escapeHtml(item.meta.quantity)}</span>`;
    } else if (item.meta.source && item.meta.destination) {
      metaHtml = ` <span class="meta-text">${escapeHtml(item.meta.source)} → ${escapeHtml(item.meta.destination)}</span>`;
    }
  }

  return `
  <div class="price-item-card ${active}" data-price-card="${item.id}">
    <div class="pic-actions">
      <button class="icon-btn" data-popover-trigger data-del-price-item="${item.id}" title="Remove item" type="button">✕</button>
    </div>
    <div class="pic-top">
      <h4>${escapeHtml(item.name)}</h4></br>${metaHtml}
      <span class="src-badge">${escapeHtml(item.category)}</span>
    </div>
    <div class="pic-bottom">
      <div class="pic-price-row">
        <span class="pic-price">${latest ? fmtINR(latest.price) : '—'}</span>
        ${trendHtml}
      </div>
      <div class="pic-date">${dateLabel ? 'Updated ' + dateLabel : 'No prices logged yet'}</div>
    </div>
  </div>`;
}

function priceLineChart(hist){
  if(!hist.length){
    return `<div class="empty-chart">Log a price to see the trend line.</div>`;
  }
  if(hist.length === 1){
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
  const areaD = pathD + ` L${coords[coords.length-1][0].toFixed(1)},${h-padB} L${coords[0][0].toFixed(1)},${h-padB} Z`;
  const gridSvg = yAxisGrid(minV, maxV, w, h, padL, padR, padT, padB, 4);
  const dots = coords.map(([x, y], i) => {
    const dl = new Date(hist[i].date + 'T00:00:00').toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'});
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="var(--blue)"><title>${dl}: ${fmtINR(hist[i].price)}</title></circle>`;
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

function renderPriceDetailsPanel(item){
  const hist = sortedPriceHistory(item);
  const chart = priceLineChart(hist);

  const rowsHtml = [...hist].reverse().map(h => {
    const dateLabel = h.date ? new Date(h.date + 'T00:00:00').toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'}) : '—';
    return `
    <tr>
      <td>${dateLabel}</td>
      <td class="num">${fmtINR(h.price)}</td>
      <td>${h.note ? escapeHtml(h.note) : '<span class="subnote">—</span>'}</td>
      <td class="actions-cell"><button class="icon-btn" data-del-price-point="${item.id}|${h.id}" title="Remove entry">✕</button></td>
    </tr>`;
  }).join('');

  const formHtml = State.priceLogFormOpen ? `
  <div class="form-panel slide-down-fade" style="margin-top:14px;">
    <div class="form-row">
      <div class="field"><label>Date</label><input id="pp-date" type="date" value="${todayStr()}" /></div>
      <div class="field"><label>Price (₹)</label><input id="pp-price" type="number" step="0.01" min="0" placeholder="0.00" /></div>
      <div class="field"><label>Note (optional)</label><input id="pp-note" type="text" placeholder="e.g. Supermarket" /></div>
    </div>
    <div class="form-actions">
      <button class="btn primary" data-submit-price-point="${item.id}" type="button">Add price</button>
      <button class="btn ghost" data-close-price-log-form type="button">Cancel</button>
    </div>
  </div>` : '';

  const addBtnHtml = !State.priceLogFormOpen ? `
  <div class="pill-grid" style="margin-top:14px;">
    <button class="pill-btn" data-open-price-log-form type="button">+ Log Price</button>
  </div>` : '';

  return `
  <div class="price-details-panel" data-price-details="${item.id}" style="margin-top:2px;">
    <div class="section-title"><h2>${escapeHtml(item.name)} — Price History</h2><span class="hint">${hist.length} entr${hist.length===1?'y':'ies'} logged</span></div>

    <div class="chart-card" style="margin-top:14px;">
      ${chart}
    </div>

    ${addBtnHtml}
    ${formHtml}

    <div class="section-title"><h2>Cost Entries</h2></div>
    <div class="table-wrap">
      <table ${rowsHtml ? '' : 'style="width:100%;"'}>
        <thead><tr><th>Date</th><th class="table-numeric">Price</th><th>Note</th><th></th></tr></thead>
        <tbody>
          ${rowsHtml || `<tr class="empty-row"><td colspan="4">No prices logged yet — add one above.</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>`;
}

function renderRow(e, monthKey, rowspan = 1, isFirstDateRow = true){
  let dateCell = '';
  if (isFirstDateRow) {
    const dateLabel = e.date ? new Date(e.date+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short'}) : '—';
    dateCell = `<td class="dv-date num" rowspan="${rowspan}">${dateLabel}</td>`;
  }

  // Look up metadata from the global dictionary
  let metaHtml = '';
  const dictEntry = State.priceTrackDictionary ? State.priceTrackDictionary[e.description] : null;
  if (dictEntry && dictEntry.meta) {
    const meta = dictEntry.meta;
    if (meta.quantity) {
      metaHtml = `</br><span class="meta-text">${escapeHtml(meta.quantity)}</span>`;
    } else if (meta.source && meta.destination) {
      metaHtml = `</br><span class="meta-text">${escapeHtml(meta.source)} → ${escapeHtml(meta.destination)}</span>`;
    }
  }

  if(e.type==='spend'){
    const card = e.paymentMode==='card' ? cardById(e.cardId) : null;
    const lentChips = (e.lent||[]).map(l => `
      <span class="chip ${l.settled?'settled':''}">${escapeHtml(l.person)} · ${fmtINR(l.amount)}
        ${!l.settled?`<button data-settle-lent="${e.id}|${l.id}" title="Mark as paid back">✓</button>`:''}
      </span>`).join('');
    return `<tr>
      ${dateCell}
      <td><span class="tag spend">Spend</span></td>
      <td>
        <strong>${escapeHtml(e.description)}</strong>${e.tag ? ` <span class="src-badge">${escapeHtml(e.tag)}</span>` : ''}${metaHtml}
        <div class="subnote">${card ? 'Paid via '+escapeHtml(card.name)+' — reduces card dues' : 'Cash / debit'}</div>
        ${lentChips ? `<div>${lentChips}</div>` : ''}
      </td>
      <td class="num amt-debit">-${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-del-entry="${monthKey}|${e.id}" title="Delete">✕</button></span></td>
    </tr>`;
  }
  if(e.type==='cardcharge'){
    const card = cardById(e.cardId);
    const lentChips = (e.lent||[]).map(l => `
      <span class="chip ${l.settled?'settled':''}">${escapeHtml(l.person)} · ${fmtINR(l.amount)}
        ${!l.settled?`<button data-settle-lent="${e.id}|${l.id}" title="Mark as paid back">✓</button>`:''}
      </span>`).join('');
    return `<tr>
      ${dateCell}
      <td><span class="tag cardcharge">Card spend</span></td>
      <td>
        <strong>${escapeHtml(e.description)}</strong>${e.tag ? ` <span class="src-badge">${escapeHtml(e.tag)}</span>` : ''}${metaHtml}
        <div class="subnote">On ${card ? escapeHtml(card.name) : 'a removed card'} — adds to card dues, not deducted from balance</div>
        ${lentChips ? `<div>${lentChips}</div>` : ''}
      </td>
      <td class="num amt-neutral">${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-del-entry="${monthKey}|${e.id}" title="Delete">✕</button></span></td>
    </tr>`;
  }
  if(e.type==='cashpayment'){
    return `<tr>
      ${dateCell}
      <td><span class="tag cashpayment">Cash spend</span></td>
      <td>
        <strong>${escapeHtml(e.description)}</strong>${e.tag ? ` <span class="src-badge">${escapeHtml(e.tag)}</span>` : ''}${metaHtml}
        <div class="subnote">Physical cash spent — already accounted for via withdrawal</div>
      </td>
      <td class="num amt-neutral">${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-del-entry="${monthKey}|${e.id}" title="Delete">✕</button></span></td>
    </tr>`;
  }
  if(e.type==='income'){
    return `<tr>
      ${dateCell}
      <td><span class="tag income">Income</span></td>
      <td><strong>${escapeHtml(e.description)}</strong>${e.category ? ` <span class="src-badge">${escapeHtml(e.category)}</span>` : ''}</td>
      <td class="num amt-credit">+${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-del-entry="${monthKey}|${e.id}" title="Delete">✕</button></span></td>
    </tr>`;
  }
  if(e.type==='owed'){
    return `<tr>
      ${dateCell}
      <td><span class="tag owed">Owed to you</span></td>
      <td>
        <strong>${escapeHtml(e.description)}</strong>
        ${e.settled?`<div class="subnote">Settled</div>`:`<div class="subnote">Carries forward until settled</div>`}
      </td>
      <td class="num" style="color:var(--amber)">${fmtINR(e.amount)}</td>
      <td class="actions-cell">
        <span class="row-actions">
          ${!e.settled?`<button class="icon-btn" data-settle-owed="${monthKey}|${e.id}" title="Mark as paid back">✓</button>`:''}
          <button class="icon-btn" data-del-entry="${monthKey}|${e.id}" title="Delete">✕</button>
        </span>
      </td>
    </tr>`;
  }
  if(e.type==='investment'){
    return `<tr>
      ${dateCell}
      <td><span class="tag invest">Investment</span></td>
      <td><strong>${escapeHtml(e.description)}</strong></td>
      <td class="num amt-debit">-${fmtINR(e.amount)}</td>
      <td class="actions-cell"><span class="row-actions"><button class="icon-btn" data-del-entry="${monthKey}|${e.id}" title="Delete">✕</button></span></td>
    </tr>`;
  }
  return '';
}

/* ---------- Forms ---------- */
function renderTagField(){
  const tags = allSpendTags();
  const options = tags.map(t=>`<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
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

function renderForm(kind, monthKey){
  if(!kind) return '';
  const cardOptions = State.cards.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if(kind==='spend'){
    return `
    <div class="form-panel">
      <div class="pill-grid" style="margin-bottom: 12px;" id="f-spend-mode-selector">
        <button class="pill-btn sub-pill active" data-spend-mode="regular" type="button">Regular</button>
        <button class="pill-btn sub-pill" data-spend-mode="atm" type="button">Cash Withdrawal</button>
        <button class="pill-btn sub-pill" data-spend-mode="card" type="button" ${State.cards.length?'':'disabled'}>Credit Card Due Payment</button>
      </div>
      <div class="form-note" id="f-mode-info" style="margin-top:0; margin-bottom:14px;">Add regular spends with tag for instant transfer modes like UPI.</div>
      
      <div class="form-row">
        <div class="field" id="f-desc-wrap"><label>Spend</label><input id="f-desc" type="text" placeholder="e.g. Groceries" /></div>
        <div class="field"><label>Amount (₹)</label><input id="f-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div class="field"><label>Date</label><input id="f-date" type="date" value="${todayStr()}" /></div>
      </div>
      <div class="form-row">
        <div class="field" id="f-card-wrap" style="display:none;">
          <label>Card being paid off</label>
          <select id="f-card">${cardOptions || '<option value="">No cards added</option>'}</select>
        </div>
        <div id="f-tag-row" style="display:contents;">
          ${renderTagField()}
        </div>
        <div id="spend-dynamic-fields" style="display:contents;"></div>
      </div>
      <div id="f-price-track-wrap" style="margin-bottom: 14px;">
        <button class="pill-btn sub-pill" id="f-price-track-btn" type="button">+ Add to Price Tracker</button>
      </div>
      <label class="checkline" id="f-lent-container"><input type="checkbox" id="f-lent-toggle" /> Lent — someone owes me part of this</label>
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
  if(kind==='cardcharge'){
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
        <button class="btn" data-submit="cardcharge" ${State.cards.length?'':'disabled'}>Add card spend</button>
        <button class="btn ghost" data-close-form>Cancel</button>
      </div>
    </div>`;
  }
  if(kind==='cashpayment'){
    return `
    <div class="form-panel">
      <div class="form-note" style="margin-top:0;margin-bottom:14px;">Money spent from previously withdrawn physical cash. Doesn't deduct from your bank balance since the withdrawal was already logged.</div>
      <div class="form-row">
        <div class="field"><label>Spend</label><input id="f-desc" type="text" placeholder="e.g. Street food" /></div>
        <div class="field"><label>Amount (₹)</label><input id="f-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div class="field"><label>Date</label><input id="f-date" type="date" value="${todayStr()}" /></div>
      </div>
      <div class="form-row">
        <div id="f-tag-row" style="display:contents;">
          ${renderTagField()}
        </div>
      </div>
      <div class="form-actions">
        <button class="btn" data-submit="cashpayment">Add cash payment</button>
        <button class="btn ghost" data-close-form>Cancel</button>
      </div>
    </div>`;
  }
  if(kind==='income'){
    return `
    <div class="form-panel">
      <div class="form-note">Log amounts credited to your account from various sources.</div>
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
  if(kind==='owed'){
    return `
    <div class="form-panel">
      <div class="form-note">Carries forward automatically in your totals every month until you mark it settled.</div>
      <div class="form-row">
        <div class="field"><label>Person</label><input id="f-desc" type="text" placeholder="Who owes you" /></div>
        <div class="field"><label>Amount (₹)</label><input id="f-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div class="field"><label>Date</label><input id="f-date" type="date" value="${todayStr()}" /></div>
      </div>
      <div class="form-actions">
        <button class="btn" data-submit="owed">Add</button>
        <button class="btn ghost" data-close-form>Cancel</button>
      </div>
    </div>`;
  }
  if(kind==='emi'){
    return `
    <div class="form-panel">
      <div class="form-note">Select when the EMI started. It auto-carries forward each month until the specified duration is reached.</div>
      <div class="form-row">
        <div class="field"><label>Description</label><input id="f-desc" type="text" placeholder="e.g. Laptop EMI" /></div>
        <div class="field"><label>Monthly deductible (₹)</label><input id="f-amount" type="number" step="0.01" min="0" placeholder="0.00" /></div>
        <div class="field"><label>Number of months</label><input id="f-months" type="number" step="1" min="1" placeholder="e.g. 12" /></div>
        <div class="field"><label>Starting Month</label><input id="f-emi-start" type="month" max="${currentMonthKey()}" value="${monthKey}" /></div>
      </div>
      <div class="form-actions">
        <button class="btn" data-submit="emi">Start EMI</button>
        <button class="btn ghost" data-close-form>Cancel</button>
      </div>
    </div>`;
  }
  if(kind==='invest'){
    return `
    <div class="form-panel">
      <div class="form-note invest-form" style="margin-top:0;">
        <span>Any spend added here is a one-time investment. For recurring investments, add SIP.</span>
        <button class="pill-btn sub-pill active hyperlink" data-spend-mode="regular" data-nav="sips" type="button">Add SIP</button>
      </div>
      <div class="form-row">
        <div class="field"><label>Description</label><input id="f-desc" type="text" placeholder="e.g. Fixed Deposit" /></div>
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

/* ---------- Charts (self-contained, no libraries) ---------- */
function donutChart(segments){
  const total = segments.reduce((s,x)=>s+x.value,0);
  if(total <= 0) return `<div class="empty-chart">No spending recorded yet this month.</div>`;
  let acc = 0;
  const stops = segments.filter(s=>s.value>0).map(s=>{
    const start = acc/total*360; acc += s.value; const end = acc/total*360;
    return `${s.color} ${start}deg ${end}deg`;
  }).join(', ');
  const legend = segments.filter(s=>s.value>0).map(s=>`
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
function barChart(pairs){
  const max = Math.max(1, ...pairs.map(p=>p.value));
  const cols = pairs.map(p => `
    <div class="bar-col">
      <div class="bval num">${fmtINR(p.value)}</div>
      <div class="bar" style="height:${Math.max(4,(p.value/max*130))}px; background:${p.color};"></div>
      <div class="blabel">${p.label}</div>
    </div>`).join('');
  return `<div class="bars">${cols}</div>`;
}
function tagsBarChart(entries, targetType){
  const totals = {};
  for(const e of entries){
    // Only aggregate if the entry matches the requested category
    if(e.type === targetType){
      const tag = (e.tag && String(e.tag).trim()) ? e.tag : 'Untagged';
      totals[tag] = (totals[tag]||0) + (Number(e.amount)||0);
    }
  }
  
  const pairs = Object.entries(totals).map(([label,value])=>({label,value})).filter(p=>p.value>0).sort((a,b)=>b.value-a.value);
  if(!pairs.length) return `<div class="empty-chart">No tagged spends yet.</div>`;
  
  const max = Math.max(1, ...pairs.map(p=>p.value));
  const colors = ['var(--blue)','#C98A3C','#8E6FB0','var(--debit)','var(--credit)','#5B4B9E','var(--amber)','var(--blue-soft)','#2E7D6B','#AD4358'];
  const cols = pairs.map((p,i) => `
    <div class="tag-bar-col">
      <div class="bval num">${fmtINRShort(p.value)}</div>
      <div class="tag-bar" style="height:${Math.max(4,(p.value/max*140))}px; background:${colors[i%colors.length]};"></div>
      <div class="blabel" title="${escapeHtml(p.label)}">${escapeHtml(p.label)}</div>
    </div>`).join('');
  return `<div class="tag-bars">${cols}</div>`;
}
function lineChart(startingBalance, data, recurringRows){
  const entries = [...data.entries, ...recurringRows]
    .filter(e => e.type==='income' || e.type==='investment' || e.type==='emi' || e.type==='sip' || (e.type==='spend' && e.paymentMode!=='card') || (e.type==='spend' && e.paymentMode==='card'))
    .filter(e => e.date)
    .sort((a,b)=>a.date.localeCompare(b.date));
  const start = Number(startingBalance)||0;
  if(entries.length===0){
    return `<div class="empty-chart">Balance line will appear once you add entries with dates.</div>`;
  }
  let running = start;
  const points = [{date:'start', balance:running}];
  for(const e of entries){
    const amt = Number(e.amount)||0;
    if(e.type==='income') running += amt; else running -= amt;
    points.push({date:e.date, balance:running});
  }
  const w = 900, h = 170, padL = 85, padR = 20, padT = 16, padB = 30;
  const vals = points.map(p=>p.balance);
  const minV = Math.min(...vals, start), maxV = Math.max(...vals, start);
  const range = (maxV-minV) || 1;
  const stepX = (w-padL-padR)/Math.max(1,(points.length-1));
  const coords = points.map((p,i)=>{
    const x = padL + i*stepX;
    const y = h - padB - ((p.balance-minV)/range)*(h-padT-padB);
    return [x,y];
  });
  const pathD = coords.map((c,i)=> (i===0?'M':'L')+c[0].toFixed(1)+','+c[1].toFixed(1)).join(' ');
  const areaD = pathD + ` L${coords[coords.length-1][0].toFixed(1)},${h-padB} L${coords[0][0].toFixed(1)},${h-padB} Z`;
  const gridSvg = yAxisGrid(minV, maxV, w, h, padL, padR, padT, padB, 8);
  const lastVal = points[points.length-1].balance;
  const dots = coords.map(([x,y],i)=>`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="var(--blue)"><title>${fmtINR(points[i].balance)}</title></circle>`).join('');
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
function bindEvents(){
  const app = $('#app');
  State.animTimeout = State.animTimeout || null;
  const PILL_ORDER = ['spend', 'cardcharge', 'cashpayment', 'income', 'owed', 'emi', 'invest'];

  app.onclick = async (ev) => {
    const scrollNext = ev.target.closest('[data-scroll-next]');
    if(scrollNext){
      const wrapper = scrollNext.closest('[data-scroll-wrapper]');
      const track = wrapper ? wrapper.querySelector('[data-scroll-track]') : null;
      if(track) track.scrollBy({left:300, behavior:'smooth'});
      return;
    }
    const scrollPrev = ev.target.closest('[data-scroll-prev]');
    if(scrollPrev){
      const wrapper = scrollPrev.closest('[data-scroll-wrapper]');
      const track = wrapper ? wrapper.querySelector('[data-scroll-track]') : null;
      if(track) track.scrollBy({left:-300, behavior:'smooth'});
      return;
    }
    const rangeBtn = ev.target.closest('[data-range]');
    if(rangeBtn){
      State.balanceChartRange = Number(rangeBtn.dataset.range);
      await render();
      return;
    }
    const statToggle = ev.target.closest('[data-stat-toggle]');
    if(statToggle && window.matchMedia('(hover: none)').matches){
      const card = statToggle.closest('[data-stat-card]');
      const wasOpen = card.classList.contains('open');
      $$('[data-stat-card].open', app).forEach(c => { if(c!==card) c.classList.remove('open'); });
      card.classList.toggle('open', !wasOpen);
      return;
    }
	  const statBack = ev.target.closest('.stat-back');
    if(statBack && window.matchMedia('(hover: none)').matches){
      const card = statBack.closest('[data-stat-card]');
      if(card) card.classList.remove('open');
      return;
    }
    const extInvestSaveBtn = ev.target.closest('#ext-invest-save');
    if (extInvestSaveBtn) {
      const amount = Number($('#ext-invest-amount')?.value) || 0;
      State.existingInvestments = amount;
      await Store.set('existinginvestments', amount);
      await render(); // Re-render to update the total stats globally
      showToast('Base investment amount saved');
      return;
    }
    const nav = ev.target.closest('[data-nav]');
    if(nav){
      const dest = nav.dataset.nav;
      if(dest==='addmonth'){ await promptAddMonth(); return; }
      State.view = dest;
      await render();
      return;
    }
    /* ---------- Price Tracker ---------- */
    const priceFormToggle = ev.target.closest('[data-price-form-toggle]');
    if(priceFormToggle){
      State.priceFormOpen = !State.priceFormOpen;
      await render();
      return;
    }
    const closePriceForm = ev.target.closest('[data-close-price-form]');
    if(closePriceForm){
      State.priceFormOpen = false;
      await render();
      return;
    }
    const submitPriceItem = ev.target.closest('[data-submit-price-item]');
    if(submitPriceItem){
      const name = ($('#pi-name').value || '').trim();
      if(!name){ showToast('Enter an item name'); return; }
      const category = (await resolveTagFromForm()) || 'Other';
      
      let meta = {};
      const catLower = category.toLowerCase();
      if (catLower === 'groceries') meta.quantity = $('#pt-quantity')?.value || '';
      if (catLower === 'transport') {
        meta.source = $('#pt-source')?.value || '';
        meta.destination = $('#pt-destination')?.value || '';
      }

      State.priceTrackDictionary[name] = { category, meta };
      await Store.set('price-track-dict', State.priceTrackDictionary);

      State.priceItems.push({ id: uid(), name, category, history: [], meta });
      await Store.set('price-items', State.priceItems);
      State.priceFormOpen = false;
      await render();
      showToast('Item added');
      return;
    }
    const delPriceItemBtn = ev.target.closest('[data-del-price-item]');
    if(delPriceItemBtn){
      ev.stopPropagation(); // Prevents the card from expanding/collapsing when clicking the X
      showDeleteCallout(delPriceItemBtn, 'confirm-del-price-item', delPriceItemBtn.dataset.delPriceItem);
      return;
    }
    const confirmDelPriceItem = ev.target.closest('[data-confirm-del-price-item]');
    if(confirmDelPriceItem){
      ev.stopPropagation();
      const id = confirmDelPriceItem.dataset.confirmDelPriceItem;
      State.priceItems = State.priceItems.filter(i => i.id !== id);
      if(State.priceExpandedId === id){
        State.priceExpandedId = null;
        State.priceLogFormOpen = false;
      }
      await Store.set('price-items', State.priceItems);
      hideDeleteCallout();
      await render();
      showToast('Item removed');
      return;
    }
    const priceCard = ev.target.closest('[data-price-card]');
    if(priceCard){
      const id = priceCard.dataset.priceCard;
      if (State.animTimeout) clearTimeout(State.animTimeout);

      if (State.priceExpandedId === id) { // Close
        State.priceExpandedId = null;
        State.priceLogFormOpen = false;
        render();
        return;
      }
      if (State.priceExpandedId) { // Switch between item cards
        const cards = $$('.price-item-card');
        let oldIdx = -1, newIdx = -1;
        cards.forEach((c, i) => {
          if (c.dataset.priceCard === State.priceExpandedId) oldIdx = i;
          if (c.dataset.priceCard === id) newIdx = i;
        });
        const isRight = newIdx > oldIdx;
        const inner = $('#price-details-anim-inner');
        if (inner && oldIdx !== -1 && newIdx !== -1) {
          inner.className = isRight ? 'slide-out-left' : 'slide-out-right';
          State.animTimeout = setTimeout(() => {
            State.priceExpandedId = id;
            State.priceLogFormOpen = false;
            State.priceSlideDirection = isRight ? 'slide-in-right' : 'slide-in-left';
            render();
          }, 300);
        } else {
          State.priceExpandedId = id;
          State.priceLogFormOpen = false;
          State.priceSlideDirection = '';
          render();
        }
        return;
      }
      // Open fresh
      State.priceExpandedId = id;
      State.priceLogFormOpen = false;
      State.priceSlideDirection = '';
      await render();
      return;
    }
    const openPriceLogForm = ev.target.closest('[data-open-price-log-form]');
    if(openPriceLogForm){
      State.priceLogFormOpen = true;
      await render();
      return;
    }
    const closePriceLogForm = ev.target.closest('[data-close-price-log-form]');
    if(closePriceLogForm){
      State.priceLogFormOpen = false;
      await render();
      return;
    }
    const submitPricePoint = ev.target.closest('[data-submit-price-point]');
    if(submitPricePoint){
      const itemId = submitPricePoint.dataset.submitPricePoint;
      const item = State.priceItems.find(i => i.id === itemId);
      if(!item) return;
      const date = $('#pp-date').value || todayStr();
      const price = Number($('#pp-price').value);
      const note = ($('#pp-note').value || '').trim();
      if(Number.isNaN(price) || price < 0){ showToast('Enter a valid price'); return; }
      item.history.push({ id: uid(), date, price, note });
      await Store.set('price-items', State.priceItems);
      State.priceLogFormOpen = false;
      await render();
      showToast('Price logged');
      return;
    }
    const delPricePoint = ev.target.closest('[data-del-price-point]');
    if(delPricePoint){
      const [itemId, pointId] = delPricePoint.dataset.delPricePoint.split('|');
      const item = State.priceItems.find(i => i.id === itemId);
      if(item){
        item.history = item.history.filter(h => h.id !== pointId);
        await Store.set('price-items', State.priceItems);
        await render();
        showToast('Entry removed');
      }
      return;
    }
    const priceTrackBtn = ev.target.closest('#f-price-track-btn');
    if (priceTrackBtn) {
      priceTrackBtn.classList.toggle('active');
      if (priceTrackBtn.classList.contains('active')) {
        priceTrackBtn.textContent = '✓ Added to Price Tracker';
      } else {
        priceTrackBtn.textContent = '+ Add to Price Tracker';
      }
      return;
    }
    const toggleManualBtn = ev.target.closest('#toggle-manual-balance-btn');
    if (toggleManualBtn) {
      const mk = State.currentMonthKey;
      const data = await loadMonth(mk);
      // Toggle between auto and manual modes, saving state to the database
      data.startingBalanceMode = data.startingBalanceMode === 'manual' ? 'auto' : 'manual';
      await saveMonth(mk);
      await render();
      
      // Auto-focus the input if it was just activated
      if (data.startingBalanceMode === 'manual') {
        setTimeout(() => $('#starting-balance-manual')?.focus(), 50);
      }
      return;
    }
    const delMonthBtn = ev.target.closest('[data-del-month]');
    if(delMonthBtn){
      ev.stopPropagation();

      showDeleteCallout(
        delMonthBtn,
        'confirm-del-month',
        delMonthBtn.dataset.delMonth
      );

      return;
    }
    const confirmDelMonth = ev.target.closest('[data-confirm-del-month]');
    if(confirmDelMonth){
      ev.stopPropagation();

      const key = confirmDelMonth.dataset.confirmDelMonth;
      const label = monthKeyLabel(key);

      await deleteMonth(key);
      hideDeleteCallout();
      await render();
      showToast(`${label} deleted`);

      return;
    }
    // Dismiss the callout if clicking anywhere else outside it
    if (
      !ev.target.closest('#del-popover') &&
      !ev.target.closest('[data-popover-trigger]')
    ) {
      hideDeleteCallout();
    }
    const openMonthEl = ev.target.closest('[data-open-month]');
    if(openMonthEl){ await openMonth(openMonthEl.dataset.openMonth, false); return; }

	
	const spendModeBtn = ev.target.closest('[data-spend-mode]');
    if (spendModeBtn) {
      if (spendModeBtn.disabled) return;
      
      // Update active styling
      const wrap = spendModeBtn.closest('#f-spend-mode-selector');
      wrap.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
      spendModeBtn.classList.add('active');

      const mode = spendModeBtn.dataset.spendMode;
      const descWrap = $('#f-desc-wrap');
      const cardWrap = $('#f-card-wrap');
      const tagRow = $('#f-tag-row');
      const infoBox = $('#f-mode-info');
      
      // Select the lent elements
      const lentContainer = $('#f-lent-container');
      const lentWrap = $('#f-lent-wrap');
      const lentToggle = $('#f-lent-toggle');
      const priceTrackWrap = $('#f-price-track-wrap');

      // Adjust field visibility and info text based on selection
      if (mode === 'regular') {
        if (priceTrackWrap) priceTrackWrap.style.display = 'block';
        descWrap.style.display = 'block';
        cardWrap.style.display = 'none';
        tagRow.style.display = 'contents';
        infoBox.textContent = 'Add regular spends with tag for instant transfer modes like UPI.';
        
        if (lentContainer) lentContainer.style.display = 'flex';
      } else if (mode === 'atm') {
        if (priceTrackWrap) priceTrackWrap.style.display = 'none';
        descWrap.style.display = 'none';
        cardWrap.style.display = 'none';
        tagRow.style.display = 'none';
        infoBox.textContent = 'Note down debit from bank account upon cash withdrawal.';
        
        if (lentContainer) lentContainer.style.display = 'none';
        if (lentWrap) lentWrap.style.display = 'none';
        if (lentToggle) lentToggle.checked = false;
      } else if (mode === 'card') {
        if (priceTrackWrap) priceTrackWrap.style.display = 'none';
        descWrap.style.display = 'none';
        cardWrap.style.display = 'block';
        tagRow.style.display = 'none';
        infoBox.textContent = 'Pays down your credit card dues and reduces overall balance.';
        
        if (lentContainer) lentContainer.style.display = 'none';
        if (lentWrap) lentWrap.style.display = 'none';
        if (lentToggle) lentToggle.checked = false;
      }
      return;
    }
    const shareBtn = ev.target.closest('[data-share-split]');
    if (shareBtn) {
      const id = shareBtn.dataset.shareSplit;
      shareBtn.disabled = true;
      try{
        const res = await fetch('/api/split/share', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({key: 'split:' + id})
        });
        if(res.status === 401){ onAuthRequired(); return; }
        const body = await res.json();
        if(!res.ok){
          showToast(body.error || 'Could not create a share link');
          return;
        }
        await navigator.clipboard.writeText(body.url);
        showToast('Link copied! Anyone with this link can view the split.');
      }catch(e){
        console.error('share link failed', e);
        showToast('Failed to copy link.');
      }finally{
        shareBtn.disabled = false;
      }
      return;
    }
    const formBtn = ev.target.closest('[data-form]');
    if(formBtn){
      const newForm = formBtn.dataset.form;
      const oldForm = State.openForm;
      if (State.animTimeout) clearTimeout(State.animTimeout);

      if (oldForm === newForm) { // Toggle Off
        State.openForm = null; 
        render();
        return;
      }
      if (oldForm) { // Switch sibling forms
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
          }, 300); // Changed to 300
        } else { State.openForm = newForm; State.formSlideDirection = ''; render(); }
        return;
      }
      // Open fresh
      State.openForm = newForm;
      State.formSlideDirection = '';
      await render();
      return;
    }

    const closeForm = ev.target.closest('[data-close-form]');
    if(closeForm){
      if (State.animTimeout) clearTimeout(State.animTimeout);
      State.openForm = null; 
      render();
      return;
    }

    const addLentRow = ev.target.closest('[data-add-lent-row]');
    if(addLentRow){
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
    if(removeLentRow){ removeLentRow.closest('.lent-row').remove(); return; }

    const submitBtn = ev.target.closest('[data-submit]');
    if(submitBtn){ await handleSubmit(submitBtn.dataset.submit); return; }

    const delEntry = ev.target.closest('[data-del-entry]');
    if(delEntry){
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
      
      data.entries = data.entries.filter(e=>e.id!==id);
      await saveMonth(mk);
      await render();
      showToast('Entry removed');
      return;
    }
    const delEmiSeriesBtn = ev.target.closest('[data-del-emi-series]');
    if (delEmiSeriesBtn) {
      ev.stopPropagation();
      showDeleteCallout(delEmiSeriesBtn, 'confirm-del-emi-series', delEmiSeriesBtn.dataset.delEmiSeries);
      return;
    }
    const confirmDelEmiSeries = ev.target.closest('[data-confirm-del-emi-series]');
    if (confirmDelEmiSeries) {
      ev.stopPropagation();
      const seriesId = confirmDelEmiSeries.dataset.confirmDelEmiSeries;
      
      // Filter out the series from global state and save to the database
      State.emiSeries = State.emiSeries.filter(s => s.id !== seriesId);
      await Store.set('emiseries', State.emiSeries);
      
      hideDeleteCallout();
      await render();
      showToast('EMI deleted entirely');
      return;
    }
    const skipSipBtn = ev.target.closest('[data-skip-sip]');
    if (skipSipBtn) {
      ev.stopPropagation();
      showDeleteCallout(skipSipBtn, 'confirm-skip-sip', skipSipBtn.dataset.skipSip, 'Confirm skip');
      return;
    }
    const confirmSkipSip = ev.target.closest('[data-confirm-skip-sip]');
    if (confirmSkipSip) {
      ev.stopPropagation();
      const [mk, seriesId] = confirmSkipSip.dataset.confirmSkipSip.split('|');
      const data = await loadMonth(mk);
      data.deletedSip = data.deletedSip || [];
      if(!data.deletedSip.includes(seriesId)) data.deletedSip.push(seriesId);
      await saveMonth(mk);
      hideDeleteCallout();
      await render();
      showToast("Skipped this month's SIP — balance updated");
      return;
    }
    const delSipSeriesBtn = ev.target.closest('[data-del-sip-series]');
    if (delSipSeriesBtn) {
      ev.stopPropagation();
      showDeleteCallout(delSipSeriesBtn, 'confirm-del-sip-series', delSipSeriesBtn.dataset.delSipSeries);
      return;
    }
    const confirmDelSipSeries = ev.target.closest('[data-confirm-del-sip-series]');
    if (confirmDelSipSeries) {
      ev.stopPropagation();
      const seriesId = confirmDelSipSeries.dataset.confirmDelSipSeries;

      // Filter out the series from global state and save to the database
      State.sipSeries = State.sipSeries.filter(s => s.id !== seriesId);
      await Store.set('sipseries', State.sipSeries);

      hideDeleteCallout();
      await render();
      showToast('SIP deleted entirely');
      return;
    }
    const settleOwed = ev.target.closest('[data-settle-owed]');
    if(settleOwed){
      const [mk, id] = settleOwed.dataset.settleOwed.split('|');
      const data = await loadMonth(mk);
      const entry = data.entries.find(e=>e.id===id);
      if(entry && !entry.settled){
        entry.settled = true;
        data.entries.push({
          id: uid(), type:'income',
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
    if(settleLent){
      const [entryId, lentId] = settleLent.dataset.settleLent.split('|');
      const mk = State.currentMonthKey;
      const data = await loadMonth(mk);
      const entry = data.entries.find(e=>e.id===entryId);
      if(entry){
        const l = (entry.lent||[]).find(x=>x.id===lentId);
        if(l && !l.settled){
          l.settled = true;
          data.entries.push({
            id: uid(), type:'income',
            description: `Payback @${l.person} - ${entry.description}`,
            amount: l.amount, date: todayStr(), category: 'Friends',
            linkedLent: { spendId: entry.id, lentId: l.id } // Adds the tracking linkage
          });
        }
      }
      await saveMonth(mk);
      await render();
      showToast('Marked as paid back — added as income');
      return;
    }
    const delCard = ev.target.closest('[data-del-card]');
    if(delCard){
      State.cards = State.cards.filter(c=>c.id!==delCard.dataset.delCard);
      await Store.set('creditcards', State.cards);
      await render();
      showToast('Card removed');
      return;
    }
    const addCard = ev.target.closest('#cc-add');
    if(addCard){
      const name = $('#cc-name').value.trim();
      const day = Number($('#cc-day').value);
      if(!name || !day || day<1 || day>31){ showToast('Enter a card name and a valid billing day (1–31)'); return; }
      State.cards.push({id:uid(), name, billingDay:day});
      await Store.set('creditcards', State.cards);
      await render();
      showToast('Card added');
      return;
    }
    const addSip = ev.target.closest('#sip-add');
    if(addSip){
      const desc = $('#sip-desc').value.trim();
      const amount = Number($('#sip-amount').value);
      if(!desc || !amount || amount<=0){ showToast('Enter a description and a valid amount'); return; }
      State.sipSeries.push({id:uid(), description:desc, amount, startMonth: currentMonthKey()});
      await Store.set('sipseries', State.sipSeries);
      await render();
      showToast('SIP added');
      return;
    }

    /* ----- Split Money ----- */
    const splitFormToggle = ev.target.closest('[data-split-form-toggle]');
    if(splitFormToggle){
      if (State.animTimeout) clearTimeout(State.animTimeout);
      State.splitFormOpen = !State.splitFormOpen;
      await render();
      return;
    }

    const closeSplitForm = ev.target.closest('[data-close-split-form]');
    if(closeSplitForm){
      if (State.animTimeout) clearTimeout(State.animTimeout);
      State.splitFormOpen = false;
      render();
      return;
    }

    const addSplitMember = ev.target.closest('[data-add-split-member]');
    if(addSplitMember){
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
    if(removeSplitMember){ removeSplitMember.closest('.split-member-row').remove(); return; }

	const openSplitSpendForm = ev.target.closest('[data-open-split-spend-form]');
    if(openSplitSpendForm){
      State.splitSpendFormOpen = true;
      await render();
      return;
    }

    const closeSplitSpendForm = ev.target.closest('[data-close-split-spend-form]');
    if(closeSplitSpendForm){
      State.splitSpendFormOpen = false;
      await render();
      return;
    }
	
    const submitSplit = ev.target.closest('[data-submit-split]');
    if(submitSplit){
      const desc = ($('#sf-desc').value || '').trim();
      const members = $$('.sf-member').map(i=>i.value.trim()).filter(Boolean);
      if(!desc){ showToast('Enter a group description'); return; }
      if(members.length < 2){ showToast('Add at least two people to split with'); return; }
      const seen = new Set();
      const people = [];
      for(const m of members){
        const key = m.toLowerCase();
        if(seen.has(key)) continue;
        seen.add(key); people.push(m);
      }
      await createSplitGroup(desc, people);
      State.splitFormOpen = false;
      await render();
      showToast('Split group created');
      return;
    }
    
    const delSplitBtn = ev.target.closest('[data-del-split]');
    if(delSplitBtn){
      ev.stopPropagation(); // Prevents the card from expanding/collapsing when clicking the X
      showDeleteCallout(delSplitBtn, 'confirm-del-split', delSplitBtn.dataset.delSplit);
      return;
    }
    const confirmDelSplit = ev.target.closest('[data-confirm-del-split]');
    if(confirmDelSplit){
      ev.stopPropagation();
      await deleteSplitGroup(confirmDelSplit.dataset.confirmDelSplit);
      hideDeleteCallout();
      await render();
      showToast('Split group deleted');
      return;
    }
    const cancelDel = ev.target.closest('[data-cancel-del]');
    if (cancelDel) {
      ev.stopPropagation();
      hideDeleteCallout();
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
	  if(splitCard && !State.isShared && !ev.target.closest('.sgc-actions')){
      const id = splitCard.dataset.splitCard;
      if (State.animTimeout) clearTimeout(State.animTimeout);

      if (State.splitExpandedId === id) { // Close
        State.splitExpandedId = null; 
        State.splitSpendFormOpen = false; // <-- Add here
        render();
        return;
      }
      if (State.splitExpandedId) { // Switch between split cards
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
            State.splitSpendFormOpen = false; // <-- Add here
            State.splitSlideDirection = isRight ? 'slide-in-right' : 'slide-in-left';
            render();
          }, 300);
        } else { State.splitExpandedId = id; State.splitSpendFormOpen = false; /* <-- Add here */ State.splitSlideDirection = ''; render(); }
        return;
      }
      // Open fresh
      State.splitExpandedId = id;
      State.splitSpendFormOpen = false; // <-- Add here
      State.splitSlideDirection = '';
      await render();
      return;
    }
    
    const submitSplitSpend = ev.target.closest('[data-submit-split-spend]');
    if(submitSplitSpend){
      const groupId = submitSplitSpend.dataset.submitSplitSpend;
      const desc = ($('#sp-desc').value || '').trim();
      const payee = $('#sp-payee').value;
      const date = $('#sp-date').value || todayStr();
      const amount = Number($('#sp-amount').value);
      if(!desc || !amount || amount<=0){ showToast('Enter a spend description and amount'); return; }
      const shares = {};
      let shareSum = 0;
      $$('.sp-share').forEach(inp=>{
        const v = Number(inp.value)||0;
        shares[inp.dataset.person] = v;
        shareSum += v;
      });
      if(Math.abs(shareSum - amount) > 0.01){
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
          lent: [] // Lent tracking is now exclusive to manual ledger entries
        };
        monthData.entries.push(ledgerEntry);
        await saveMonth(ledgerMonthKey);
        ledgerEntryId = entryId;
      }

      group.spends.push({ id: spendId, description: desc, payee, amount, date, shares, ledgerEntryId, monthKey: ledgerMonthKey });
      await saveSplit(groupId);
	  State.splitSpendFormOpen = false;
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
    if (ev.target.matches('.sp-member-toggle')) {
      const totalAmt = Number($('#sp-amount')?.value) || 0;
      distributeSplitShares(totalAmt);
      return;
    }
    if(ev.target.id === 'f-tag'){
      const val = ev.target.value.toLowerCase();
      const customWrap = $('#f-tag-custom-wrap');
      if(customWrap) customWrap.style.display = val === '__custom__' ? 'block' : 'none';

      // Price Tracker form dynamic fields
      const ptDynamicWrap = $('#pt-dynamic-fields');
      if (ptDynamicWrap) {
        if (val === 'groceries') {
          ptDynamicWrap.innerHTML = `<div class="field"><label>Quantity</label><input id="pt-quantity" type="text" placeholder="e.g. 1kg or 1L" /></div>`;
        } else if (val === 'transport') {
          ptDynamicWrap.innerHTML = `
            <div class="field"><label>Source</label><input id="pt-source" type="text" placeholder="e.g. Home" /></div>
            <div class="field"><label>Destination</label><input id="pt-destination" type="text" placeholder="e.g. Office" /></div>
          `;
        } else {
          ptDynamicWrap.innerHTML = '';
        }
      }

      // Spend form dynamic fields
      const spendDynamicWrap = $('#spend-dynamic-fields');
      if (spendDynamicWrap) {
        if (val === 'groceries') {
          spendDynamicWrap.innerHTML = `<div class="field"><label>Quantity</label><input id="sp-quantity" type="text" placeholder="e.g. 1kg or 1L" /></div>`;
        } else if (val === 'transport') {
          spendDynamicWrap.innerHTML = `
            <div class="field"><label>Source</label><input id="sp-source" type="text" placeholder="e.g. Home" /></div>
            <div class="field"><label>Destination</label><input id="sp-destination" type="text" placeholder="e.g. Office" /></div>
          `;
        } else {
          spendDynamicWrap.innerHTML = '';
        }
      }
    }
    if(ev.target.id === 'f-lent-toggle'){
      const lentWrap = $('#f-lent-wrap');
      if(lentWrap) lentWrap.style.display = ev.target.checked ? 'block' : 'none';
    }
    if(ev.target.name === 'sbmode'){
      const mk = State.currentMonthKey;
      const data = await loadMonth(mk);
      data.startingBalanceMode = ev.target.value;
      await saveMonth(mk);
      await render();
    }
    if(ev.target.id === 'starting-balance-manual'){
      const mk = State.currentMonthKey;
      const data = await loadMonth(mk);
      data.startingBalance = Number(ev.target.value)||0;
      await saveMonth(mk);
      await render();
    }
    if(ev.target.matches('[data-settle-toggle]')){
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
          const {cards} = computeGroupSettlementView(group);
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
    if(ev.target.id === 'sp-amount'){
      distributeSplitShares(Number(ev.target.value) || 0);
    }
  };

  app.onmouseover = (ev) => {
    if(!window.matchMedia('(hover: hover)').matches) return;
    const trigger = ev.target.closest('[data-spend-toggle]');
    if(trigger) showSplitCallout(trigger);
  };
  app.onmouseout = (ev) => {
    if(!window.matchMedia('(hover: hover)').matches) return;
    const trigger = ev.target.closest('[data-spend-toggle]');
    if(!trigger) return;
    const key = trigger.dataset.spendShares;
    if(State.splitCalloutPinned === key) return; // stays open, it's pinned via click
    if(trigger.contains(ev.relatedTarget)) return;
    hideSplitCallout();
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

async function handleSubmit(kind){
  const mk = State.currentMonthKey;
  const data = await loadMonth(mk);
  const desc = ($('#f-desc')?.value||'').trim();
  const amount = Number($('#f-amount')?.value);
  const date = $('#f-date')?.value || todayStr();

  function collectLent(){
    let lent = [];
    if($('#f-lent-toggle') && $('#f-lent-toggle').checked){
      $$('.lent-row').forEach(row=>{
        const person = row.querySelector('.lent-person').value.trim();
        const amt = Number(row.querySelector('.lent-amount').value);
        if(person && amt>0) lent.push({id:uid(), person, amount:amt, settled:false});
      });
    }
    return lent;
  }

  if(kind==='spend'){
    const modeBtn = document.querySelector('[data-spend-mode].active');
    const uimode = modeBtn ? modeBtn.dataset.spendMode : 'regular';
    
    let desc = '';
    let tag = '';
    let mode = 'cash'; // internal tracking parameter
    let cardId = null;
    if (uimode === 'regular') {
      desc = ($('#f-desc')?.value||'').trim();
      tag = await resolveTagFromForm();
    } else if (uimode === 'atm') {
      desc = 'Cash Withdrawal';
      tag = 'ATM';
    } else if (uimode === 'card') {
      cardId = $('#f-card').value;
      const c = cardById(cardId);
      if(!c){ showToast('Add a credit card first'); return; }
      desc = c.name + ' Bill Payment';
      tag = 'CC due';
      mode = 'card';
    }
    if(!desc || !amount || amount<=0){ showToast('Enter a spend description and amount'); return; }

    if (uimode === 'regular') {
      const syncBtn = $('#f-price-track-btn');
      if (syncBtn && syncBtn.classList.contains('active')) {
        let meta = {};
        const catLower = (tag || '').toLowerCase();
        if (catLower === 'groceries') meta.quantity = $('#sp-quantity')?.value || '';
        if (catLower === 'transport') {
          meta.source = $('#sp-source')?.value || '';
          meta.destination = $('#sp-destination')?.value || '';
        }

        State.priceTrackDictionary[desc] = { category: tag, meta };
        Store.set('price-track-dict', State.priceTrackDictionary);

        let item = State.priceItems.find(i => i.name.toLowerCase() === desc.toLowerCase());
        if (!item) {
          item = { id: uid(), name: desc, category: tag, history: [], meta };
          State.priceItems.push(item);
        } else {
          item.meta = meta; // Refresh metadata
        }
        item.history.push({ id: uid(), date, price: amount, note: 'Synced from Spends' });
        Store.set('price-items', State.priceItems);
      }
    }
    data.entries.push({id:uid(), type:'spend', description:desc, amount, date, paymentMode:mode, cardId, tag, lent:collectLent()});
  }
  else if(kind==='cardcharge'){
    if(!desc || !amount || amount<=0){ showToast('Enter a spend description and amount'); return; }
    const cardId = $('#f-card').value;
    const c = cardById(cardId);
    if(!c){ showToast('Add a credit card first'); return; }
    const tag = await resolveTagFromForm();
    data.entries.push({id:uid(), type:'cardcharge', description:desc, amount, date, cardId, tag, lent:collectLent()});
  }
  else if(kind==='cashpayment'){
    if(!desc || !amount || amount<=0){ showToast('Enter a spend description and amount'); return; }
    const tag = await resolveTagFromForm();
    data.entries.push({id:uid(), type:'cashpayment', description:desc, amount, date, tag});
  }
  else if(kind==='income'){
    if(!desc || !amount || amount<=0){ showToast('Enter a source and amount'); return; }
    const category = $('#f-income-category')?.value || '';
    data.entries.push({id:uid(), type:'income', description:desc, amount, date, category});
  }
  else if(kind==='owed'){
    if(!desc || !amount || amount<=0){ showToast('Enter a person and amount'); return; }
    data.entries.push({id:uid(), type:'owed', description:desc, amount, date, settled:false});
  }
  else if(kind==='invest'){
    if(!desc || !amount || amount<=0){ showToast('Enter a description and amount'); return; }
    data.entries.push({id:uid(), type:'investment', description:desc, amount, date});
  }
  else if(kind==='emi'){
    const months = Number($('#f-months')?.value);
    const startMonth = $('#f-emi-start')?.value || mk;
    
    if(!desc || !amount || amount<=0 || !months || months<1){ 
      showToast('Fill in description, amount and number of months'); 
      return; 
    }
    
    // Calculate if the EMI is already complete based on the selected starting month
    const elapsed = diffMonths(startMonth, currentMonthKey());
    if (elapsed >= months) {
      showToast('Invalid: EMI is already complete based on the starting month.');
      return;
    }

    State.emiSeries.push({
      id: uid(), 
      description: desc, 
      monthlyAmount: amount, 
      totalMonths: months, 
      startMonth: startMonth // Now strictly uses the user-defined date
    });
    
    await Store.set('emiseries', State.emiSeries);
  }

  await saveMonth(mk);
  State.openForm = null;
  await render();
  showToast('Added');
}

/* ---------- Google Sign-In ---------- */
function initGoogleSignIn(){
  if(!window.google || !window.google.accounts || !window.google.accounts.id){
    // gsi/client script hasn't finished loading yet — retry briefly.
    setTimeout(initGoogleSignIn, 250);
    return;
  }
  if(!AppConfig.googleClientId){
    console.warn('GOOGLE_CLIENT_ID is not configured on the server.');
    return;
  }
  google.accounts.id.initialize({
    client_id: AppConfig.googleClientId,
    callback: handleGoogleCredential,
    auto_select: false,
    cancel_on_tap_outside: true,
  });
  const cornerEl = document.getElementById('google-signin-btn');
  if(cornerEl){
    const cornerEl = document.getElementById('google-signin-btn');
    renderGoogleButton(cornerEl, {
      type: 'standard', theme: 'outline', size: 'medium', shape: 'pill', text: 'signin_with', logo_alignment: 'left',
      width: '200',
    });
  }
}
function renderGoogleButton(container, opts){
  if(!container) return;
  if(!window.google || !window.google.accounts || !window.google.accounts.id){
    setTimeout(() => renderGoogleButton(container, opts), 250);
    return;
  }
  google.accounts.id.renderButton(container, opts);
}
async function handleGoogleCredential(response){
  try{
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({credential: response.credential})
    });
    const body = await res.json().catch(() => ({}));
    if(!res.ok){
      showToast(body.error || 'Sign-in failed, please try again');
      return;
    }
    State.user = body.user;
    updateProfileBadge();
    if(!State.isShared){
      await loadCore();
      State.view = 'home';
    }
    await render();
    showToast(`Welcome, ${(body.user.name || '').split(' ')[0] || 'there'}!`);
  }catch(e){
    console.error('Google sign-in failed', e);
    showToast('Sign-in failed — check your connection.');
  }
}
async function checkAuth(){
  try{
    const res = await fetch('/api/auth/me');
    const body = await res.json();
    State.user = body.authenticated ? body.user : null;
  }catch(e){
    console.error('auth check failed', e);
    State.user = null;
  }
  updateProfileBadge();
  return State.user;
}
async function signOut(){
  try{
    await fetch('/api/auth/logout', {method: 'POST'});
  }catch(e){
    console.error('logout request failed', e);
  }
  if(window.google?.accounts?.id) google.accounts.id.disableAutoSelect();
  State.user = null;
  State.cards = [];
  State.emiSeries = [];
  State.emiSeries = [];
  State.monthsIndex = [];
  State.monthCache = {};
  State.customTags = [];
  State.splitsIndex = [];
  State.splitCache = {};
  State.splitExpandedId = null;
  State.view = 'home';
  updateProfileBadge();
  await render();
  showToast('Signed out');
}
function updateProfileBadge(){
  const signinEl = document.getElementById('google-signin-btn');
  const badgeEl = document.getElementById('profile-badge');
  const menuEl = document.getElementById('profile-menu');
  if(!signinEl || !badgeEl) return;

  if(State.user){
    signinEl.hidden = true;
    badgeEl.hidden = false;
    const avatar = document.getElementById('profile-avatar');
    const nameEl = document.getElementById('profile-name');
    const emailEl = document.getElementById('profile-menu-email');
    const firstName = (State.user.name || '').trim().split(/\s+/)[0] || 'Account';
    if(avatar){
      avatar.onerror = () => { avatar.style.display = 'none'; };
      avatar.style.visibility = 'visible';
      if(State.user.picture){
        avatar.style.display = '';
        avatar.src = State.user.picture;
      } else {
        avatar.style.display = 'none';
      }
      avatar.alt = State.user.name || '';
    }
    // if(nameEl) nameEl.textContent = firstName;
    if(emailEl) emailEl.textContent = State.user.email || '';
  } else {
    signinEl.hidden = false;
    badgeEl.hidden = true;
    if(menuEl) menuEl.hidden = true;
  }
}
function wireAuthBar(){
  const badgeBtn = document.getElementById('profile-badge-btn');
  const menuEl = document.getElementById('profile-menu');
  const signoutBtn = document.getElementById('profile-signout-btn');

  if(badgeBtn && menuEl){
    badgeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const willOpen = menuEl.hidden;
      menuEl.hidden = !willOpen;
      badgeBtn.setAttribute('aria-expanded', String(willOpen));
    });
    document.addEventListener('click', (ev) => {
      const badge = document.getElementById('profile-badge');
      if(badge && !badge.contains(ev.target)){
        menuEl.hidden = true;
        badgeBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }
  if(signoutBtn){
    signoutBtn.addEventListener('click', () => {
      if(menuEl) menuEl.hidden = true;
      signOut();
    });
  }
}

/* ---------- Boot ---------- */
(async function init() {
  wireAuthBar();
  initGoogleSignIn();

  // Path-based public share route: /share/split/<share_id>
  // (also accepts a legacy ?share=<id> query param for old links)
  const pathMatch = window.location.pathname.match(/^\/share\/split\/([^/]+)\/?$/);
  const legacyShareId = new URLSearchParams(window.location.search).get('share');
  const shareId = pathMatch ? decodeURIComponent(pathMatch[1]) : legacyShareId;

  if (shareId) {
    // Shared Read-Only Mode — no login required, data comes from the
    // public API and is scoped entirely to this one split group.
    State.isShared = true;
    State.sharedSplitId = shareId;
    State.view = 'split';
    State.splitExpandedId = shareId;
    document.body.classList.add('shared-mode'); // Locks down UI via CSS
    await checkAuth(); // still shows the signed-in badge if the viewer happens to be logged in
    await loadSharedSplit();
  } else {
    const user = await checkAuth();
    if (user) await loadCore();
  }
  await render();
})();
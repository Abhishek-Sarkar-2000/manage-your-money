/* ---------- Split Money: persistence + greedy settlement engine ----------
   Ported verbatim from the monolith. Note the circular import with
   domain.js (toggleSplitSettlement needs loadMonth/saveMonth to sync the
   ledger; domain.js's computeGlobalOwed needs computeSplitPageData) — both
   only touch the imported functions inside function bodies, which ES
   modules resolve fine via live bindings. */
import { Store } from './store.js';
import { uid, escapeHtml } from './dom.js';
import { todayStr, currentMonthKey } from './format.js';
import { loadMonth, saveMonth, ensureMonthIndexed } from './domain.js';

export const SPLIT_YOU = 'YOU';

const splitCache = {};

export function getYouLabel(isShared, sharedOwner, possessive = false) {
  if (isShared) {
    const rawName = sharedOwner && sharedOwner.name;
    const name = rawName ? rawName.split(' ')[0].toUpperCase() : 'OWNER';
    return possessive ? `${name}'s` : name;
  }
  return possessive ? 'YOUR' : 'YOU';
}

export async function loadSplit(id, isShared) {
  if (isShared) {
    // Public split data is fetched once via loadSharedSplit() and never
    // touches the authenticated /api/storage endpoints.
    return splitCache[id] || null;
  }
  if (splitCache[id]) return splitCache[id];
  const data = await Store.get('split:' + id, null);
  if (data) {
    data.spends = data.spends || [];
    data.settlements = data.settlements || [];
    data.people = data.people && data.people.length ? data.people : [SPLIT_YOU];
    splitCache[id] = data;
  }
  return data;
}

export async function loadSharedSplit(shareId) {
  try {
    const res = await fetch('/api/public/split/' + encodeURIComponent(shareId));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      splitCache[shareId] = null;
      return { group: null, owner: null, error: body.error || null };
    }
    const body = await res.json();
    const group = body.group || null;
    if (group) {
      group.spends = group.spends || [];
      group.settlements = group.settlements || [];
      group.people = group.people && group.people.length ? group.people : [SPLIT_YOU];
    }
    splitCache[shareId] = group;
    return { group, owner: body.owner || null, error: null };
  } catch (e) {
    console.error('failed to load shared split', e);
    splitCache[shareId] = null;
    return { group: null, owner: null, error: 'Could not load this shared split.' };
  }
}

export async function saveSplit(id) {
  await Store.set('split:' + id, splitCache[id]);
}

export async function createSplitGroup(splitsIndex, description, people) {
  const id = 'split_' + uid();
  const group = { id, createdAt: todayStr(), description, people, spends: [], settlements: [] };
  splitCache[id] = group;
  await Store.set('split:' + id, group);
  splitsIndex.push(id);
  await Store.set('splits-index', splitsIndex);
  return id;
}

export async function deleteSplitGroup(splitsIndex, id) {
  const idx = splitsIndex.indexOf(id);
  if (idx !== -1) splitsIndex.splice(idx, 1);
  await Store.set('splits-index', splitsIndex);
  delete splitCache[id];
  await Store.remove('split:' + id);
}

export async function loadAllSplitGroups(splitsIndex) {
  const groups = [];
  for (const id of splitsIndex) {
    const g = await loadSplit(id, false);
    if (g) groups.push(g);
  }
  groups.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || (b.id || '').localeCompare(a.id || ''));
  return groups;
}

export function computeGroupPaid(group) {
  const paid = {};
  for (const p of group.people) paid[p] = 0;
  for (const s of group.spends) {
    paid[s.payee] = (paid[s.payee] || 0) + (Number(s.amount) || 0);
  }
  return paid;
}

export function computeGroupNet(group) {
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

export function applySettledAdjustments(net, settlements) {
  const adjusted = { ...net };
  for (const st of (settlements || [])) {
    if (!st.settled) continue;
    adjusted[st.from] = (adjusted[st.from] || 0) + (Number(st.amount) || 0);
    adjusted[st.to] = (adjusted[st.to] || 0) - (Number(st.amount) || 0);
  }
  return adjusted;
}

export function greedySettle(net) {
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

/* Returns {rawNet, paid, cards} where cards = settled records (from
   storage) + freshly computed outstanding transfers (virtual, unsaved
   until toggled). */
export function computeGroupSettlementView(group) {
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

export async function computeSplitPageData(isShared, sharedSplitId, splitsIndex) {
  let groups = [];
  if (isShared) {
    const singleGroup = await loadSplit(sharedSplitId, true);
    if (singleGroup) groups.push(singleGroup);
  } else {
    groups = await loadAllSplitGroups(splitsIndex || []);
  }
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

export async function computeGlobalSplitOwedByYou(splitsIndex) {
  const { owedByYou } = await computeSplitPageData(false, null, splitsIndex);
  const list = Object.entries(owedByYou).map(([person, amount]) => ({ person, amount })).sort((a, b) => b.amount - a.amount);
  const total = list.reduce((s, x) => s + x.amount, 0);
  return { total, list };
}

/* ---------- Split Money: ledger sync (reversible) ---------- */
export async function toggleSplitSettlement(groupId, transferId, from, to, amount, groupDesc, willSettle, monthsIndex) {
  const group = await loadSplit(groupId, false);
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
      await ensureMonthIndexed(mk, monthsIndex);
      const monthData = await loadMonth(mk);
      let entry;
      if (from === SPLIT_YOU) {
        entry = { id: uid(), type: 'spend', description: `Settled to ${to} - ${groupDesc}`, amount: Number(amount), date: todayStr(), paymentMode: 'cash', cardId: null, tag: 'split', lent: [] };
      } else {
        entry = { id: uid(), type: 'spend', description: `Received settlement from ${from} - ${groupDesc}`, amount: -Number(amount), date: todayStr(), paymentMode: 'cash', cardId: null, tag: 'split', lent: [] };
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

export async function settleAllInGroup(group, monthsIndex) {
  const { cards } = computeGroupSettlementView(group);
  const outstanding = cards.filter(c => !c.settled);
  for (const c of outstanding) {
    await toggleSplitSettlement(group.id, c.id, c.from, c.to, c.amount, group.description, true, monthsIndex);
  }
}

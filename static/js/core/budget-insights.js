import { forecastCategorySpend, matchesCategory, spendingAmountForEntry } from './domain.js';

const CC_DUES_SYSTEM_TYPE = 'credit-card-dues';
const AUTO_SYSTEM_TYPE = 'auto-spends';

function isSystemGroup(group) {
  return group?.systemType === CC_DUES_SYSTEM_TYPE || group?.systemType === AUTO_SYSTEM_TYPE;
}

function usageForEntry(entry, name, isSub, parentName, systemRef = null) {
  if (!entry) return 0;

  const type = String(entry.type || '').toLowerCase();
  if (type === 'income' || type === 'payback' || type === 'goal_funding') return 0;

  if (systemRef?.cardId) {
    const amount = Number(entry.amount) || 0;
    const isCardPayment = amount > 0 && type === 'spend' && String(entry.tag || '').trim().toLowerCase() === 'cc due' && entry.cardId === systemRef.cardId;
    return isCardPayment ? amount : 0;
  }

  const amount = spendingAmountForEntry(entry);
  if (amount <= 0) return 0;

  if (systemRef?.seriesId) return entry.seriesId === systemRef.seriesId ? amount : 0;
  return matchesCategory(entry, name, isSub, parentName) ? amount : 0;
}

function categoryUsed(category, group, entries) {
  const subcategories = Array.isArray(category?.subcategories) ? category.subcategories : [];

  if (isSystemGroup(group) && subcategories.length) {
    return subcategories.reduce((total, sub) => {
      const subUsed = entries.reduce((sum, entry) => sum + usageForEntry(entry, sub.name, true, category.name, { cardId: sub.systemCardId || null, seriesId: sub.systemSeriesId || null }), 0);
      return total + subUsed;
    }, 0);
  }

  return entries.reduce((sum, entry) => sum + usageForEntry(entry, category.name, false, null), 0);
}

function categoryCapturesEntry(category, group, entry) {
  const subcategories = Array.isArray(category?.subcategories) ? category.subcategories : [];

  if (isSystemGroup(group) && subcategories.length) {
    return subcategories.some(sub => usageForEntry(entry, sub.name, true, category.name, { cardId: sub.systemCardId || null, seriesId: sub.systemSeriesId || null }) > 0);
  }

  return usageForEntry(entry, category.name, false, null) > 0;
}

function calculateUnbudgeted(groups, entries) {
  const byLabel = new Map();
  let total = 0;

  for (const entry of entries) {
    const amount = spendingAmountForEntry(entry);
    if (amount <= 0) continue;

    const captured = groups.some(group => (group.categories || []).some(category => categoryCapturesEntry(category, group, entry)));
    if (captured) continue;

    const label = String(entry.tag || entry.category || entry.description || 'Uncategorized').trim() || 'Uncategorized';
    const key = label.toLowerCase();

    total += amount;

    const existing = byLabel.get(key);
    if (existing) {
      existing.amount += amount;
      existing.count += 1;
    } else {
      byLabel.set(key, { label, amount, count: 1 });
    }
  }

  return { total, items: [...byLabel.values()].sort((a, b) => b.amount - a.amount) };
}

function riskRank(category) {
  if (category.overAmount > 0) return 4;
  if (category.projectedOverAmount > 0) return 3;
  if (category.usedPct > 70) return 2;
  return 1;
}

export function analyzeDashboardBudget({ budgetData, postedEntries, scheduledEntries, monthKey }) {
  const groups = Array.isArray(budgetData) ? budgetData : [];
  const posted = Array.isArray(postedEntries) ? postedEntries : [];
  const scheduled = Array.isArray(scheduledEntries) ? scheduledEntries : [];

  const categories = [];

  for (const group of groups) {
    for (const category of (group.categories || [])) {
      const budget = Number(category.budget) || 0;
      const used = categoryUsed(category, group, posted);
      const usedPct = budget > 0 ? (used / budget) * 100 : (used > 0 ? 100 : 0);

      const forecast = group.systemType === CC_DUES_SYSTEM_TYPE ? null : forecastCategorySpend(category.name, false, null, budget, monthKey, scheduled);
      const projected = Math.max(used, Number(forecast?.projectedByMonthEnd) || used);

      const overAmount = budget > 0 ? Math.max(0, used - budget) : (used > 0 ? used : 0);
      const projectedOverAmount = overAmount > 0 || budget <= 0 ? 0 : Math.max(0, projected - budget);

      let status = 'ontrack';
      if (overAmount > 0) status = 'over';
      else if (projectedOverAmount > 0) status = 'forecast';
      else if (usedPct > 70) status = 'high';

      categories.push({
        id: category.id,
        groupId: group.id,
        groupName: group.name || 'Budget',
        name: category.displayName || category.name || 'Budget',
        budget,
        used,
        usedPct,
        remaining: budget - used,
        projected,
        overAmount,
        projectedOverAmount,
        status,
        systemType: category.systemType || group.systemType || null,
      });
    }
  }

  const totalBudget = groups.reduce((sum, group) => sum + (Number(group.budget) || 0), 0);
  const totalUsed = categories.reduce((sum, category) => sum + category.used, 0);
  const totalRemaining = totalBudget - totalUsed;
  const usedPct = totalBudget > 0 ? (totalUsed / totalBudget) * 100 : (totalUsed > 0 ? 100 : 0);
  const unbudgeted = calculateUnbudgeted(groups, posted);
  const totalProjected = categories.reduce((sum, category) => sum + category.projected, 0) + unbudgeted.total;
  const projectedOverAmount = totalBudget > 0 ? Math.max(0, totalProjected - totalBudget) : 0;

  categories.sort((a, b) => riskRank(b) - riskRank(a) || b.usedPct - a.usedPct || b.used - a.used);

  let overallStatus = 'ontrack';
  if (totalUsed > totalBudget && totalUsed > 0) overallStatus = 'over';
  else if (projectedOverAmount > 0) overallStatus = 'forecast';
  else if (usedPct > 70) overallStatus = 'high';

  return {
    hasBudget: totalBudget > 0 || categories.length > 0,
    totalBudget,
    totalUsed,
    totalRemaining,
    usedPct,
    totalProjected,
    projectedOverAmount,
    overallStatus,
    unbudgeted,
    categories,
    riskCount: categories.filter(category => category.overAmount > 0 || category.projectedOverAmount > 0).length,
  };
}

export function applyBudgetForecastProjection(dashboardKpis, budgetSnapshot) {
  const available = Number(dashboardKpis.availableBalance) || 0;
  const postedBudgeted = Number(budgetSnapshot?.totalUsed) || 0;
  const postedUnbudgeted = Number(budgetSnapshot?.unbudgeted?.total) || 0;
  const projectedTotal = Number(budgetSnapshot?.totalProjected) || 0;

  const remainingForecast = Math.max(
    0,
    projectedTotal - postedBudgeted - postedUnbudgeted
  );

  const forecastDeductions = (budgetSnapshot?.categories || [])
    .filter(category =>
      category.systemType !== 'auto-spends' &&
      category.systemType !== 'credit-card-dues'
    )
    .reduce((sum, category) => {
      const remaining = Math.max(
        0,
        (Number(category.projected) || 0) -
        (Number(category.used) || 0)
      );

      return sum + remaining;
    }, 0);

  const forecastRows = forecastDeductions > 0
    ? [{
        label: 'Budget forecast deductions',
        amount: forecastDeductions,
      }]
    : [];

  dashboardKpis.budgetForecastTotal = projectedTotal;
  dashboardKpis.remainingBudgetForecast = remainingForecast;
  dashboardKpis.forecastRows = forecastRows;
  dashboardKpis.monthEndProjection = available - remainingForecast;

  return dashboardKpis;
}
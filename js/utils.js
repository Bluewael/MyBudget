// Shared formatting + helpers.

const DKK = new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'DKK', maximumFractionDigits: 2 });

function fmt(amount) {
  if (amount == null || isNaN(amount)) return '—';
  return DKK.format(amount);
}

// YYYY-MM from a YYYY-MM-DD string
function monthKey(isoDate) {
  return isoDate.slice(0, 7);
}

function monthLabel(monthKeyStr) {
  const [y, m] = monthKeyStr.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

// Stable hash for dedupe: date|amount|normalized-description
function txHash(date, amount, description) {
  const norm = description.trim().replace(/\s+/g, ' ').toLowerCase();
  return `${date}|${amount.toFixed(2)}|${norm}`;
}

function shiftMonth(monthKeyStr, delta) {
  const [y, m] = monthKeyStr.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Pleasant default palette for new categories
const DEFAULT_COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6','#f97316','#6366f1','#84cc16'];
function pickColor(existingCount) {
  return DEFAULT_COLORS[existingCount % DEFAULT_COLORS.length];
}

function currentYear() {
  return new Date().getFullYear();
}

function yearMonths(year) {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}

// Effective budget for a category in a given month. Three-level lookup:
//   1. per-month override (budgets table)
//   2. per-year default (yearlyBudgets table)
//   3. category-wide fallback (category.defaultMonthly)
async function effectiveBudget(categoryId, month, cache) {
  const year = month.slice(0, 4);
  if (cache?.monthOverrides?.has(`${categoryId}|${month}`)) return cache.monthOverrides.get(`${categoryId}|${month}`);
  if (cache?.yearDefaults?.has(`${categoryId}|${year}`)) return cache.yearDefaults.get(`${categoryId}|${year}`);
  if (cache?.categories?.has(categoryId)) return cache.categories.get(categoryId).defaultMonthly || 0;
  const monthOverride = await db.budgets.get([categoryId, month]);
  if (monthOverride) return monthOverride.amount;
  const yearDefault = await db.yearlyBudgets.get([categoryId, Number(year)]);
  if (yearDefault) return yearDefault.amount;
  const cat = await db.categories.get(categoryId);
  return cat ? (cat.defaultMonthly || 0) : 0;
}

// The per-year default lookup used by pages that need it standalone.
async function yearlyDefaultOrFallback(categoryId, year) {
  const yearDefault = await db.yearlyBudgets.get([categoryId, Number(year)]);
  if (yearDefault) return { amount: yearDefault.amount, source: 'year' };
  const cat = await db.categories.get(categoryId);
  return { amount: cat ? (cat.defaultMonthly || 0) : 0, source: 'category' };
}

async function setYearlyDefault(categoryId, year, amount) {
  await db.yearlyBudgets.put({ categoryId, year: Number(year), amount });
}

async function deleteYearlyDefault(categoryId, year) {
  await db.yearlyBudgets.delete([categoryId, Number(year)]);
}

async function setMonthBudget(categoryId, month, amount) {
  // Compare against the effective YEAR default (or category fallback) — deleting
  // the override when the value equals the level above keeps the table clean.
  const year = Number(month.slice(0, 4));
  const yearDef = await db.yearlyBudgets.get([categoryId, year]);
  const catRow = await db.categories.get(categoryId);
  const baseline = yearDef ? yearDef.amount : (catRow ? catRow.defaultMonthly || 0 : 0);
  if (Math.abs(amount - baseline) < 0.005) {
    await db.budgets.delete([categoryId, month]);
  } else {
    await db.budgets.put({ categoryId, month, amount });
  }
}

async function getSetting(key, defaultValue) {
  const row = await db.settings.get(key);
  return row ? row.value : defaultValue;
}

async function setSetting(key, value) {
  await db.settings.put({ key, value });
}

window.fmt = fmt;
window.monthKey = monthKey;
window.monthLabel = monthLabel;
window.txHash = txHash;
window.shiftMonth = shiftMonth;
window.currentMonth = currentMonth;
window.currentYear = currentYear;
window.yearMonths = yearMonths;
window.pickColor = pickColor;
window.effectiveBudget = effectiveBudget;
window.setMonthBudget = setMonthBudget;
window.yearlyDefaultOrFallback = yearlyDefaultOrFallback;
window.setYearlyDefault = setYearlyDefault;
window.deleteYearlyDefault = deleteYearlyDefault;
window.getSetting = getSetting;
window.setSetting = setSetting;

// IndexedDB schema via Dexie
// v2 tables:
//   categories: { id, name, kind ('expense'|'income'), defaultMonthly, color, createdAt }
//   transactions: { id, date (YYYY-MM-DD), description, amount, currency, categoryId, ruleId, hash, importedAt }
//   rules: { id, pattern (lowercased substring), categoryId, createdAt }
//   budgets: { categoryId, month (YYYY-MM), amount } — per-month override of category.defaultMonthly
//   settings: { key, value } — e.g. startBalance_2026 → 50000
// `hash` is the transaction dedupe key (date+amount+description).
// `budgets` primary key is the compound [categoryId+month] (unique by construction).

const db = new Dexie('budget');
db.version(1).stores({
  categories: '++id, name, createdAt',
  transactions: '++id, date, categoryId, hash, importedAt, [date+amount]',
  rules: '++id, pattern, categoryId, createdAt'
});
db.version(2).stores({
  categories: '++id, name, kind, createdAt',
  transactions: '++id, date, categoryId, hash, importedAt, [date+amount]',
  rules: '++id, pattern, categoryId, createdAt',
  budgets: '[categoryId+month], categoryId, month',
  settings: '&key'
}).upgrade(async (tx) => {
  // Existing categories had monthlyBudget; promote it to defaultMonthly + kind='expense'.
  await tx.table('categories').toCollection().modify(c => {
    c.kind = c.kind || 'expense';
    c.defaultMonthly = c.defaultMonthly || c.monthlyBudget || 0;
    delete c.monthlyBudget;
  });
});
db.version(3).stores({
  // v3 adds yearlyBudgets — a per-(category, year) monthly-default that sits
  // between the category's fallback default and the per-month overrides.
  //   Effective budget for (cat, YYYY-MM) =
  //     month override (budgets) → year default (yearlyBudgets) → category.defaultMonthly
  yearlyBudgets: '[categoryId+year], categoryId, year'
});

window.db = db;

// Broadcast a `data-changed` event on any write so pages that aren't currently
// visible can refresh their state. Coalesced via microtask so a bulk import
// dispatches once, not once per row.
(function setupChangeBroadcast() {
  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      window.dispatchEvent(new CustomEvent('data-changed'));
    });
  }
  for (const name of ['categories', 'transactions', 'rules', 'budgets', 'yearlyBudgets', 'settings']) {
    const table = db.table(name);
    table.hook('creating', schedule);
    table.hook('updating', schedule);
    table.hook('deleting', schedule);
  }
})();

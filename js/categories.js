function categoriesPage() {
  return {
    year: new Date().getFullYear(),
    categories: [],
    rules: [],
    transactions: [],
    budgets: [],
    yearlyBudgets: [],   // all rows from db.yearlyBudgets

    async init() {
      await this.refresh();
      window.addEventListener('page-changed', (e) => { if (e.detail === 'categories') this.refresh(); });
      window.addEventListener('budgets-changed', () => this.refresh());
    },

    async refresh() {
      this.categories = await db.categories.orderBy('name').toArray();
      // Default missing fields for categories created on schema v1 (defensive)
      for (const c of this.categories) {
        if (!c.kind) c.kind = 'expense';
        if (c.defaultMonthly == null) c.defaultMonthly = 0;
      }
      this.rules = await db.rules.toArray();
      this.transactions = await db.transactions.toArray();
      this.budgets = await db.budgets.toArray();
      this.yearlyBudgets = await db.yearlyBudgets.toArray();
    },

    prevYear() { this.year -= 1; },
    nextYear() { this.year += 1; },

    // The value shown/edited in the "Default (DKK)" input for a given row and the
    // current `this.year`. Uses the yearlyBudgets row if it exists, otherwise
    // falls back to the category's legacy defaultMonthly.
    yearDefaultFor(catId) {
      const row = this.yearlyBudgets.find(y => y.categoryId === catId && y.year === this.year);
      if (row) return row.amount;
      const cat = this.categories.find(c => c.id === catId);
      return cat ? (cat.defaultMonthly || 0) : 0;
    },

    // True when the displayed value is inherited from category.defaultMonthly
    // rather than explicitly set for the current year.
    isYearInherited(catId) {
      return !this.yearlyBudgets.some(y => y.categoryId === catId && y.year === this.year);
    },

    // How many years have an explicit override for this category
    yearOverrideCount(catId) {
      return this.yearlyBudgets.filter(y => y.categoryId === catId).length;
    },

    async saveYearDefault(c, val) {
      const amount = Number(val) || 0;
      await setYearlyDefault(c.id, this.year, amount);
      // Keep the legacy category.defaultMonthly in sync with the CURRENT-year
      // value (only) so old fallback lookups still make sense.
      if (this.year === new Date().getFullYear()) {
        await db.categories.update(c.id, { defaultMonthly: amount });
        c.defaultMonthly = amount;
      }
      await this.refresh();
    },

    overrideCount(catId) {
      return this.budgets.filter(b => b.categoryId === catId).length;
    },

    openMonths(c) {
      // Pass the currently selected year so the modal opens on the same year
      window.openBudgetModal({ categoryId: c.id, year: this.year });
    },

    matchCount(pattern) {
      const p = (pattern || '').toLowerCase().trim();
      if (!p) return 0;
      return this.transactions.filter(t => t.description.toLowerCase().includes(p)).length;
    },

    // When a rule's pattern is edited:
    //   - normalize and validate
    //   - update the rule
    //   - revert transactions that this rule had auto-applied but no longer match
    //   - apply the rule to any currently-uncategorized transactions that now match
    async savePattern(r) {
      const newPattern = (r.pattern || '').toLowerCase().trim();
      if (newPattern.length < 2) {
        alert('Pattern must be at least 2 characters.');
        await this.refresh();
        return;
      }
      r.pattern = newPattern;
      await db.rules.update(r.id, { pattern: newPattern });

      await db.transaction('rw', db.transactions, async () => {
        const all = await db.transactions.toArray();
        for (const tx of all) {
          const matches = tx.description.toLowerCase().includes(newPattern);
          if (tx.ruleId === r.id && !matches) {
            // Was auto-applied by this rule, no longer fits → revert to uncategorized
            await db.transactions.update(tx.id, { categoryId: null, ruleId: null });
          } else if (matches && !tx.categoryId) {
            // Uncategorized transaction that now matches → auto-apply
            await db.transactions.update(tx.id, { categoryId: r.categoryId, ruleId: r.id });
          }
        }
      });
      await this.refresh();
    },

    async saveCategory(r) {
      const newCatId = Number(r.categoryId);
      await db.rules.update(r.id, { categoryId: newCatId });
      // Update all transactions auto-applied by this rule to the new category
      await db.transactions.where('ruleId').equals(r.id).modify({ categoryId: newCatId });
      await this.refresh();
    },

    async add() {
      const id = await db.categories.add({
        name: 'New category',
        kind: 'expense',
        defaultMonthly: 0,
        color: pickColor(this.categories.length),
        createdAt: Date.now()
      });
      await this.refresh();
      // Focus the new row's name field for quick rename
      this.$nextTick(() => {
        const inputs = document.querySelectorAll('input[type="text"]');
        const last = inputs[inputs.length - 1];
        if (last) { last.focus(); last.select(); }
      });
    },

    async save(c) {
      if (!c.name || !c.name.trim()) c.name = 'Untitled';
      c.defaultMonthly = Number(c.defaultMonthly) || 0;
      if (c.kind !== 'income' && c.kind !== 'expense') c.kind = 'expense';
      await db.categories.update(c.id, {
        name: c.name.trim(),
        kind: c.kind,
        defaultMonthly: c.defaultMonthly,
        color: c.color
      });
    },

    async remove(c) {
      const txCount = await db.transactions.where('categoryId').equals(c.id).count();
      const ruleCount = await db.rules.where('categoryId').equals(c.id).count();
      const msg = `Delete category "${c.name}"?`
        + (txCount ? `\n${txCount} transaction(s) will be un-categorized.` : '')
        + (ruleCount ? `\n${ruleCount} rule(s) will be deleted.` : '');
      if (!confirm(msg)) return;
      await db.transaction('rw', db.categories, db.transactions, db.rules, db.budgets, db.yearlyBudgets, async () => {
        await db.transactions.where('categoryId').equals(c.id).modify({ categoryId: null, ruleId: null });
        await db.rules.where('categoryId').equals(c.id).delete();
        await db.budgets.where('categoryId').equals(c.id).delete();
        await db.yearlyBudgets.where('categoryId').equals(c.id).delete();
        await db.categories.delete(c.id);
      });
      await this.refresh();
    },

    async removeRule(r) {
      if (!confirm(`Delete rule "${r.pattern}"?`)) return;
      await db.rules.delete(r.id);
      await this.refresh();
    },

    ruleCount(catId) {
      return this.rules.filter(r => r.categoryId === catId).length;
    },

    categoryName(id) {
      const c = this.categories.find(x => x.id === id);
      return c ? c.name : '(deleted)';
    }
  };
}

window.categoriesPage = categoriesPage;

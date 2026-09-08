function transactionsPage() {
  return {
    transactions: [],
    categories: [],
    search: '',
    filterCategory: '',
    filterMonth: '',
    selected: new Set(),
    bulkCategoryId: '',
    bulkLearn: true,
    sortBy: 'date',            // 'date' | 'description' | 'amount'
    sortDir: 'desc',           // 'asc' | 'desc'

    async init() {
      await this.refresh();
      window.addEventListener('page-changed', (e) => { if (e.detail === 'transactions') this.refresh(); });
    },

    async refresh() {
      this.transactions = await db.transactions.orderBy('date').reverse().toArray();
      this.categories = await db.categories.orderBy('name').toArray();
    },

    get availableMonths() {
      const months = new Set(this.transactions.map(t => monthKey(t.date)));
      return [...months].sort().reverse();
    },

    get filtered() {
      const s = this.search.trim().toLowerCase();
      const items = this.transactions.filter(t => {
        if (s && !t.description.toLowerCase().includes(s)) return false;
        if (this.filterCategory === '__none__' && t.categoryId) return false;
        if (this.filterCategory && this.filterCategory !== '__none__' && String(t.categoryId) !== this.filterCategory) return false;
        if (this.filterMonth && monthKey(t.date) !== this.filterMonth) return false;
        return true;
      });
      // Sort by the currently-picked column and direction. `date` values are
      // ISO strings so lexicographic compare works, `amount` is numeric, and
      // description is lowercased for case-insensitive alphabetical ordering.
      const dir = this.sortDir === 'asc' ? 1 : -1;
      const key = this.sortBy;
      items.sort((a, b) => {
        const av = key === 'description' ? a.description.toLowerCase()
                 : key === 'amount'      ? a.amount
                 :                          a.date;
        const bv = key === 'description' ? b.description.toLowerCase()
                 : key === 'amount'      ? b.amount
                 :                          b.date;
        if (av < bv) return -dir;
        if (av > bv) return dir;
        return 0;
      });
      return items;
    },

    // Toggle sort direction if clicking the active column, otherwise switch
    // column with a sensible default direction (date & amount: descending —
    // newest / largest first; description: ascending — A→Z).
    toggleSort(col) {
      if (this.sortBy === col) {
        this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        this.sortBy = col;
        this.sortDir = col === 'description' ? 'asc' : 'desc';
      }
    },

    sortArrow(col) {
      if (this.sortBy !== col) return '';
      return this.sortDir === 'asc' ? ' ▲' : ' ▼';
    },

    get allSelected() {
      return this.filtered.length > 0 && this.filtered.every(t => this.selected.has(t.id));
    },

    // Totals over the currently visible (filtered) rows. `net` is the signed
    // sum matching cash-flow. `income` / `expenses` split the positive and
    // negative sides so you can also see the two totals separately.
    get filteredTotals() {
      let net = 0, income = 0, expenses = 0;
      for (const t of this.filtered) {
        net += t.amount;
        if (t.amount >= 0) income += t.amount;
        else expenses += -t.amount;
      }
      return { net, income, expenses };
    },

    toggleAll(checked) {
      if (checked) this.filtered.forEach(t => this.selected.add(t.id));
      else this.filtered.forEach(t => this.selected.delete(t.id));
      this.selected = new Set(this.selected); // trigger reactivity
    },

    toggleOne(id) {
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
      this.selected = new Set(this.selected);
    },

    async assignCategory(t, newCatIdRaw) {
      const newCatId = newCatIdRaw ? Number(newCatIdRaw) : null;
      // Manual assignment clears any auto-rule flag — user is overriding
      await db.transactions.update(t.id, { categoryId: newCatId, ruleId: null });

      if (newCatId) {
        const suggested = suggestPattern(t.description);
        // Only prompt if there's a sensible suggestion and we wouldn't be re-confirming
        // a rule that already exists for the same category.
        if (suggested && suggested.length >= 2) {
          const existing = await db.rules.where('pattern').equals(suggested).first();
          const wouldChange = !existing || existing.categoryId !== newCatId;
          if (wouldChange) {
            window.openRuleModal({
              pattern: suggested,
              categoryId: newCatId,
              description: t.description,
              onConfirm: async (chosenPattern) => {
                const ruleId = await addRule(chosenPattern, newCatId);
                await this.applyRuleToExisting(chosenPattern, newCatId, ruleId);
                await this.refresh();
              }
            });
          }
        }
      }
      await this.refresh();
    },

    async applyBulk() {
      if (!this.bulkCategoryId) return;
      const catId = Number(this.bulkCategoryId);
      const ids = [...this.selected];
      const selectedTx = this.transactions.filter(t => this.selected.has(t.id));

      await db.transaction('rw', db.transactions, async () => {
        for (const id of ids) {
          await db.transactions.update(id, { categoryId: catId, ruleId: null });
        }
      });
      this.selected = new Set();
      this.bulkCategoryId = '';

      if (this.bulkLearn) {
        const suggested = commonKeyword(selectedTx.map(t => t.description));
        if (suggested && suggested.length >= 2) {
          // In the bulk case the tokens come from the first selected transaction as
          // a representative example — usually a good hint when all selected rows
          // share a merchant name.
          window.openRuleModal({
            pattern: suggested,
            categoryId: catId,
            description: selectedTx[0] ? selectedTx[0].description : '',
            onConfirm: async (chosenPattern) => {
              const ruleId = await addRule(chosenPattern, catId);
              await this.applyRuleToExisting(chosenPattern, catId, ruleId);
              await this.refresh();
            }
          });
        }
      }
      await this.refresh();
    },

    // Delegates to the shared helper in rules.js so the Import page uses the
    // same back-apply semantics.
    applyRuleToExisting(pattern, categoryId, ruleId) {
      return applyRuleToExistingTransactions(pattern, categoryId, ruleId);
    },

    categoryName(id) {
      const c = this.categories.find(x => x.id === id);
      return c ? c.name : '';
    }
  };
}

window.transactionsPage = transactionsPage;

function backupPage() {
  return {
    lastExport: '',
    importMsg: '',
    importErr: false,

    async exportData() {
      const [categories, transactions, rules, budgets, yearlyBudgets, settings] = await Promise.all([
        db.categories.toArray(),
        db.transactions.toArray(),
        db.rules.toArray(),
        db.budgets.toArray(),
        db.yearlyBudgets.toArray(),
        db.settings.toArray()
      ]);
      const payload = {
        version: 3,
        exportedAt: new Date().toISOString(),
        categories,
        transactions,
        rules,
        budgets,
        yearlyBudgets,
        settings
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      a.href = url;
      a.download = `budget-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      this.lastExport = new Date().toLocaleString();
    },

    async importData(file) {
      this.importMsg = '';
      this.importErr = false;
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data || !Array.isArray(data.categories) || !Array.isArray(data.transactions) || !Array.isArray(data.rules)) {
          throw new Error('File does not look like a budget backup.');
        }
        const budgets = Array.isArray(data.budgets) ? data.budgets : [];
        const yearlyBudgets = Array.isArray(data.yearlyBudgets) ? data.yearlyBudgets : [];
        const settings = Array.isArray(data.settings) ? data.settings : [];
        if (!confirm(`This will REPLACE all current data with:\n  ${data.categories.length} categories\n  ${data.transactions.length} transactions\n  ${data.rules.length} rules\n  ${budgets.length} month overrides\n  ${yearlyBudgets.length} year defaults\n  ${settings.length} settings\n\nContinue?`)) return;

        await db.transaction('rw', db.categories, db.transactions, db.rules, db.budgets, db.yearlyBudgets, db.settings, async () => {
          await db.categories.clear();
          await db.transactions.clear();
          await db.rules.clear();
          await db.budgets.clear();
          await db.yearlyBudgets.clear();
          await db.settings.clear();
          if (data.categories.length) await db.categories.bulkAdd(data.categories);
          if (data.transactions.length) await db.transactions.bulkAdd(data.transactions);
          if (data.rules.length) await db.rules.bulkAdd(data.rules);
          if (budgets.length) await db.budgets.bulkAdd(budgets);
          if (yearlyBudgets.length) await db.yearlyBudgets.bulkAdd(yearlyBudgets);
          if (settings.length) await db.settings.bulkAdd(settings);
        });
        this.importMsg = `Restored ${data.transactions.length} transactions, ${data.categories.length} categories, ${data.rules.length} rules, ${budgets.length} month overrides, ${yearlyBudgets.length} year defaults, ${settings.length} settings.`;
      } catch (e) {
        this.importErr = true;
        this.importMsg = 'Import failed: ' + e.message;
      }
    },

    async reset() {
      if (!confirm('Delete ALL data? This cannot be undone. Export a backup first if you want to keep anything.')) return;
      if (!confirm('Really delete everything?')) return;
      await db.transaction('rw', db.categories, db.transactions, db.rules, db.budgets, db.yearlyBudgets, db.settings, async () => {
        await db.categories.clear();
        await db.transactions.clear();
        await db.rules.clear();
        await db.budgets.clear();
        await db.yearlyBudgets.clear();
        await db.settings.clear();
      });
      alert('All data deleted.');
    }
  };
}

window.backupPage = backupPage;

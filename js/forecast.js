// Chart.js instance held OUTSIDE Alpine reactive state — see dashboard.js for why.
let forecastChart = null;

function forecastPage() {
  return {
    year: new Date().getFullYear(),
    startingBalance: 0,
    // [{ month, label, income, expenses, net, balance, isPast, isCurrent,
    //    breakdown: [{ id, name, color, kind, amount, isActual }] }]
    months: [],
    expandedMonth: null,  // Which month's per-category breakdown is expanded, or null
    hasAnyCategories: false,

    async init() {
      this.startingBalance = await getSetting(this.balanceKey(), 0);
      await this.refresh();
      window.addEventListener('page-changed', (e) => { if (e.detail === 'forecast') this.refresh(); });
      window.addEventListener('budgets-changed', () => this.refresh());
      // Auto-refresh when transactions, categories, or budgets change on any page
      window.addEventListener('data-changed', () => this.refresh());
    },

    balanceKey() { return `startBalance_${this.year}`; },

    toggleExpand(month) {
      this.expandedMonth = this.expandedMonth === month ? null : month;
    },

    breakdownIncome(m) { return m.breakdown.filter(b => b.kind === 'income'); },
    breakdownExpense(m) { return m.breakdown.filter(b => b.kind === 'expense'); },

    async prevYear() {
      this.year -= 1;
      this.startingBalance = await getSetting(this.balanceKey(), 0);
      await this.refresh();
    },
    async nextYear() {
      this.year += 1;
      this.startingBalance = await getSetting(this.balanceKey(), 0);
      await this.refresh();
    },

    async saveStartingBalance() {
      await setSetting(this.balanceKey(), Number(this.startingBalance) || 0);
      await this.refresh();
    },

    async refresh() {
      const categories = await db.categories.toArray();
      const transactions = await db.transactions.toArray();
      const overrides = await db.budgets.toArray();
      const yearly = await db.yearlyBudgets.toArray();
      this.hasAnyCategories = categories.length > 0;

      // Index overrides by categoryId|month and yearlyBudgets by categoryId|year
      // for O(1) budget lookups.
      const overrideMap = new Map();
      for (const o of overrides) overrideMap.set(`${o.categoryId}|${o.month}`, o.amount);
      const yearlyMap = new Map();
      for (const y of yearly) yearlyMap.set(`${y.categoryId}|${y.year}`, y.amount);
      // Index categories by id so we can look up kind for each transaction's category
      const catMap = new Map(categories.map(c => [c.id, c]));

      const today = new Date();
      const thisYM = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
      const months = [];
      let bal = Number(this.startingBalance) || 0;

      for (const m of yearMonths(this.year)) {
        const isPast = m < thisYM;
        const isCurrent = m === thisYM;
        let income = 0, expenses = 0;
        // Per-category tallies for the expandable breakdown row.
        // Same signed model as the top-level income/expenses computation.
        const breakdownMap = new Map();   // categoryId → { id, name, color, kind, amount, isActual }
        let uncatIncome = 0, uncatExpenses = 0;
        const bumpCat = (cat, delta) => {
          if (!breakdownMap.has(cat.id)) {
            breakdownMap.set(cat.id, {
              id: cat.id, name: cat.name, color: cat.color, kind: cat.kind,
              amount: 0, isActual: isPast
            });
          }
          breakdownMap.get(cat.id).amount += delta;
        };

        if (isPast) {
          // Completed months use real transactions. Category kind picks the
          // column; sign is preserved WITHIN the column so refunds and reversals
          // net correctly against normal transactions on the same category:
          //   - Expense cat + negative amount (spend): expenses += |amount|
          //   - Expense cat + positive amount (refund): expenses -= amount  ← reduces
          //   - Income cat + positive amount (income): income += amount
          //   - Income cat + negative amount (reversal): income -= |amount| ← reduces
          // Trade-off: reclassifying a transaction between an income and an
          // expense category shifts which column it appears in but the NET stays
          // the same, because actual cash flow into your account doesn't change
          // just because you re-labeled the transaction.
          for (const t of transactions) {
            if (monthKey(t.date) !== m) continue;
            const cat = t.categoryId != null ? catMap.get(t.categoryId) : null;
            if (cat && cat.kind === 'income') {
              income += t.amount;
              bumpCat(cat, t.amount);
            } else if (cat && cat.kind === 'expense') {
              expenses += -t.amount;
              bumpCat(cat, -t.amount);
            } else {
              if (t.amount >= 0) { income += t.amount; uncatIncome += t.amount; }
              else { expenses += -t.amount; uncatExpenses += -t.amount; }
            }
          }
        } else {
          // For current and future months, use the budget per category with the
          // three-level lookup: month override → year default → category default.
          const yr = Number(m.slice(0, 4));
          for (const c of categories) {
            const mk = `${c.id}|${m}`;
            const yk = `${c.id}|${yr}`;
            const amt = overrideMap.has(mk) ? overrideMap.get(mk)
                     : yearlyMap.has(yk)    ? yearlyMap.get(yk)
                     :                        (c.defaultMonthly || 0);
            if (c.kind === 'income') income += amt;
            else expenses += amt;
            if (amt !== 0) bumpCat(c, amt);
          }
        }

        const net = income - expenses;
        bal += net;

        // Flatten breakdown map, add uncategorized rows if present, then sort by
        // amount desc within each kind (biggest contributors first).
        const breakdown = [...breakdownMap.values()];
        if (uncatIncome !== 0) breakdown.push({ id: null, name: '(Uncategorized)', color: '#9ca3af', kind: 'income', amount: uncatIncome, isActual: true });
        if (uncatExpenses !== 0) breakdown.push({ id: null, name: '(Uncategorized)', color: '#9ca3af', kind: 'expense', amount: uncatExpenses, isActual: true });
        breakdown.sort((a, b) => (a.kind === b.kind) ? b.amount - a.amount : (a.kind === 'income' ? -1 : 1));

        months.push({
          month: m,
          label: monthLabel(m),
          income, expenses, net,
          balance: bal,
          isPast, isCurrent,
          breakdown
        });
      }

      this.months = months;
      this.$nextTick(() => this.renderChart());
    },

    get endBalance() {
      return this.months.length ? this.months[this.months.length - 1].balance : Number(this.startingBalance) || 0;
    },

    get lowestBalance() {
      if (!this.months.length) return { value: Number(this.startingBalance) || 0, label: '—' };
      let lowest = this.months[0];
      for (const m of this.months) if (m.balance < lowest.balance) lowest = m;
      return { value: lowest.balance, label: lowest.label };
    },

    renderChart() {
      const canvas = document.getElementById('forecastChart');
      if (!canvas) return;
      if (!this.months.length) return;

      // Draw the starting balance as month 0 so the line begins at the user's entry
      const labels = ['Start', ...this.months.map(m => m.label.split(' ')[0])];
      const balances = [Number(this.startingBalance) || 0, ...this.months.map(m => m.balance)];
      const pointColors = balances.map(b => b < 0 ? '#dc2626' : '#3b82f6');

      // Update in place — destroying + recreating on the same canvas leaves it blank.
      if (forecastChart) {
        forecastChart.data.labels = labels;
        forecastChart.data.datasets[0].data = balances;
        forecastChart.data.datasets[0].pointBackgroundColor = pointColors;
        forecastChart.update();
        return;
      }

      forecastChart = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'Projected balance',
              data: balances,
              borderColor: '#3b82f6',
              backgroundColor: 'rgba(59,130,246,0.1)',
              fill: true,
              tension: 0.25,
              pointRadius: 4,
              pointBackgroundColor: pointColors
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'top' },
            tooltip: { callbacks: { label: ctx => `Balance: ${fmt(ctx.parsed.y)}` } }
          },
          scales: {
            y: { ticks: { callback: v => fmt(v) } }
          }
        }
      });
    }
  };
}

window.forecastPage = forecastPage;

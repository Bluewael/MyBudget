// Chart.js instance held OUTSIDE Alpine's reactive state — Alpine wraps every
// property of x-data in a Proxy, which breaks Chart.js's internal `this.scales`
// reads/writes and produces stale/undefined scales when data changes.
let dashboardChart = null;

function dashboardPage() {
  return {
    view: 'month',      // 'month' | 'ytd' | 'year'
    month: currentMonth(),
    categories: [],
    transactions: [],
    budgets: [],        // All month-level budget overrides
    yearlyBudgets: [],  // All year-level defaults

    async init() {
      await this.refresh();
      window.addEventListener('page-changed', (e) => { if (e.detail === 'dashboard') this.refresh(); });
      window.addEventListener('budgets-changed', () => this.refresh());
      window.addEventListener('data-changed', () => this.refresh());
      this.$watch('month', () => this.refresh());
      this.$watch('view', () => this.refresh());
    },

    async refresh() {
      this.categories = await db.categories.orderBy('name').toArray();
      this.transactions = await db.transactions.toArray();
      // The full budget overrides table — cheap to load and lets us switch views
      // (month vs YTD vs year) without extra queries.
      this.budgets = await db.budgets.toArray();
      this.yearlyBudgets = await db.yearlyBudgets.toArray();
      this.$nextTick(() => this.renderChart());
    },

    // --- Period navigation ---
    get year() { return Number(this.month.slice(0, 4)); },
    get monthLabel() { return monthLabel(this.month); },

    get rangeLabel() {
      if (this.view === 'month') return this.monthLabel;
      const shortMon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      if (this.view === 'ytd') {
        const mm = Number(this.month.slice(5, 7));
        return `Jan–${shortMon[mm - 1]} ${this.year}`;
      }
      return `${this.year} (full year)`;
    },

    // Prev/next shift by one month in month/YTD mode and by one year in year mode.
    shiftPeriod(delta) {
      if (this.view === 'year') {
        this.month = `${this.year + delta}-${this.month.slice(5)}`;
      } else {
        this.month = shiftMonth(this.month, delta);
      }
    },

    rangeMonths() {
      const yr = this.month.slice(0, 4);
      const mm = Number(this.month.slice(5, 7));
      if (this.view === 'month') return [this.month];
      if (this.view === 'ytd') {
        return Array.from({ length: mm }, (_, i) => `${yr}-${String(i + 1).padStart(2, '0')}`);
      }
      return Array.from({ length: 12 }, (_, i) => `${yr}-${String(i + 1).padStart(2, '0')}`);
    },

    // --- Labels adapt to the current view ---
    get budgetLabel()   { return this.view === 'year' ? 'Year budget' : this.view === 'ytd' ? 'Budgeted YTD' : 'Budgeted'; },
    get activityLabel() { return this.view === 'year' ? 'Projected'    : this.view === 'ytd' ? 'Spent YTD'    : 'Spent'; },
    get remainingLabel(){ return this.view === 'year' ? 'Under budget' : 'Remaining'; },

    // Per-category budget for a given month. Three-level lookup, in order:
    //   1. per-month override (budgets table)
    //   2. per-year default   (yearlyBudgets table)
    //   3. category-wide fallback (category.defaultMonthly)
    budgetForMonth(catId, month) {
      const monthOverride = this.budgets.find(b => b.categoryId === catId && b.month === month);
      if (monthOverride) return monthOverride.amount;
      const year = Number(month.slice(0, 4));
      const yearDefault = this.yearlyBudgets.find(y => y.categoryId === catId && y.year === year);
      if (yearDefault) return yearDefault.amount;
      const cat = this.categories.find(c => c.id === catId);
      return cat ? (cat.defaultMonthly || 0) : 0;
    },

    // Core aggregation. Walks the transactions and budgets once and produces both
    // per-category rows and the topline totals. Called from `rows` and `totals`.
    _summary() {
      const months = this.rangeMonths();
      const inRange = new Set(months);
      const isYear = this.view === 'year';
      const today = new Date();
      const thisYM = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

      // Precompute actual expense per (categoryId, month) using the signed model
      // (a positive amount on an expense category = refund, reduces spent). Also
      // collect uncategorized outflows separately.
      const spentMap = new Map();  // key `${catId}|${month}` → number
      let uncatAmount = 0, uncatCount = 0;
      for (const t of this.transactions) {
        const m = monthKey(t.date);
        if (!inRange.has(m)) continue;
        if (t.categoryId != null) {
          const key = `${t.categoryId}|${m}`;
          spentMap.set(key, (spentMap.get(key) || 0) + (-t.amount));
        } else if (t.amount < 0) {
          uncatAmount += -t.amount;
          uncatCount++;
        }
      }

      const rows = [];
      let totalBudget = 0, totalSpent = 0, totalProjected = 0;

      for (const c of this.categories) {
        if (c.kind === 'income') continue;   // Dashboard tracks expenses only
        let budget = 0, spent = 0, projected = 0;
        for (const m of months) {
          const b = this.budgetForMonth(c.id, m);
          const s = spentMap.get(`${c.id}|${m}`) || 0;
          budget += b;
          spent += s;
          // Year mode's "projected" mixes past actuals with future budgets.
          if (isYear) projected += (m < thisYM) ? s : b;
        }
        const value = isYear ? projected : spent;
        totalBudget += budget;
        totalSpent += spent;
        totalProjected += projected;
        if (budget > 0 || value !== 0) {
          rows.push({
            id: c.id, name: c.name, color: c.color,
            budget, spent, projected, value,
            remaining: budget - value
          });
        }
      }

      const totalValue = isYear ? totalProjected : totalSpent;
      return {
        rows,
        totals: {
          budget: totalBudget,
          spent: totalSpent,
          projected: totalProjected,
          value: totalValue,
          remaining: totalBudget - totalValue,
          uncategorized: uncatAmount,
          uncategorizedCount: uncatCount
        }
      };
    },

    get rows()   { return this._summary().rows; },
    get totals() { return this._summary().totals; },

    renderChart() {
      const canvas = document.getElementById('budgetChart');
      if (!canvas) return;
      const rows = this.rows;
      const labels = rows.map(r => r.name);
      const activityData = rows.map(r => r.value);
      const budgetData = rows.map(r => r.budget);
      const activityLabel = this.activityLabel;
      const budgetLabel = this.budgetLabel;

      // Update the existing chart in place — destroying+recreating on the same
      // canvas produces a blank chart (Chart.js resize/DPR race).
      if (dashboardChart) {
        dashboardChart.data.labels = labels;
        dashboardChart.data.datasets[0].label = activityLabel;
        dashboardChart.data.datasets[0].data = activityData;
        dashboardChart.data.datasets[1].label = budgetLabel;
        dashboardChart.data.datasets[1].data = budgetData;
        dashboardChart.update();
        return;
      }

      if (!rows.length) return;

      dashboardChart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: activityLabel, data: activityData, backgroundColor: '#3b82f6', borderRadius: 4 },
            { label: budgetLabel,   data: budgetData,   backgroundColor: '#e5e7eb', borderRadius: 4 }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'top' },
            tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${fmt(ctx.parsed.y)}` } }
          },
          scales: {
            y: { beginAtZero: true, ticks: { callback: v => fmt(v) } }
          }
        }
      });
    }
  };
}

window.dashboardPage = dashboardPage;

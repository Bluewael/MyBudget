// Category-over-time trends. Pick a category, a year, and a granularity
// (monthly / weekly) — see the summed amounts per period as a bar chart plus
// year total / average / peak stats. Uses the same signed model as the rest
// of the app (refunds correctly reduce an expense-category total).

// Chart.js instance kept outside Alpine — Alpine's Proxy wrapping breaks
// Chart.js's internal `this.scales` reads/writes.
let trendsChart = null;

function trendsPage() {
  return {
    year: new Date().getFullYear(),
    granularity: 'month',   // 'month' | 'week'
    categoryId: null,
    categories: [],
    transactions: [],
    budgets: [],            // per-month overrides
    yearlyBudgets: [],      // per-(category, year) defaults

    async init() {
      await this.refresh();
      window.addEventListener('page-changed', (e) => { if (e.detail === 'trends') this.refresh(); });
      window.addEventListener('data-changed', () => this.refresh());
      this.$watch('year', () => this.$nextTick(() => this.renderChart()));
      this.$watch('granularity', () => this.$nextTick(() => this.renderChart()));
      this.$watch('categoryId', () => this.$nextTick(() => this.renderChart()));
    },

    async refresh() {
      this.categories = await db.categories.orderBy('name').toArray();
      this.transactions = await db.transactions.toArray();
      this.budgets = await db.budgets.toArray();
      this.yearlyBudgets = await db.yearlyBudgets.toArray();
      // First-time or previously-selected category deleted → pick the first one
      if (!this.categoryId || !this.categories.some(c => c.id === this.categoryId)) {
        this.categoryId = this.categories.length ? this.categories[0].id : null;
      }
      this.$nextTick(() => this.renderChart());
    },

    get category() {
      return this.categories.find(c => c.id === Number(this.categoryId));
    },

    // Three-level budget lookup for (category, YYYY-MM):
    //   month override → year default → category fallback.
    // Same rule the Dashboard and Forecast pages use, so all three views agree.
    budgetForMonth(catId, monthKey) {
      const mo = this.budgets.find(b => b.categoryId === catId && b.month === monthKey);
      if (mo) return mo.amount;
      const yr = Number(monthKey.slice(0, 4));
      const yd = this.yearlyBudgets.find(y => y.categoryId === catId && y.year === yr);
      if (yd) return yd.amount;
      const cat = this.categories.find(c => c.id === catId);
      return cat ? (cat.defaultMonthly || 0) : 0;
    },

    // Per-period buckets for the selected year. Each bucket has start/end (ISO
    // date strings), a display label, and the summed value across matching
    // transactions on the selected category.
    get buckets() {
      const cat = this.category;
      if (!cat) return [];
      const isIncome = cat.kind === 'income';
      const isMonthly = this.granularity === 'month';
      const periods = isMonthly ? monthPeriods(this.year) : weekPeriods(this.year);
      const txs = this.transactions.filter(t => t.categoryId === cat.id);
      return periods.map((p, idx) => {
        const inPeriod = txs.filter(t => t.date >= p.start && t.date <= p.end);
        // Signed model: income cats sum raw amount; expense cats use -amount
        // so spending shows positive and refunds subtract from the total.
        const sum = inPeriod.reduce((s, t) => s + (isIncome ? t.amount : -t.amount), 0);
        // Budget only makes sense for monthly buckets — budgets are set per
        // month (or per year default), never per week. Weekly buckets get null.
        const budget = isMonthly
          ? this.budgetForMonth(cat.id, `${this.year}-${String(idx + 1).padStart(2, '0')}`)
          : null;
        return { ...p, value: sum, count: inPeriod.length, budget };
      });
    },

    get totalYearBudget() {
      return this.buckets.reduce((s, b) => s + (b.budget || 0), 0);
    },

    get totalYear() {
      return this.buckets.reduce((s, b) => s + b.value, 0);
    },

    // Non-empty periods only, so a category active only in a few months gets
    // an average that reflects "when this category is used" rather than
    // being diluted by long stretches of zero.
    get averagePerActivePeriod() {
      const active = this.buckets.filter(b => b.count > 0);
      return active.length ? active.reduce((s, b) => s + b.value, 0) / active.length : 0;
    },

    get peak() {
      let best = { value: 0, label: '—' };
      for (const b of this.buckets) {
        if (Math.abs(b.value) > Math.abs(best.value)) best = { value: b.value, label: b.label };
      }
      return best;
    },

    get totalCount() {
      return this.buckets.reduce((s, b) => s + b.count, 0);
    },

    renderChart() {
      const canvas = document.getElementById('trendsChart');
      if (!canvas) return;
      const buckets = this.buckets;
      const labels = buckets.map(b => b.label);
      const spentData = buckets.map(b => b.value);
      const color = this.category?.color || '#3b82f6';
      const catName = this.category?.name || '';
      const isMonthly = this.granularity === 'month';
      const budgetData = isMonthly ? buckets.map(b => b.budget || 0) : null;

      // Build the datasets list — 2 series in monthly mode (spend + budget),
      // 1 in weekly mode (spend only, since budgets aren't weekly).
      const nextDatasets = [
        { label: catName || 'Actual', data: spentData, backgroundColor: color, borderRadius: 4 }
      ];
      if (isMonthly) {
        nextDatasets.push({ label: 'Budget', data: budgetData, backgroundColor: '#e5e7eb', borderRadius: 4 });
      }

      if (trendsChart) {
        trendsChart.data.labels = labels;
        // Splice to swap datasets in place — assigning a new array reference
        // can leave Chart.js's parsed cache stale (same lesson we hit before).
        trendsChart.data.datasets.splice(0, trendsChart.data.datasets.length, ...nextDatasets);
        // Show the legend only when there's more than one series to distinguish.
        trendsChart.options.plugins.legend.display = isMonthly;
        trendsChart.update();
        return;
      }
      if (!buckets.length) return;
      trendsChart = new Chart(canvas, {
        type: 'bar',
        data: { labels, datasets: nextDatasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: isMonthly, position: 'top' },
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

// ─────────────────────────────────────────────────────────────────────────────
// Period helpers — pure functions, no DB access

function monthPeriods(year) {
  const out = [];
  const shortMon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const lastDay = new Date(year, m, 0).getDate(); // month=m is 1-indexed here (Jan=1)
    out.push({
      start: `${year}-${mm}-01`,
      end:   `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
      label: shortMon[m - 1]
    });
  }
  return out;
}

// ISO-8601 weeks: Monday–Sunday, week 1 contains Jan 4. Buckets whose Monday
// falls before the selected year still show up if they contain any day of the
// selected year — matches how a diary looks in early January.
function weekPeriods(year) {
  const out = [];
  // Start on the Monday of the week containing Jan 1
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const dow = jan1.getUTCDay() || 7;  // 1=Mon..7=Sun
  const startMonday = new Date(jan1);
  startMonday.setUTCDate(jan1.getUTCDate() - dow + 1);

  let d = new Date(startMonday);
  // Emit weeks until we cross into next year with no overlap
  for (let safety = 0; safety < 60; safety++) {
    const weekEnd = new Date(d);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    // Skip if entirely before or after the selected year
    if (weekEnd.getUTCFullYear() < year) { d.setUTCDate(d.getUTCDate() + 7); continue; }
    if (d.getUTCFullYear() > year) break;
    out.push({
      start: d.toISOString().slice(0, 10),
      end:   weekEnd.toISOString().slice(0, 10),
      label: `W${String(isoWeekNumber(d)).padStart(2, '0')}`
    });
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

// ISO-8601 week number of the given date (its Thursday determines the year).
function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);      // move to that week's Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

window.trendsPage = trendsPage;

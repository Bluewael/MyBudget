// Root Alpine component — holds the current page tab.
// The hash in the URL drives `page` so links and refreshes work as expected.

function appState() {
  return {
    page: location.hash.replace('#', '') || 'dashboard',

    // Rule-creation modal shared across pages.
    ruleModal: {
      open: false,
      pattern: '',
      categoryId: null,
      categoryName: '',
      description: '',
      tokens: [],
      matchCount: 0,
      error: '',
      // Populated when the entered pattern collides with an existing rule that
      // points to a DIFFERENT category, giving the user an explicit
      // "update-to-new-category" action instead of forcing them to leave the
      // modal to delete the old rule first.
      duplicateExisting: null,   // { id, categoryId, categoryName } | null
      onConfirm: null
    },

    // Per-month budget editor modal.
    budgetModal: {
      open: false,
      categoryId: null,
      categoryName: '',
      categoryKind: 'expense',
      defaultAmount: 0,
      year: new Date().getFullYear(),
      months: [] // [{ month, label, amount, isOverride }]
    },

    init() {
      window.addEventListener('hashchange', () => {
        this.page = location.hash.replace('#', '') || 'dashboard';
      });
      this.$watch('page', (p) => {
        if (location.hash.replace('#', '') !== p) location.hash = p;
        window.dispatchEvent(new CustomEvent('page-changed', { detail: p }));
      });
      this.$watch('ruleModal.pattern', () => this.updateRuleMatchCount());

      // Expose globally so any page component can request a rule prompt.
      window.openRuleModal = (params) => this.openRuleModal(params);
      window.openBudgetModal = (params) => this.openBudgetModal(params);
    },

    async openBudgetModal({ categoryId, year }) {
      const cat = await db.categories.get(categoryId);
      if (!cat) return;
      this.budgetModal.categoryId = categoryId;
      this.budgetModal.categoryName = cat.name;
      this.budgetModal.categoryKind = cat.kind || 'expense';
      this.budgetModal.year = year || new Date().getFullYear();
      // defaultAmount is refreshed each time loadBudgetMonths runs since it
      // depends on the year-specific default.
      await this.loadBudgetMonths();
      this.budgetModal.open = true;
    },

    async loadBudgetMonths() {
      const { categoryId, year } = this.budgetModal;
      // Baseline for this year: the yearly default if set, else the category
      // fallback. Month cells that equal this baseline are considered "not
      // overridden" and are not written to db.budgets on save.
      const baseline = await yearlyDefaultOrFallback(categoryId, year);
      this.budgetModal.defaultAmount = baseline.amount;
      this.budgetModal.defaultSource = baseline.source;      // 'year' or 'category'
      const overrides = await db.budgets.where('categoryId').equals(categoryId).toArray();
      const overrideMap = new Map(overrides.map(o => [o.month, o.amount]));
      this.budgetModal.months = yearMonths(year).map(m => {
        const has = overrideMap.has(m);
        return {
          month: m,
          label: new Date(Number(m.slice(0,4)), Number(m.slice(5,7)) - 1, 1).toLocaleDateString('en-GB', { month: 'short' }),
          amount: has ? overrideMap.get(m) : baseline.amount,
          isOverride: has
        };
      });
    },

    async saveBudgetMonth(m) {
      const { categoryId, defaultAmount } = this.budgetModal;
      const amt = Number(m.amount) || 0;
      m.amount = amt;
      await setMonthBudget(categoryId, m.month, amt);
      m.isOverride = Math.abs(amt - defaultAmount) >= 0.005;
    },

    async budgetPrevYear() { this.budgetModal.year -= 1; await this.loadBudgetMonths(); },
    async budgetNextYear() { this.budgetModal.year += 1; await this.loadBudgetMonths(); },

    closeBudgetModal() {
      this.budgetModal.open = false;
      // Notify any page that cares (Categories page shows override count)
      window.dispatchEvent(new CustomEvent('budgets-changed'));
    },

    async openRuleModal({ pattern, categoryId, description, onConfirm }) {
      const cat = await db.categories.get(categoryId);
      this.ruleModal = {
        open: true,
        pattern: pattern || '',
        categoryId,
        categoryName: cat ? cat.name : '',
        description: description || '',
        tokens: this.tokenizeDescription(description || ''),
        matchCount: 0,
        error: '',
        duplicateExisting: null,
        onConfirm
      };
      await this.updateRuleMatchCount();
      // Focus the input on next tick
      this.$nextTick(() => {
        const el = document.getElementById('rule-pattern-input');
        if (el) { el.focus(); el.select(); }
      });
    },

    // Break the description into unique clickable word chips. Each chip carries
    // both the DISPLAY string (original case, punctuation stripped from ends),
    // the VALUE that becomes the pattern (lowercased, no punctuation), AND the
    // START/END offset in the original description so we can extract the exact
    // text between chips when the user selects multiple adjacent ones (e.g.
    // "Jem" + "Fix" from "Jem & Fix" should produce "jem & fix", not "jem fix").
    // Skips words shorter than 2 chars so tokens like "a" and "b" don't crowd
    // the UI. Duplicates are de-duped by lowercased value (first occurrence wins).
    tokenizeDescription(desc) {
      if (!desc) return [];
      const out = [];
      const seen = new Set();
      const re = /\S+/g;
      let match;
      while ((match = re.exec(desc)) !== null) {
        const raw = match[0];
        const startTrim = raw.match(/^[^\p{L}\p{N}]*/u)[0].length;
        const endTrim = raw.match(/[^\p{L}\p{N}]*$/u)[0].length;
        const clean = raw.slice(startTrim, raw.length - endTrim);
        if (clean.length < 2) continue;
        const key = clean.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          display: clean,
          value: key,
          start: match.index + startTrim,
          end: match.index + raw.length - endTrim
        });
      }
      return out;
    },

    // Toggle a token in the pattern. When the resulting selection is a set of
    // ADJACENT tokens in the description, pull the exact substring between them
    // (so "Jem" + "Fix" out of "Jem & Fix" becomes "jem & fix" — separators like
    // & or / are preserved). For non-adjacent selections we fall back to a plain
    // space-joined pattern in original description order.
    selectToken(tok) {
      // Rebuild the current selection set from the pattern (split on non-word
      // chars so "jem & fix" gives {jem, fix} and matches our token values).
      const inSelection = new Set(
        (this.ruleModal.pattern || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
      );
      if (inSelection.has(tok.value)) inSelection.delete(tok.value);
      else inSelection.add(tok.value);

      const selected = this.ruleModal.tokens
        .filter(t => inSelection.has(t.value))
        .sort((a, b) => a.start - b.start);
      this.ruleModal.pattern = this._patternFromSelection(selected);
      this.ruleModal.error = '';
      this.ruleModal.duplicateExisting = null;
    },

    _patternFromSelection(selected) {
      if (selected.length === 0) return '';
      if (selected.length === 1) return selected[0].value;
      // If every token between the first and last selected is ALSO selected,
      // use the actual substring from the description — this preserves
      // separator characters like & / - that the tokenizer strips.
      const allSorted = [...this.ruleModal.tokens].sort((a, b) => a.start - b.start);
      const firstIdx = allSorted.indexOf(selected[0]);
      const lastIdx = allSorted.indexOf(selected[selected.length - 1]);
      const between = allSorted.slice(firstIdx, lastIdx + 1);
      const selectedValues = new Set(selected.map(t => t.value));
      const contiguous = between.every(t => selectedValues.has(t.value));
      if (contiguous && this.ruleModal.description) {
        return this.ruleModal.description
          .slice(selected[0].start, selected[selected.length - 1].end)
          .toLowerCase();
      }
      return selected.map(t => t.value).join(' ');
    },

    async updateRuleMatchCount() {
      if (!this.ruleModal.open) return;
      const p = (this.ruleModal.pattern || '').toLowerCase().trim();
      // Any typing clears the previous error so the user can retry
      this.ruleModal.error = '';
      this.ruleModal.duplicateExisting = null;
      if (!p) { this.ruleModal.matchCount = 0; return; }
      const all = await db.transactions.toArray();
      this.ruleModal.matchCount = all.filter(t => t.description.toLowerCase().includes(p)).length;
    },

    async confirmRule() {
      const { pattern, categoryId, onConfirm } = this.ruleModal;
      const trimmed = (pattern || '').trim().toLowerCase();
      if (!trimmed) return;

      const existing = await db.rules.where('pattern').equals(trimmed).first();
      // If the existing rule already points to the SAME category we're offering
      // to route to, proceed silently — nothing surprising is happening.
      if (existing && existing.categoryId !== categoryId) {
        // Different category → surface both options: change the pattern OR update
        // the existing rule to point to the new category.
        const existingCat = await db.categories.get(existing.categoryId);
        const existingCatName = existingCat ? existingCat.name : `category #${existing.categoryId}`;
        this.ruleModal.duplicateExisting = {
          id: existing.id,
          categoryId: existing.categoryId,
          categoryName: existingCatName
        };
        this.ruleModal.error =
          `A rule for "${trimmed}" already exists and currently sends transactions to ${existingCatName}. ` +
          `Either pick a different word above, or update the existing rule to send them to ${this.ruleModal.categoryName} instead.`;
        return;
      }

      this.ruleModal.open = false;
      if (onConfirm) await onConfirm(trimmed);
    },

    // Called from the "Update existing rule" button in the duplicate-warning
    // banner. Skips the uniqueness check and runs the same onConfirm as a
    // normal confirmation — addRule() already updates an existing rule's
    // categoryId when the pattern matches, and applyRuleToExistingTransactions
    // re-categorizes transactions that were auto-assigned by the old target.
    async updateExistingRule() {
      const { pattern, onConfirm } = this.ruleModal;
      const trimmed = (pattern || '').trim().toLowerCase();
      if (!trimmed) return;
      this.ruleModal.open = false;
      if (onConfirm) await onConfirm(trimmed);
    },

    closeRuleModal() {
      this.ruleModal.open = false;
    }
  };
}

window.appState = appState;

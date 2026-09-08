function importPage() {
  return {
    dragOver: false,
    preview: [],   // { date, description, amount, currency, hash, duplicate, suggestedCategoryId, ruleId }
    categories: [],
    parseError: '',

    async init() {
      this.categories = await db.categories.orderBy('name').toArray();
      window.addEventListener('page-changed', async (e) => {
        if (e.detail === 'import') this.categories = await db.categories.orderBy('name').toArray();
      });
    },

    get newCount() { return this.preview.filter(p => !p.duplicate).length; },
    get dupeCount() { return this.preview.filter(p => p.duplicate).length; },
    get autoCatCount() { return this.preview.filter(p => !p.duplicate && p.suggestedCategoryId).length; },

    handleDrop(ev) {
      this.dragOver = false;
      const file = ev.dataTransfer.files[0];
      if (file) this.handleFile(file);
    },

    async handleFile(file) {
      this.parseError = '';
      this.preview = [];
      if (!file) return;
      // Many Danish banks export as Windows-1252; try UTF-8 first, fall back if mojibake detected
      let text = await file.text();
      if (/Ã.|Ã¦|Ã¸|Ã¥/.test(text)) {
        try {
          const buf = await file.arrayBuffer();
          text = new TextDecoder('windows-1252').decode(buf);
        } catch {} // keep UTF-8 result on failure
      }

      const { rows, errors } = parseDanishCsv(text);
      if (errors.length && !rows.length) {
        this.parseError = 'Could not parse file:\n' + errors.slice(0, 5).join('\n');
        return;
      }

      // Build dedupe set from existing transactions. Match on the canonical
      // hash: date + amount + normalized description (see txHash in utils.js).
      const existing = new Set((await db.transactions.toArray()).map(t => t.hash));
      // Also track hashes we've seen in this CSV so a row that appears twice
      // inside the same file is caught — only the first occurrence is imported.
      const seenInBatch = new Set();
      const rules = await db.rules.toArray();
      const cats = await db.categories.toArray();
      this.categories = cats;

      this.preview = [];
      for (const r of rows) {
        const hash = txHash(r.date, r.amount, r.description);
        const dup = existing.has(hash) || seenInBatch.has(hash);
        seenInBatch.add(hash);
        let suggestedCategoryId = null;
        let ruleId = null;
        if (!dup) {
          const sug = await suggestCategory(r.description, rules);
          suggestedCategoryId = sug.categoryId;
          ruleId = sug.ruleId;
        }
        this.preview.push({
          date: r.date,
          description: r.description,
          amount: r.amount,
          currency: r.currency,
          hash,
          duplicate: dup,
          suggestedCategoryId,
          ruleId
        });
      }

      if (errors.length) {
        this.parseError = `${errors.length} row(s) skipped:\n` + errors.slice(0, 5).join('\n');
      }
    },

    // Called from the preview's category dropdown. Records the manual pick and,
    // if the user picked a real category, offers to create a matching rule —
    // same flow as the Transactions page. If they confirm, the rule is applied
    // both to any other rows still sitting in this preview AND to transactions
    // already in the database, so the picture stays consistent.
    async assignImportCategory(p, newCatIdRaw) {
      const newCatId = newCatIdRaw ? Number(newCatIdRaw) : null;
      // x-model already updated p.suggestedCategoryId, but be explicit — and
      // clear ruleId since this is an explicit user choice, not a rule match.
      p.suggestedCategoryId = newCatId;
      p.ruleId = null;

      if (!newCatId) return;

      const suggested = suggestPattern(p.description);
      if (!suggested || suggested.length < 2) return;
      const existing = await db.rules.where('pattern').equals(suggested).first();
      const wouldChange = !existing || existing.categoryId !== newCatId;
      if (!wouldChange) return;

      window.openRuleModal({
        pattern: suggested,
        categoryId: newCatId,
        description: p.description,
        onConfirm: async (chosenPattern) => {
          const ruleId = await addRule(chosenPattern, newCatId);
          // Update already-stored transactions
          await applyRuleToExistingTransactions(chosenPattern, newCatId, ruleId);
          // And update other rows in the current import preview
          this.applyRuleToPreview(chosenPattern, newCatId, ruleId);
        }
      });
    },

    // Apply a freshly-created rule to still-in-preview rows: any row whose
    // description contains the pattern gets the new category, unless the user
    // already made a MANUAL pick on it (categoryId set, ruleId null). Duplicate
    // rows are also left alone since they won't be inserted anyway.
    applyRuleToPreview(pattern, categoryId, ruleId) {
      const needle = pattern.toLowerCase();
      for (const p of this.preview) {
        if (p.duplicate) continue;
        if (p.suggestedCategoryId && !p.ruleId) continue;
        if (!p.description.toLowerCase().includes(needle)) continue;
        p.suggestedCategoryId = categoryId;
        p.ruleId = ruleId;
      }
    },

    async commit() {
      // Re-check dedupe at write time in case the DB changed between preview
      // and commit (or two identical hashes slip through). Belt-and-braces —
      // preview should already filter these but a second guard is cheap.
      const existing = new Set((await db.transactions.toArray()).map(t => t.hash));
      const toInsert = [];
      let skippedAtCommit = 0;
      for (const p of this.preview) {
        if (p.duplicate) continue;
        if (existing.has(p.hash)) { skippedAtCommit++; continue; }
        existing.add(p.hash);
        toInsert.push({
          date: p.date,
          description: p.description,
          amount: p.amount,
          currency: p.currency,
          hash: p.hash,
          categoryId: p.suggestedCategoryId ? Number(p.suggestedCategoryId) : null,
          ruleId: p.suggestedCategoryId ? p.ruleId : null,
          importedAt: Date.now()
        });
      }
      if (!toInsert.length) {
        alert('Nothing to import — every row is a duplicate of an existing transaction.');
        this.preview = [];
        return;
      }
      await db.transactions.bulkAdd(toInsert);
      const extra = skippedAtCommit ? ` Skipped ${skippedAtCommit} extra duplicate(s) detected at import.` : '';
      alert(`Imported ${toInsert.length} transaction(s).${extra}`);
      this.preview = [];
    }
  };
}

window.importPage = importPage;

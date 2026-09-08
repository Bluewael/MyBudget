// Auto-categorization engine.
// Rules are simple: lowercased substring of the description → categoryId.
// On import, we run every rule against every new transaction; first match wins
// (longer/more specific patterns are tried first so "REMA1000" beats "REMA").

async function suggestCategory(description, rulesCache) {
  const rules = rulesCache || await db.rules.toArray();
  const desc = description.toLowerCase();
  // Longest pattern first → more specific matches win
  const sorted = [...rules].sort((a, b) => b.pattern.length - a.pattern.length);
  for (const r of sorted) {
    if (desc.includes(r.pattern)) {
      return { categoryId: r.categoryId, ruleId: r.id };
    }
  }
  return { categoryId: null, ruleId: null };
}

// Danish bank statements almost always start with the merchant name
// (e.g. "MENY HOERSHOLM", "REMA1000 HOERSHOLM", "Rejsekort app Nota 9bSrXbYz9LZ").
// So the merchant is "the first meaningful token" — the cheap and correct heuristic.
function tokenize(description) {
  return description.toLowerCase()
    .replace(/[,;.()]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !NOISE_WORDS.has(t));
}

const NOISE_WORDS = new Set(['app', 'nota', 'den', 'det', 'til', 'fra', 'med', 'dkk', 'eur', 'usd']);

function suggestPattern(description) {
  const tokens = tokenize(description);
  if (!tokens.length) return '';
  // First token is the merchant name in Danish bank statements
  return tokens[0];
}

// For bulk-assignment: only return a keyword if all transactions clearly share
// the same merchant (their first tokens match). Otherwise return empty — better to
// create no rule than a wrong one (e.g. matching a shared city name across unrelated stores).
function commonKeyword(descriptions) {
  if (!descriptions.length) return '';
  if (descriptions.length === 1) return suggestPattern(descriptions[0]);
  const firstTokens = descriptions.map(d => tokenize(d)[0]).filter(Boolean);
  if (firstTokens.length !== descriptions.length) return '';
  return firstTokens.every(t => t === firstTokens[0]) ? firstTokens[0] : '';
}

async function addRule(pattern, categoryId) {
  pattern = pattern.toLowerCase().trim();
  if (!pattern) return null;
  // Don't duplicate
  const existing = await db.rules.where('pattern').equals(pattern).first();
  if (existing) {
    if (existing.categoryId !== categoryId) {
      await db.rules.update(existing.id, { categoryId });
    }
    return existing.id;
  }
  return await db.rules.add({ pattern, categoryId, createdAt: Date.now() });
}

// Back-apply a rule to already-stored transactions. Assigns the given category
// to any transaction whose description contains the pattern, but only touches
// transactions that are uncategorized or were previously auto-categorized —
// manual assignments (categoryId set, ruleId null) are left alone.
async function applyRuleToExistingTransactions(pattern, categoryId, ruleId) {
  const needle = pattern.toLowerCase();
  await db.transaction('rw', db.transactions, async () => {
    const all = await db.transactions.toArray();
    for (const tx of all) {
      if (tx.categoryId && !tx.ruleId) continue;
      if (tx.description.toLowerCase().includes(needle)) {
        await db.transactions.update(tx.id, { categoryId, ruleId });
      }
    }
  });
}

window.suggestCategory = suggestCategory;
window.suggestPattern = suggestPattern;
window.commonKeyword = commonKeyword;
window.addRule = addRule;
window.applyRuleToExistingTransactions = applyRuleToExistingTransactions;

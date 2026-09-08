// Danish bank CSV parser.
// Format: DD-MM-YYYY;"Description";-123,45;DKK
// - Semicolon delimiter
// - Description optionally quoted (quotes are literal " characters)
// - Decimal comma
// - Negative amount = expense

function parseDanishCsv(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows = [];
  const errors = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts = splitCsvLine(line);
    if (parts.length < 4) {
      errors.push(`Line ${i + 1}: expected 4 fields, got ${parts.length}`);
      continue;
    }
    const [rawDate, rawDesc, rawAmount, rawCurrency] = parts;

    // Skip a header row if present (non-date first column)
    if (i === 0 && !/^\d{2}-\d{2}-\d{4}$/.test(rawDate)) continue;

    const date = parseDate(rawDate);
    if (!date) { errors.push(`Line ${i + 1}: bad date "${rawDate}"`); continue; }

    const amount = parseAmount(rawAmount);
    if (amount == null) { errors.push(`Line ${i + 1}: bad amount "${rawAmount}"`); continue; }

    const description = unquote(rawDesc).trim().replace(/\s+/g, ' ');
    const currency = unquote(rawCurrency).trim() || 'DKK';

    rows.push({ date, description, amount, currency });
  }

  return { rows, errors };
}

// Split a single line on ';' respecting double-quoted fields.
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // Doubled quote inside a quoted field = literal "
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ';' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function unquote(s) {
  s = s.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

function parseDate(s) {
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  // Sanity check (e.g. month 13 wouldn't match anyway, but Date would silently roll over)
  const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
  if (isNaN(d.getTime())) return null;
  return `${yyyy}-${mm}-${dd}`;
}

function parseAmount(s) {
  s = s.trim();
  if (!s) return null;
  // "-1.234,56" → "-1234.56"; also tolerate "-1234,56" or plain "-1234.56"
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  let normalized;
  if (hasDot && hasComma) {
    // Danish format: . is thousands sep, , is decimal
    normalized = s.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    normalized = s.replace(',', '.');
  } else {
    normalized = s;
  }
  const n = Number(normalized);
  return isNaN(n) ? null : n;
}

window.parseDanishCsv = parseDanishCsv;

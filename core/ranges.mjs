// Deterministic reading of printed numbers and reference ranges.
// The model only transcribes what is printed; this file decides whether a value
// sits inside the range the document itself printed. No medical knowledge here.

const DASHES = /[‐-―−]/g; // hyphen variants and the minus sign

/** Decimal style used in a document: ',' (11,2) or '.' (11.2). */
export function detectDecimalStyle(texts) {
  let comma = 0;
  let dot = 0;
  for (const t of texts) {
    for (const m of String(t ?? '').matchAll(/\d([.,])\d{1,2}(?!\d)/g)) {
      if (m[1] === ',') comma += 1;
      else dot += 1;
    }
  }
  return comma > dot ? ',' : '.';
}

/** Parses one printed number. Returns null when the text is not a plain number. */
export function parseNumber(text, decimalStyle = '.') {
  let s = String(text ?? '').trim().replace(DASHES, '-').replace(/\s+/g, '');
  if (!/^[+-]?[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // The separator that comes last is the decimal one.
    const decimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    const group = decimal === ',' ? '.' : ',';
    s = s.split(group).join('').replace(decimal, '.');
  } else if (hasComma || hasDot) {
    const sep = hasComma ? ',' : '.';
    const parts = s.split(sep);
    const isGrouping =
      sep !== decimalStyle && parts.length >= 2 && parts.slice(1).every((p) => p.length === 3) && parts[0].replace(/^[+-]/, '').length <= 3;
    s = isGrouping ? parts.join('') : parts.length === 2 ? parts.join('.') : null;
    if (s === null) return null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const NUM = '[+-]?\\d(?:[\\d.,]*\\d)?'; // starts and ends with a digit

/**
 * Parses a printed reference range.
 * Returns { low, high, lowInclusive, highInclusive } with null for an open side,
 * or null when the text is not a numeric range (for example "negative").
 */
export function parseRange(text, decimalStyle = '.') {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const s = raw
    .replace(DASHES, '-')
    .replace(/≤|=<|<=|<\s*or\s*=/gi, '<=')
    .replace(/≥|=>|>=|>\s*or\s*=/gi, '>=')
    .replace(/\s+/g, ' ')
    .replace(/^[([]\s*(.*?)\s*[)\]]$/, '$1') // some labs print the range in brackets: "( 130-170 )"
    .replace(/(\d)\.(?=\s*-)/g, '$1') // "0.-129"
    .replace(/^(?:up to|bis|hasta|jusqu'à)\s+(?=[\d+-])/i, '<=');

  // Some labs print the unit after the range ("4.50-10.00 miles/µL"); it is ignored here.
  const UNIT = '(?:\\s*[^\\d\\s.,+-].*)?';
  let m = s.match(new RegExp(`^(${NUM})\\s*(?:-|to|bis|a|~|〜)\\s*(${NUM})${UNIT}$`, 'i'));
  if (m) {
    const low = parseNumber(m[1], decimalStyle);
    const high = parseNumber(m[2], decimalStyle);
    if (low === null || high === null || low > high) return null;
    return { low, high, lowInclusive: true, highInclusive: true };
  }
  m = s.match(new RegExp(`^(<=|<|>=|>)\\s*(${NUM})${UNIT}$`));
  if (m) {
    const n = parseNumber(m[2], decimalStyle);
    if (n === null) return null;
    if (m[1].startsWith('<')) return { low: null, high: n, lowInclusive: true, highInclusive: m[1] === '<=' };
    return { low: n, high: null, lowInclusive: m[1] === '>=', highInclusive: true };
  }
  return null;
}

/**
 * Some labs print their high/low mark right next to the result ("H 216", "+ 8.2", "5.6 *").
 * When such a mark ends up inside the value, this moves it to the flag field.
 */
export function tidyRow(row) {
  // A unit repeated inside the value ("13.5 g/dL" with unit "g/dL") is dropped from the value.
  const unit = String(row.unit ?? '').trim();
  const raw = String(row.value ?? '').trim();
  if (unit && raw.toLowerCase().endsWith(unit.toLowerCase())) {
    const bare = raw.slice(0, raw.length - unit.length).trim();
    if (parseNumber(bare) !== null) return { ...row, value: bare };
  }
  const m = raw.match(/^(?:([A-Za-z+*!↑↓-]{1,3})\s+)?(\S+)(?:\s+([A-Za-z+*!↑↓]{1,3}))?$/);
  if (!m || (!m[1] && !m[3]) || parseNumber(m[2]) === null) return row;
  const flag = String(row.flag ?? '').trim() || [m[1], m[3]].filter(Boolean).join(' ');
  return { ...row, value: m[2], flag };
}

/**
 * Places a printed value against the printed range.
 * 'in' | 'above' | 'below' | 'edge' | 'unknown'
 *   edge    = exactly on a limit the page prints as "less than" / "more than"; labs differ
 *             on which side that counts, so it is shown as "on the limit", not as out of range
 *   unknown = cannot be decided from the page
 */
export function placeInRange(valueText, rangeText, decimalStyle = '.') {
  const range = parseRange(rangeText, decimalStyle);
  if (range === null) return 'unknown';
  const raw = String(valueText ?? '').trim();

  // Results the lab itself reports as "more than x" / "less than x".
  const open = raw.match(/^([<>])\s*(.+)$/);
  if (open) {
    const x = parseNumber(open[2], decimalStyle);
    if (x === null) return 'unknown';
    if (open[1] === '>') {
      if (range.high !== null && x >= range.high) return 'above';
      if (range.high === null && range.low !== null && x >= range.low) return 'in';
    } else {
      if (range.low !== null && x <= range.low) return 'below';
      if (range.low === null && range.high !== null && x <= range.high) return 'in';
    }
    return 'unknown';
  }

  const value = parseNumber(raw, decimalStyle);
  if (value === null) return 'unknown';
  if (range.low !== null) {
    if (value < range.low) return 'below';
    if (value === range.low && !range.lowInclusive) return 'edge';
  }
  if (range.high !== null) {
    if (value > range.high) return 'above';
    if (value === range.high && !range.highInclusive) return 'edge';
  }
  return 'in';
}

// Two models read every page on their own. This file compares what they brought back.
// No model is involved here: a line counts as read the same only when the characters
// match. Spaces, line breaks, upper and lower case and the shape of a dash do not count
// as a difference; a digit, a letter or a separator does.

const DASHES = /[‐-―−]/g;
const QUOTES = /[‘’‚′`´]/g;

/** What two readings are compared on: everything except spacing, case and dash shape. */
export const norm = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(DASHES, '-').replace(QUOTES, "'").replace(/\s+/g, '');
export const same = (a, b) => norm(a) === norm(b);

// In running text the mark in front of a list item ("•", "-", "*") is layout, not content:
// one reader copies a bullet as a dot, the other as a dash.
const BULLETS = /[•‣▪◦●○■□▸►∙]/g;
const LIST_DASH = /(^|\n)[ \t]*[-–—*·][ \t]+/g;
const normLine = (text) => norm(String(text ?? '').replace(LIST_DASH, '$1').replace(BULLETS, ''));

const words = (text) => new Set(String(text ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
/** Share of words two lines have in common, 0 to 1. Only used to pick which line to show next to another. */
export function likeness(a, b) {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return (2 * shared) / (x.size + y.size);
}

/** Where two readings of one line part and meet again: [start, endA, endB]. For marking the difference on screen. */
export function differingPart(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start += 1;
  let endA = x.length;
  let endB = y.length;
  while (endA > start && endB > start && x[endA - 1] === y[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  return [start, endA, endB];
}

const ROW_FIELDS = ['name', 'value', 'unit', 'range', 'flag'];

/**
 * Lab rows of the two readers, matched by test name (the order on the page breaks ties).
 * rows[i] belongs to first[i]:
 *   { status: 'agree' }                         every field matches
 *   { status: 'differ', other, fields }         the second reader has this row with other characters in `fields`
 *   { status: 'missing' }                       the second reader has no row with this name
 * extra: rows only the second reader has.
 */
export function compareRows(first, second) {
  const free = second.map((row, index) => ({ row, index, taken: false }));
  const rows = first.map((row, i) => {
    const candidates = free.filter((c) => !c.taken && same(c.row.name, row.name));
    const match = candidates.find((c) => c.index === i) ?? candidates[0] ?? null;
    if (!match) return { status: 'missing' };
    match.taken = true;
    const fields = ROW_FIELDS.filter((f) => !same(row[f], match.row[f]));
    return fields.length === 0 ? { status: 'agree' } : { status: 'differ', other: match.row, fields };
  });
  // A row whose name itself was read differently has no partner by name: pair it with the
  // unmatched row at the same place on the page, so the two readings are shown together.
  rows.forEach((result, i) => {
    if (result.status !== 'missing') return;
    const partner = free.find((c) => !c.taken && c.index === i && likeness(c.row.name, first[i].name) < 1);
    if (!partner || second.length !== first.length) return;
    partner.taken = true;
    rows[i] = { status: 'differ', other: partner.row, fields: ROW_FIELDS.filter((f) => !same(first[i][f], partner.row[f])) };
  });
  return { rows, extra: free.filter((c) => !c.taken).map((c) => c.row) };
}

const LINE_FIELDS = { medicines: ['name', 'strength', 'schedule', 'duration'], follow_ups: ['what', 'when'], cautions: ['text'] };
const KEY = { medicines: 'name', follow_ups: 'what', cautions: 'text' };
const sentences = (text) => String(text ?? '').split(/\n+|(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 1);

function closest(line, candidates, read = (c) => c) {
  let best = null;
  let score = 0;
  for (const c of candidates) {
    const s = likeness(line, read(c));
    if (s > score) {
      best = c;
      score = s;
    }
  }
  return { best, score };
}

/**
 * Take-home lines of the first reader against the second reader's copy of the same page.
 * A line is read the same when its source line is in the second reader's text and its
 * medicine, dose, schedule and duration are inside that line.
 * lines[kind][i] belongs to plan[kind][i]:
 *   { status: 'agree' }
 *   { status: 'differ', other: { line, data } }   line: what the second reader has in that place ('' when nothing
 *                                                 like it); data: the second reader's own entry for it, or null
 * extra[kind]: entries only the second reader listed.
 */
export function compareLines(plan, secondText, secondPlan = { medicines: [], follow_ups: [], cautions: [] }) {
  const page = normLine(secondText);
  const lines = {};
  const extra = {};
  for (const [kind, fields] of Object.entries(LINE_FIELDS)) {
    const theirs = secondPlan[kind] ?? [];
    const used = new Set();
    lines[kind] = (plan[kind] ?? []).map((item) => {
      const source = normLine(item.source);
      const agree = source !== '' && page.includes(source) && fields.every((f) => normLine(item[f]) === '' || source.includes(normLine(item[f])));
      const mine = closest(item.source, theirs.filter((t) => !used.has(t)), (t) => t.source);
      const partner = mine.score >= 0.5 || (mine.best && same(mine.best[KEY[kind]], item[KEY[kind]])) ? mine.best : null;
      if (partner) used.add(partner);
      if (agree) return { status: 'agree' };
      if (partner) return { status: 'differ', other: { line: partner.source, data: partner } };
      const near = closest(item.source, sentences(secondText));
      return { status: 'differ', other: { line: near.score >= 0.3 ? near.best : '', data: null } };
    });
    // What only the second reader listed. A line the first reader covers inside a longer or shorter source line is not extra.
    extra[kind] = theirs.filter((t) => {
      if (used.has(t)) return false;
      const source = normLine(t.source);
      return !(plan[kind] ?? []).some((item) => {
        const own = normLine(item.source);
        return own.includes(source) || source.includes(own) || same(item[KEY[kind]], t[KEY[kind]]);
      });
    });
  }
  return { lines, extra };
}

/** How many lines of a page the two readers did not read the same, extra lines included. */
export function disagreements(result) {
  if (result.rows) return result.rows.filter((r) => r.status !== 'agree').length + result.extra.length;
  let n = 0;
  for (const kind of Object.keys(LINE_FIELDS)) n += result.lines[kind].filter((l) => l.status !== 'agree').length + result.extra[kind].length;
  return n;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { compareLines, compareRows, differingPart, disagreements, same } from './compare.mjs';

test('spacing, case and dash shape are not differences; characters are', () => {
  assert.equal(same('12,0 - 16,0', '12,0–16,0'), true);
  assert.equal(same('mg/dL', 'MG/DL'), true);
  assert.equal(same('875/125 mg', '875/125mg'), true);
  assert.equal(same('11,2', '11.2'), false);
  assert.equal(same('5 mg', '6 mg'), false);
  assert.equal(same('Ramipril', 'Rampiril'), false);
});

const row = (name, value, unit = 'mg/dL', range = '70 - 100', flag = '') => ({ name, value, unit, range, flag });

test('lab rows: the same reading agrees whatever the spacing', () => {
  const a = [row('Glukoz', '104'), row('Kreatinin', '0,78', 'mg/dL', '0,50 - 0,90')];
  const b = [row('Glukoz', '104', 'mg/dL', '70-100'), row('KREATININ', '0,78', 'mg/dL', '0,50 – 0,90')];
  const result = compareRows(a, b);
  assert.deepEqual(result.rows.map((r) => r.status), ['agree', 'agree']);
  assert.equal(disagreements(result), 0);
});

test('lab rows: a different digit or separator is a disagreement on that field', () => {
  const result = compareRows([row('Glukoz', '104'), row('CRP', '24,5', 'mg/l', '< 5,0', '+')], [row('Glukoz', '164'), row('CRP', '24.5', 'mg/l', '< 5,0', '+')]);
  assert.equal(result.rows[0].status, 'differ');
  assert.deepEqual(result.rows[0].fields, ['value']);
  assert.equal(result.rows[0].other.value, '164');
  assert.deepEqual(result.rows[1].fields, ['value']);
  assert.equal(disagreements(result), 2);
});

test('lab rows: a row one reader missed is reported on both sides', () => {
  const result = compareRows([row('Glukoz', '104'), row('Üre', '31')], [row('Glukoz', '104'), row('Sodyum', '139')]);
  assert.equal(result.rows[1].status, 'differ'); // same place on the page, different name: shown together
  assert.deepEqual(result.rows[1].fields, ['name', 'value']);
  const shorter = compareRows([row('Glukoz', '104'), row('Üre', '31')], [row('Glukoz', '104')]);
  assert.equal(shorter.rows[1].status, 'missing');
  const longer = compareRows([row('Glukoz', '104')], [row('Glukoz', '104'), row('Sodyum', '139')]);
  assert.deepEqual(longer.extra.map((r) => r.name), ['Sodyum']);
  assert.equal(disagreements(longer), 1);
});

const plan = {
  medicines: [
    { name: 'Ramipril', strength: '5 mg', schedule: '1-0-0', duration: '', source: 'Ramipril 5 mg 1-0-0.' },
    { name: 'Atorvastatin', strength: '20 mg', schedule: '0-0-1', duration: '', source: 'Atorvastatin 20 mg 0-0-1.' },
  ],
  follow_ups: [{ what: 'Röntgen-Kontrolle des Thorax', when: 'in 6 Wochen', source: 'Röntgen-Kontrolle des Thorax in 6 Wochen beim Hausarzt.' }],
  cautions: [],
};
const secondText = `Medikation bei Entlassung
Ramipril 5 mg 1–0–0.   Atorvastatin 20 mg 0-0-1.
Röntgen-Kontrolle des Thorax in 6 Wochen
beim Hausarzt.`;

test('lines: found in the second copy with their dose inside means read the same', () => {
  const result = compareLines(plan, secondText);
  assert.deepEqual(result.lines.medicines.map((l) => l.status), ['agree', 'agree']);
  assert.equal(result.lines.follow_ups[0].status, 'agree');
  assert.equal(disagreements(result), 0);
});

test('lines: a misread dose is a disagreement and the other reading is shown', () => {
  const theirs = { medicines: [{ name: 'Ramipril', strength: '6 mg', schedule: '1-0-0', duration: '', source: 'Ramipril 6 mg 1-0-0.' }], follow_ups: [], cautions: [] };
  const result = compareLines(plan, secondText.replace('Ramipril 5 mg', 'Ramipril 6 mg'), theirs);
  assert.equal(result.lines.medicines[0].status, 'differ');
  assert.equal(result.lines.medicines[0].other.line, 'Ramipril 6 mg 1-0-0.');
  assert.equal(result.lines.medicines[0].other.data.strength, '6 mg');
  assert.equal(result.lines.medicines[1].status, 'agree');
});

test('lines: without an entry from the second reader, its closest sentence is shown', () => {
  const result = compareLines(plan, secondText.replace('Atorvastatin 20 mg', 'Atorvastatln 20 mg'));
  assert.equal(result.lines.medicines[1].status, 'differ');
  assert.equal(result.lines.medicines[1].other.data, null);
  assert.match(result.lines.medicines[1].other.line, /Atorvastatln 20 mg/);
});

test('lines: what only the second reader listed is reported, unless the first covers it', () => {
  const theirs = {
    medicines: [{ name: 'Ramipril', strength: '5 mg', schedule: '1-0-0', duration: '', source: 'Ramipril 5 mg 1-0-0.' }],
    follow_ups: [],
    cautions: [{ text: 'Wiedervorstellung bei erneutem Fieber.', source: 'Wiedervorstellung bei erneutem Fieber.' }],
  };
  const result = compareLines(plan, `${secondText}\nWiedervorstellung bei erneutem Fieber.`, theirs);
  assert.deepEqual(result.extra.medicines, []);
  assert.deepEqual(result.extra.cautions.map((c) => c.text), ['Wiedervorstellung bei erneutem Fieber.']);
  assert.equal(disagreements(result), 1);
});

test('the part where two readings differ is found for marking', () => {
  assert.deepEqual(differingPart('Ramipril 5 mg 1-0-0.', 'Ramipril 6 mg 1-0-0.'), [9, 10, 10]);
  assert.deepEqual(differingPart('abc', 'abc'), [3, 3, 3]);
});

test('lines: the mark in front of a list item is layout, not a difference', () => {
  const mine = { medicines: [{ name: 'Ibuprofen', strength: '600 mg', schedule: 'alle 6 Stunden', duration: '', source: '• Ibuprofen 600 mg alle 6 Stunden' }], follow_ups: [], cautions: [] };
  const result = compareLines(mine, 'Medikation bei Entlassung:\n- Ibuprofen 600 mg alle 6 Stunden\n- Omeprazol 20 mg 1-0-0 bei Bedarf');
  assert.equal(result.lines.medicines[0].status, 'agree');
  assert.equal(same('- 3', '3'), false); // a value keeps its sign
});

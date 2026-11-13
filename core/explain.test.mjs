import test from 'node:test';
import assert from 'node:assert/strict';
import { checkExplanation, explainInput } from './explain.mjs';

const page = {
  document_kind: 'lab_results',
  language: 'de',
  rows: [
    { name: 'Hämoglobin', value: '13,8', unit: 'g/dl', range: '13,5 - 17,5', flag: '' },
    { name: 'CRP', value: '24,5', unit: 'mg/l', range: '< 5,0', flag: '+' },
  ],
  text: 'Amoxicillin 875/125 mg 1-0-1',
};
const input = explainInput({ page, placements: ['in', 'above'], targetLanguage: 'tr' });
const good = {
  summary: 'Bu bir kan tahlili sonucudur.',
  rows: [
    { index: 0, plain_name: 'Hemoglobin', what_it_is: 'Kanda oksijen taşıyan proteini ölçer.', note: '' },
    { index: 1, plain_name: 'CRP', what_it_is: 'Vücuttaki iltihabı gösteren bir proteindir.', note: 'Yüksek değerler enfeksiyonlarda görülebilir. Belgedeki değer 24,5.' },
  ],
  sections: [{ title: 'İlaç', plain: 'Amoksisilin 875/125 mg, sabah 1, akşam 1.' }],
  terms: [],
  questions: ['CRP değerim neden yüksek olabilir?'],
};

test('an explanation that only uses printed numbers passes', () => {
  assert.deepEqual(checkExplanation(good, input), []);
  assert.equal(input.requested_language, 'Turkish');
});

test('a number that is not on the page is rejected', () => {
  const bad = structuredClone(good);
  bad.rows[1].note = 'Normalde 10 altında olmalıdır.';
  assert.deepEqual(checkExplanation(bad, input), ['row 1 note: number 10 is not printed on the page']);
});

test('a note on an in-range row, a missing row and an unknown row are rejected', () => {
  const bad = structuredClone(good);
  bad.rows[0].note = 'Biraz düşük sayılır.';
  bad.rows[1].index = 7;
  const problems = checkExplanation(bad, input);
  assert.ok(problems.includes('row 0: has a note although the value is not outside its printed range'));
  assert.ok(problems.includes('row 7: does not match a row on the page'));
  assert.ok(problems.includes('row 1: no explanation returned'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDecimalStyle, parseNumber, parseRange, placeInRange, tidyRow } from './ranges.mjs';

test('numbers: decimal comma, decimal point, grouping', () => {
  assert.equal(parseNumber('11,2', ','), 11.2);
  assert.equal(parseNumber('0,78', ','), 0.78);
  assert.equal(parseNumber('1.31', '.'), 1.31);
  assert.equal(parseNumber('5200', '.'), 5200);
  assert.equal(parseNumber('1,250', '.'), 1250);
  assert.equal(parseNumber('1.250', ','), 1250);
  assert.equal(parseNumber('1.234,5', ','), 1234.5);
  assert.equal(parseNumber('4,62', '.'), 4.62);
  assert.equal(parseNumber('−3', '.'), -3);
});

test('numbers: text that is not a number stays null', () => {
  for (const t of ['', 'negatif', '12 mg', '<5', '1,2,3', 'N/A']) assert.equal(parseNumber(t), null, t);
});

test('decimal style is read from the document', () => {
  assert.equal(detectDecimalStyle(['11,2', '7,4', '312']), ',');
  assert.equal(detectDecimalStyle(['1.31', '5.4', '139']), '.');
  assert.equal(detectDecimalStyle(['312', '48']), '.');
});

test('ranges: closed, open, inclusive, different dashes', () => {
  assert.deepEqual(parseRange('12,0 - 16,0', ','), { low: 12, high: 16, lowInclusive: true, highInclusive: true });
  assert.deepEqual(parseRange('3,9–5,6', ','), { low: 3.9, high: 5.6, lowInclusive: true, highInclusive: true });
  assert.deepEqual(parseRange('< 130'), { low: null, high: 130, lowInclusive: true, highInclusive: false });
  assert.deepEqual(parseRange('> OR = 60'), { low: 60, high: null, lowInclusive: true, highInclusive: true });
  assert.deepEqual(parseRange('≤ 5,0', ','), { low: null, high: 5, lowInclusive: true, highInclusive: true });
  assert.deepEqual(parseRange('65 - 163'), { low: 65, high: 163, lowInclusive: true, highInclusive: true });
  // layouts seen in real reports: unit printed after the range, uneven decimals
  assert.deepEqual(parseRange('4.50-10.00 miles/µL'), { low: 4.5, high: 10, lowInclusive: true, highInclusive: true });
  assert.deepEqual(parseRange('11.5 - 17.0 %'), { low: 11.5, high: 17, lowInclusive: true, highInclusive: true });
  assert.deepEqual(parseRange('35 - 80,0', ','), { low: 35, high: 80, lowInclusive: true, highInclusive: true });
  assert.deepEqual(parseRange('< 5,0 mg/l', ','), { low: null, high: 5, lowInclusive: true, highInclusive: false });
  // single-digit ends and bracketed ranges, both found on real pages
  assert.deepEqual(parseRange('1-4'), { low: 1, high: 4, lowInclusive: true, highInclusive: true });
  assert.deepEqual(parseRange('0 - 5'), { low: 0, high: 5, lowInclusive: true, highInclusive: true });
  assert.deepEqual(parseRange('1,2 - 8', ','), { low: 1.2, high: 8, lowInclusive: true, highInclusive: true });
  assert.deepEqual(parseRange('( 130-170 )'), { low: 130, high: 170, lowInclusive: true, highInclusive: true });
  assert.deepEqual(parseRange('(0.400-0.500)'), { low: 0.4, high: 0.5, lowInclusive: true, highInclusive: true });
  assert.deepEqual(parseRange('> 9'), { low: 9, high: null, lowInclusive: false, highInclusive: true });
  assert.equal(parseRange('negative'), null);
  assert.equal(parseRange(''), null);
  assert.equal(parseRange('16 - 12'), null);
});

test('a mark printed next to the value moves to the flag', () => {
  assert.deepEqual(tidyRow({ value: '+ 8.2', flag: '' }), { value: '8.2', flag: '+' });
  assert.deepEqual(tidyRow({ value: 'H 216', flag: '' }), { value: '216', flag: 'H' });
  assert.deepEqual(tidyRow({ value: '5,6 *', flag: '' }), { value: '5,6', flag: '*' });
  assert.deepEqual(tidyRow({ value: 'H 216', flag: 'H' }), { value: '216', flag: 'H' });
  for (const value of ['-3', '11,2', 'negatif', 'A Rh pozitif', '']) assert.deepEqual(tidyRow({ value, flag: '' }), { value, flag: '' });
  assert.deepEqual(tidyRow({ value: '13.5 g/dL', unit: 'g/dL', flag: '' }), { value: '13.5', unit: 'g/dL', flag: '' });
  assert.deepEqual(tidyRow({ value: '40%', unit: '%', flag: '' }), { value: '40', unit: '%', flag: '' });
});

test('placement uses only what the page printed', () => {
  assert.equal(placeInRange('11,2', '12,0 - 16,0', ','), 'below');
  assert.equal(placeInRange('104', '70 - 100'), 'above');
  assert.equal(placeInRange('100', '70 - 100'), 'in');
  assert.equal(placeInRange('162', '< 130'), 'above');
  assert.equal(placeInRange('130', '< 130'), 'edge');
  assert.equal(placeInRange('5.0', '( <5.0 )'), 'edge');
  assert.equal(placeInRange('40', '> 40'), 'edge');
  assert.equal(placeInRange('2', 'Up to 15'), 'in');
  assert.equal(placeInRange('98', '0.-129'), 'in');
  // results the lab reports as "more than" / "less than"
  assert.equal(placeInRange('> 20.0', '( > 3.8 )'), 'in');
  assert.equal(placeInRange('> 90', '> 60'), 'in');
  assert.equal(placeInRange('< 0,3', '0,5 - 5', ','), 'below');
  assert.equal(placeInRange('> 500', '10 - 200'), 'above');
  assert.equal(placeInRange('> 20', '10 - 200'), 'unknown');
  assert.equal(placeInRange('48', '> 40'), 'in');
  assert.equal(placeInRange('58', '> OR = 60'), 'below');
  assert.equal(placeInRange('60', '> OR = 60'), 'in');
  assert.equal(placeInRange('pozitif', 'negatif'), 'unknown');
  assert.equal(placeInRange('9', ''), 'unknown');
});

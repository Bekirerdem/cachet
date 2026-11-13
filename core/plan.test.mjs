import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPlain, checkPlan, openPoints, readSlots } from './plan.mjs';

const page = `Medikation bei Entlassung
Amoxicillin/Clavulansäure 875/125 mg 1-0-1 bis einschließlich 10.11.2026.
Ramipril 5 mg 1-0-0. Atorvastatin 20 mg 0-0-1.
Empfehlung: Röntgenkontrolle des Thorax in 6 Wochen.
Bei erneutem Fieber bitte umgehend Wiedervorstellung.`;

const good = {
  medicines: [
    {
      name: 'Amoxicillin/Clavulansäure',
      strength: '875/125 mg',
      schedule: '1-0-1',
      duration: 'bis einschließlich 10.11.2026',
      source: 'Amoxicillin/Clavulansäure 875/125 mg 1-0-1 bis einschließlich 10.11.2026.',
    },
    { name: 'Ramipril', strength: '5 mg', schedule: '1-0-0', duration: '', source: 'Ramipril 5 mg 1-0-0.' },
  ],
  follow_ups: [{ what: 'Röntgenkontrolle des Thorax', when: 'in 6 Wochen', source: 'Empfehlung: Röntgenkontrolle des Thorax in 6 Wochen.' }],
  cautions: [{ text: 'Bei erneutem Fieber bitte umgehend Wiedervorstellung.', source: 'Bei erneutem Fieber bitte umgehend Wiedervorstellung.' }],
};

test('a plan that only points at the page passes', () => {
  assert.deepEqual(checkPlan(good, page), []);
});

test('line breaks inside a source line do not matter', () => {
  const wrapped = page.replace('1-0-1 bis', '1-0-1\n   bis');
  assert.deepEqual(checkPlan(good, wrapped), []);
});

test('a changed dose is caught', () => {
  const plan = structuredClone(good);
  plan.medicines[1].strength = '10 mg';
  assert.match(checkPlan(plan, page)[0], /medicines 1: "strength" is not inside its source line/);
});

test('a medicine that is not on the page is caught', () => {
  const plan = structuredClone(good);
  plan.medicines.push({ name: 'Ibuprofen', strength: '400 mg', schedule: '1-1-1', duration: '', source: 'Ibuprofen 400 mg 1-1-1.' });
  assert.match(checkPlan(plan, page)[0], /medicines 2: its source line is not on the page/);
});

test('a schedule taken from another medicine is caught', () => {
  const plan = structuredClone(good);
  plan.medicines[1].schedule = '0-0-1';
  assert.equal(checkPlan(plan, page).length, 1);
});

test('what the page leaves open becomes a question', () => {
  assert.deepEqual(openPoints(good), [{ index: 1, name: 'Ramipril', missing: 'duration' }]);
});

test('the morning-noon-evening notation is read in code', () => {
  assert.deepEqual(readSlots('1-0-1'), { morning: '1', noon: '0', evening: '1', night: null, rest: '' });
  assert.deepEqual(readSlots('1 - 0 - 0 bei Bedarf'), { morning: '1', noon: '0', evening: '0', night: null, rest: 'bei Bedarf' });
  assert.deepEqual(readSlots('½-0-½-1'), { morning: '½', noon: '0', evening: '½', night: '1', rest: '' });
  for (const other of ['günde 3 kez', 'every 6 hours', '10-11', '']) assert.equal(readSlots(other), null, other);
});

const plain = {
  medicines: [
    { index: 0, kind: 'antibiyotik', how: '10 Kasım 2026 dahil o güne kadar' },
    { index: 1, kind: 'tansiyon ilacı', how: '' },
  ],
  follow_ups: [{ index: 0, plain: 'Akciğer röntgeni kontrolü 6 hafta sonra.' }],
  cautions: [{ index: 0, plain: 'Ateş yeniden çıkarsa hemen yeniden başvurun.' }],
  questions: ['Ramipril ne kadar süre kullanılacak?'],
};

test('a retelling that stays inside its source lines passes', () => {
  assert.deepEqual(checkPlain(plain, good), []);
});

test('a number from outside the source line is caught', () => {
  const changed = structuredClone(plain);
  changed.follow_ups[0].plain = 'Akciğer röntgeni kontrolü 4 hafta sonra.';
  assert.deepEqual(checkPlain(changed, good), ['follow_ups 0: number 4 is not in its source line']);
});

test('a dropped or invented entry is caught', () => {
  const changed = structuredClone(plain);
  changed.medicines.pop();
  changed.cautions.push({ index: 1, plain: 'Bol su için.' });
  assert.deepEqual(checkPlain(changed, good), ['medicines 1: not retold', 'cautions 1: does not match an entry of the plan']);
});

test('a question may not carry a number', () => {
  const changed = structuredClone(plain);
  changed.questions = ['Ramipril 10 mg olarak mı kullanılacak?'];
  assert.deepEqual(checkPlain(changed, good), ['question 0: contains a number']);
});

// Measures the take-home plan on letters: copy the page (image), pull the plan out of
// the copied text, then check every entry against the page in code.
//
//   node --env-file=../.env plan.mjs
//
// Fictional letters have known medicines; real test pages (local only) are printed for
// checking by eye.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InferenceClient } from '@nearai/inference-sdk/node';
import { parseTranscription, transcribeRequest } from '../core/reading.mjs';
import { checkPlain, checkPlan, openPoints, parsePlain, parsePlan, plainInput, plainRequest, planRequest, readSlots } from '../core/plan.mjs';
import { createSession } from '../core/session.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const apiKey = process.env.NEARAI_API_KEY;
if (!apiKey) {
  console.error('Set NEARAI_API_KEY first. Nothing was sent.');
  process.exit(2);
}
const MODELS = (process.env.MODELS ?? 'Qwen/Qwen3.8-27B').split(',');
const LANGUAGE = process.env.LANGUAGE ?? 'Turkish';

// name, strength, schedule, duration exactly as the fictional letters print them
const KNOWN = {
  'de-letter': [
    ['Amoxicillin/Clavulansäure', '875/125 mg', '1-0-1', '10.11.2026'],
    ['Ramipril', '5 mg', '1-0-0', ''],
    ['Atorvastatin', '20 mg', '0-0-1', ''],
  ],
  'tr-letter': [
    ['Parasetamol', '500 mg', 'günde 3 kez', '5 gün'],
    ['Sefuroksim aksetil', '500 mg', 'günde 2 kez', '5 gün'],
  ],
};

const pages = [];
for (const doc of Object.keys(KNOWN)) for (const look of ['clean', 'photo']) pages.push({ file: join(here, '..', 'samples', 'out', `${doc}.${look}.png`), label: `${doc}.${look}`, known: KNOWN[doc] });
const realDir = join(here, '..', 'testdocs', 'pages');
for (const name of ['de-letter-01.p1', 'de-letter-01.p2', 'de-letter-stemi.p1', 'de-letter-stemi.p2', 'de-letter-photo-02.p1', 'en-letter-dc-01.p1', 'en-letter-dc-01.p2', 'en-letter-dc-02.p1', 'en-letter-dc-02.p2']) {
  const file = join(realDir, `${name}.jpg`);
  if (existsSync(file)) pages.push({ file, label: name, known: null });
}

const results = [];
for (const model of MODELS) {
  const session = createSession(() => new InferenceClient({ apiKey, baseUrl: 'https://cloud-api.near.ai/v1', e2ee: true }));
  for (const { file, label, known } of pages) {
    const mime = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const imageDataUrl = `data:${mime};base64,${readFileSync(file).toString('base64')}`;
    const entry = { model, label };
    const started = performance.now();
    try {
      const read = await session.send(transcribeRequest({ model, imageDataUrl }), { parse: parseTranscription });
      const page = read.parsed;
      const made = await session.send(planRequest({ model, text: page.text }), { parse: parsePlan });
      const plan = made.parsed;
      entry.attempts = [read.attempts, made.attempts];
      entry.seconds = Number(((performance.now() - started) / 1000).toFixed(1));
      entry.text = page.text;
      entry.plan = plan;
      entry.problems = checkPlan(plan, page.text);
      entry.open = openPoints(plan);
      let score = '';
      if (known) {
        const has = (m, [name, strength, schedule, duration]) =>
          m.name.includes(name) && m.strength.includes(strength) && m.schedule.includes(schedule) && m.duration.includes(duration);
        const found = known.filter((k) => plan.medicines.some((m) => has(m, k))).length;
        entry.known = { expected: known.length, found, extra: plan.medicines.length - found };
        score = `  medicines right ${found}/${known.length}, extra ${entry.known.extra}`;
      }
      console.log(
        `\n${label}  [${model}]  ${entry.seconds}s  medicines ${plan.medicines.length}  follow-ups ${plan.follow_ups.length}  cautions ${plan.cautions.length}  rejected by the check ${entry.problems.length}${score}`,
      );
      for (const m of plan.medicines) console.log(`   med: ${m.name} | ${m.strength} | ${m.schedule} | ${m.duration}`);
      for (const f of plan.follow_ups) console.log(`   follow-up: ${f.what} | ${f.when}`);
      for (const c of plan.cautions) console.log(`   caution: ${c.text.slice(0, 140)}`);
      for (const p of entry.problems) console.log(`   CHECK: ${p}`);
      if (entry.problems.length === 0 && plan.medicines.length + plan.follow_ups.length + plan.cautions.length > 0) {
        const told = await session.send(plainRequest({ model, input: plainInput({ plan, language: LANGUAGE }) }), { parse: parsePlain });
        entry.plain = told.parsed;
        entry.plainProblems = checkPlain(told.parsed, plan);
        console.log(`   -> ${LANGUAGE}: rejected by the check ${entry.plainProblems.length}`);
        for (const m of told.parsed.medicines) {
          const slots = readSlots(plan.medicines[m.index]?.schedule);
          console.log(`      ${plan.medicines[m.index]?.name} = ${m.kind} | ${slots ? JSON.stringify(slots) : ''} ${m.how}`);
        }
        for (const f of told.parsed.follow_ups) console.log(`      kontrol: ${f.plain}`);
        for (const c of told.parsed.cautions) console.log(`      dikkat: ${c.plain}`);
        for (const q of told.parsed.questions) console.log(`      soru: ${q}`);
        for (const p of entry.plainProblems) console.log(`      CHECK: ${p}`);
      }
    } catch (error) {
      entry.error = `${error?.failure?.code ?? error?.name}: ${error?.message}`;
      console.log(`\n${label}  [${model}]  FAILED  ${entry.error}`);
    }
    results.push(entry);
  }
}
mkdirSync(join(here, 'results'), { recursive: true });
const out = join(here, 'results', `plan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log('\nsaved', out);

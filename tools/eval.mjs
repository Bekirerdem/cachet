// Measures how well a private NEAR AI model copies the fictional sample documents,
// with the page encrypted to the model's attested key and the reply signature checked.
//
//   NEARAI_API_KEY=... node eval.mjs                      (both models, all samples)
//   NEARAI_API_KEY=... MODELS=Qwen/Qwen3.8-27B ONLY=tr-lab node eval.mjs
//
// Prints one line per page and writes results/<timestamp>.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InferenceClient } from '@nearai/inference-sdk/node';
import { DOCS } from '../samples/docs.mjs';
import { parseTranscription, transcribeRequest } from '../core/reading.mjs';
import { detectDecimalStyle, placeInRange } from '../core/ranges.mjs';
import { createSession } from '../core/session.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const apiKey = process.env.NEARAI_API_KEY;
if (!apiKey) {
  console.error('Set NEARAI_API_KEY first. Nothing was sent.');
  process.exit(2);
}
const MODELS = (process.env.MODELS ?? 'Qwen/Qwen3.8-27B,z-ai/glm-5.3-flash').split(',');
const VARIANTS = (process.env.VARIANTS ?? 'clean,photo').split(',');
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const PRICE = { 'Qwen/Qwen3.8-27B': [0.04, 1.35], 'z-ai/glm-5.3-flash': [0.08, 0.5] }; // USD per million tokens, in / out

const norm = (s) => String(s ?? '').normalize('NFKC').replace(/[‐-―−]/g, '-').replace(/\s+/g, ' ').trim();
const loose = (s) => norm(s).toLowerCase().replace(/\s+/g, '');

function scoreLab(doc, page) {
  const truth = doc.sections.flatMap(([, rows]) => rows);
  const got = page.rows;
  const used = new Set();
  const fields = { value: 0, unit: 0, range: 0, flag: 0 };
  const mistakes = [];
  let found = 0;
  for (const [name, value, unit, range, flag] of truth) {
    const i = got.findIndex((r, idx) => !used.has(idx) && (loose(r.name) === loose(name) || loose(r.name).includes(loose(name)) || loose(name).includes(loose(r.name))));
    if (i === -1) {
      mistakes.push(`missing row: ${name}`);
      continue;
    }
    used.add(i);
    found += 1;
    const r = got[i];
    for (const [key, want] of [['value', value], ['unit', unit], ['range', range], ['flag', flag]]) {
      if (loose(r[key]) === loose(want)) fields[key] += 1;
      else mistakes.push(`${name} ${key}: printed "${want}", read "${r[key]}"`);
    }
  }
  // The decision the product actually shows: is each value inside its printed range?
  const style = detectDecimalStyle(truth.map((t) => t[1]));
  let placement = 0;
  for (const [name, value, , range] of truth) {
    const r = got.find((g) => loose(g.name) === loose(name) || loose(g.name).includes(loose(name)) || loose(name).includes(loose(g.name)));
    if (r && placeInRange(r.value, r.range, style) === placeInRange(value, range, style)) placement += 1;
  }
  return { rows: truth.length, found, extra: got.length - used.size, ...fields, placement, mistakes };
}

function scoreLetter(doc, page) {
  const text = loose(page.text + ' ' + page.rows.map((r) => Object.values(r).join(' ')).join(' '));
  const missing = doc.facts.filter((f) => !text.includes(loose(f)));
  const leakedName = doc.patient.some(([, v]) => /[A-Za-zÀ-ÿ぀-ヿ一-鿿]{3,}\s+[A-Za-zÀ-ÿ぀-ヿ一-鿿]{3,}/.test(v) && text.includes(loose(v)));
  return { facts: doc.facts.length, found: doc.facts.length - missing.length, leakedName, mistakes: missing.map((m) => `missing fact: ${m}`) };
}

const results = [];
for (const model of MODELS) {
  const session = createSession(() => new InferenceClient({ apiKey, baseUrl: 'https://cloud-api.near.ai/v1', e2ee: true }));
  for (const doc of DOCS) {
    if (ONLY && !ONLY.includes(doc.id)) continue;
    for (const variant of VARIANTS) {
      const label = `${model}  ${doc.id}.${variant}`;
      const png = readFileSync(join(here, '..', 'samples', 'out', `${doc.id}.${variant}.png`));
      const imageDataUrl = `data:image/png;base64,${png.toString('base64')}`;
      const started = performance.now();
      const entry = { model, doc: doc.id, variant, lang: doc.lang, kind: doc.kind };
      try {
        const { completion, verified, attempts } = await session.send(transcribeRequest({ model, imageDataUrl }));
        entry.seconds = Number(((performance.now() - started) / 1000).toFixed(1));
        entry.attempts = attempts;
        entry.signature = verified.signatureKind + (attempts > 1 ? ` (attempt ${attempts})` : '');
        const usage = completion.usage ?? {};
        const [pin, pout] = PRICE[model] ?? [0, 0];
        entry.usd = Number((((usage.prompt_tokens ?? 0) * pin + (usage.completion_tokens ?? 0) * pout) / 1e6).toFixed(5));
        const page = parseTranscription(completion.choices[0]?.message?.content);
        entry.score = doc.kind === 'lab' ? scoreLab(doc, page) : scoreLetter(doc, page);
        entry.unreadable = page.unreadable;
        const s = entry.score;
        console.log(
          doc.kind === 'lab'
            ? `${label}  rows ${s.found}/${s.rows}  value ${s.value}/${s.rows}  unit ${s.unit}/${s.rows}  range ${s.range}/${s.rows}  flag ${s.flag}/${s.rows}  in-range call ${s.placement}/${s.rows}  ${entry.seconds}s  $${entry.usd}  ${entry.signature}`
            : `${label}  facts ${s.found}/${s.facts}  name copied: ${s.leakedName ? 'YES' : 'no'}  ${entry.seconds}s  $${entry.usd}  ${entry.signature}`,
        );
        for (const m of s.mistakes) console.log(`      ${m}`);
      } catch (error) {
        entry.seconds = Number(((performance.now() - started) / 1000).toFixed(1));
        entry.error = `${error?.failure?.code ?? error?.name}: ${error?.message}`;
        console.log(`${label}  FAILED  ${entry.error}`);
      }
      results.push(entry);
    }
  }
}

const labs = results.filter((r) => r.score && r.kind === 'lab');
for (const model of MODELS) {
  for (const variant of VARIANTS) {
    const set = labs.filter((r) => r.model === model && r.variant === variant);
    if (set.length === 0) continue;
    const sum = (k) => set.reduce((a, r) => a + r.score[k], 0);
    console.log(`\n${model} ${variant}: values ${sum('value')}/${sum('rows')}, in-range calls ${sum('placement')}/${sum('rows')}, pages ${set.length}`);
  }
}
const failed = results.filter((r) => r.error).length;
console.log(`\n${results.length} page reads, ${failed} failed.`);

mkdirSync(join(here, 'results'), { recursive: true });
const file = join(here, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(results, null, 2));
console.log('saved', file);

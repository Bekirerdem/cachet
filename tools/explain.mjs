// Tries the explanation step on the fictional samples (as if the person had confirmed
// every value) and runs the no-model check on each reply.
//
//   node --env-file=../.env explain.mjs                       (every sample, Turkish)
//   ONLY=de-lab,de-letter LANGS=tr,en node --env-file=../.env explain.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InferenceClient } from '@nearai/inference-sdk/node';
import { DOCS } from '../samples/docs.mjs';
import { checkExplanation, explainInput, explainRequest, parseExplanation } from '../core/explain.mjs';
import { detectDecimalStyle, placeInRange } from '../core/ranges.mjs';
import { createSession } from '../core/session.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const apiKey = process.env.NEARAI_API_KEY;
if (!apiKey) {
  console.error('Set NEARAI_API_KEY first. Nothing was sent.');
  process.exit(2);
}
const MODELS = (process.env.MODELS ?? 'Qwen/Qwen3.8-27B').split(',');
const LANGS = (process.env.LANGS ?? 'tr').split(',');
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

function pageOf(doc) {
  if (doc.kind === 'lab') {
    const rows = doc.sections.flatMap(([, rs]) => rs).map(([name, value, unit, range, flag]) => ({ name, value, unit, range, flag, readable: true }));
    return { document_kind: 'lab_results', language: doc.lang, rows, text: '', unreadable: [] };
  }
  return { document_kind: 'letter', language: doc.lang, rows: [], text: doc.paragraphs.map(([h, p]) => `${h}\n${p}`).join('\n\n'), unreadable: [] };
}

const results = [];
for (const model of MODELS) {
  const session = createSession(() => new InferenceClient({ apiKey, baseUrl: 'https://cloud-api.near.ai/v1', e2ee: true }));
  for (const doc of DOCS) {
    if (ONLY && !ONLY.includes(doc.id)) continue;
    const page = pageOf(doc);
    const style = detectDecimalStyle(page.rows.map((r) => r.value));
    const placements = page.rows.map((r) => placeInRange(r.value, r.range, style));
    for (const targetLanguage of LANGS) {
      const input = explainInput({ page, placements, targetLanguage });
      const entry = { model, doc: doc.id, targetLanguage };
      const started = performance.now();
      try {
        const { completion, verified, attempts } = await session.send(explainRequest({ model, input }));
        entry.seconds = Number(((performance.now() - started) / 1000).toFixed(1));
        entry.attempts = attempts;
        entry.signature = verified.signatureKind + (attempts > 1 ? ` (attempt ${attempts})` : '');
        entry.explanation = parseExplanation(completion.choices[0]?.message?.content);
        entry.problems = checkExplanation(entry.explanation, input);
        console.log(`${model}  ${doc.id} -> ${targetLanguage}  ${entry.seconds}s  ${entry.signature}  check: ${entry.problems.length === 0 ? 'passed' : `${entry.problems.length} problem(s)`}`);
        for (const p of entry.problems) console.log(`      ${p}`);
      } catch (error) {
        entry.seconds = Number(((performance.now() - started) / 1000).toFixed(1));
        entry.error = `${error?.failure?.code ?? error?.name}: ${error?.message}`;
        console.log(`${model}  ${doc.id} -> ${targetLanguage}  FAILED  ${entry.error}`);
      }
      results.push(entry);
    }
  }
}

mkdirSync(join(here, 'results'), { recursive: true });
const out = join(here, 'results', `explain-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log('saved', out);

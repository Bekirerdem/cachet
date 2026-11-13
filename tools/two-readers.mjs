// Two models read each page on their own; code compares what they brought back.
// Prints, per page, how many lines the two readers did not read the same.
//
//   node --env-file=../.env two-readers.mjs            (fictional samples + local hard pages)
//   ONLY=tr-lab,es-rx node --env-file=../.env two-readers.mjs
//
// The fictional samples should come out with no disagreement. The handwritten and cropped
// pages in testdocs/pages (local only) are where the readers are expected to part.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InferenceClient } from '@nearai/inference-sdk/node';
import { compareLines, compareRows, disagreements } from '../core/compare.mjs';
import { checkPlan, parsePlan, planRequest } from '../core/plan.mjs';
import { tidyRow } from '../core/ranges.mjs';
import { parseTranscription, transcribeRequest } from '../core/reading.mjs';
import { createSession } from '../core/session.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const apiKey = process.env.NEARAI_API_KEY;
if (!apiKey) {
  console.error('Set NEARAI_API_KEY first. Nothing was sent.');
  process.exit(2);
}
const FIRST = 'Qwen/Qwen3.8-27B';
const SECOND = 'z-ai/glm-5.3-flash';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

const pages = [];
for (const doc of ['tr-lab', 'de-lab', 'en-lab', 'es-lab', 'ja-lab', 'de-letter', 'tr-letter']) for (const look of ['clean', 'photo']) pages.push({ label: `${doc}.${look}`, file: join(here, '..', 'samples', 'out', `${doc}.${look}.png`) });
for (const name of (process.env.HARD ?? 'es-rx-03.p1,fr-rx-photo-01.p1,tr-letter-01.p1,tr-lab-photo-01.p1,de-letter-01.p2,en-letter-dc-02.p2').split(',')) {
  const file = join(here, '..', 'testdocs', 'pages', `${name}.jpg`);
  if (existsSync(file)) pages.push({ label: name, file, local: true });
}

const newSession = () => createSession(() => new InferenceClient({ apiKey, baseUrl: 'https://cloud-api.near.ai/v1', e2ee: true }));
const sessions = { [FIRST]: newSession(), [SECOND]: newSession() };

async function read(model, imageDataUrl) {
  const { parsed: page } = await sessions[model].send(transcribeRequest({ model, imageDataUrl }), { parse: parseTranscription });
  page.rows = page.rows.map(tidyRow);
  page.lab = page.rows.length >= 3 || (page.rows.length > 0 && page.text.trim().length < 200);
  if (page.lab || page.text.trim().length < 20) return { page, plan: null };
  const { parsed } = await sessions[model].send(planRequest({ model, text: page.text }), { parse: parsePlan });
  const rejected = new Set(checkPlan(parsed, page.text).map((p) => p.split(':')[0]));
  const plan = {};
  for (const kind of ['medicines', 'follow_ups', 'cautions']) plan[kind] = parsed[kind].filter((_, i) => !rejected.has(`${kind} ${i}`));
  return { page, plan };
}

const results = [];
let lines = 0;
let apart = 0;
for (const { label, file, local } of pages) {
  if (ONLY && !ONLY.some((o) => label.startsWith(o))) continue;
  const mime = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const imageDataUrl = `data:${mime};base64,${readFileSync(file).toString('base64')}`;
  const entry = { label };
  const started = performance.now();
  try {
    const [a, b] = await Promise.all([read(FIRST, imageDataUrl), read(SECOND, imageDataUrl)]);
    entry.seconds = Number(((performance.now() - started) / 1000).toFixed(1));
    let result;
    let count;
    if (a.page.lab) {
      result = compareRows(a.page.rows, b.page.rows);
      count = a.page.rows.length;
    } else {
      const mine = a.plan ?? { medicines: [], follow_ups: [], cautions: [] };
      result = compareLines(mine, b.page.text, b.plan ?? undefined);
      count = mine.medicines.length + mine.follow_ups.length + mine.cautions.length;
    }
    const n = disagreements(result);
    Object.assign(entry, { kind: a.page.lab ? 'lab' : 'lines', lines: count, disagree: n, result, first: a, second: b });
    if (!local) {
      lines += count;
      apart += n;
    }
    console.log(`\n${label}  ${entry.kind}  lines ${count}  not read the same ${n}  unreadable parts: first ${a.page.unreadable.length}, second ${b.page.unreadable.length}  ${entry.seconds}s`);
    if (a.page.lab) {
      result.rows.forEach((r, i) => {
        if (r.status === 'differ') console.log(`   row "${a.page.rows[i].name}": ${r.fields.map((f) => `${f} "${a.page.rows[i][f]}" / "${r.other[f]}"`).join(', ')}`);
        if (r.status === 'missing') console.log(`   row "${a.page.rows[i].name}": the second reader has no such row`);
      });
      for (const r of result.extra) console.log(`   only the second reader: "${r.name}" ${r.value} ${r.unit}`);
    } else {
      for (const kind of ['medicines', 'follow_ups', 'cautions']) {
        result.lines[kind].forEach((l, i) => {
          if (l.status === 'differ') console.log(`   ${kind}: "${a.plan[kind][i].source.slice(0, 90)}"  /  "${String(l.other.line).slice(0, 90)}"`);
        });
        for (const x of result.extra[kind]) console.log(`   only the second reader, ${kind}: "${x.source.slice(0, 110)}"`);
      }
    }
  } catch (error) {
    entry.error = `${error?.failure?.code ?? error?.name}: ${error?.message}`;
    console.log(`\n${label}  FAILED  ${entry.error}`);
  }
  results.push(entry);
}
console.log(`\nFictional samples: ${lines} lines, ${apart} not read the same by the two readers.`);
mkdirSync(join(here, 'results'), { recursive: true });
const out = join(here, 'results', `two-readers-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log('saved', out);

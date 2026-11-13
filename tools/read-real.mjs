// Sends real-world test pages (testdocs/pages, kept out of the repo) through the same
// encrypted path and saves what the model copied, for checking by eye.
//
//   node --env-file=../.env read-real.mjs                 (default model, every page)
//   ONLY=tr-lab,es-lab node --env-file=../.env read-real.mjs
//
// There is no ground truth for these pages. The one automatic signal: where the page
// prints its own high/low mark, does the range check in code agree with it?
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InferenceClient } from '@nearai/inference-sdk/node';
import { parseTranscription, transcribeRequest } from '../core/reading.mjs';
import { detectDecimalStyle, placeInRange, tidyRow } from '../core/ranges.mjs';
import { createSession } from '../core/session.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const apiKey = process.env.NEARAI_API_KEY;
if (!apiKey) {
  console.error('Set NEARAI_API_KEY first. Nothing was sent.');
  process.exit(2);
}
const pagesDir = join(here, '..', 'testdocs', 'pages');
if (!existsSync(pagesDir)) {
  console.error('No testdocs/pages folder. Real test pages are local only and not part of the repo.');
  process.exit(2);
}
const MODELS = (process.env.MODELS ?? 'Qwen/Qwen3.8-27B').split(',');
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const PRICE = { 'Qwen/Qwen3.8-27B': [0.04, 1.35], 'z-ai/glm-5.3-flash': [0.08, 0.5] }; // USD per million tokens, in / out

const pages = readdirSync(pagesDir)
  .filter((f) => /\.(jpg|png)$/i.test(f))
  .filter((f) => !ONLY || ONLY.some((o) => f.startsWith(o)))
  .sort();

const results = [];
for (const model of MODELS) {
  const session = createSession(() => new InferenceClient({ apiKey, baseUrl: 'https://cloud-api.near.ai/v1', e2ee: true }));
  for (const file of pages) {
    const mime = file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    const imageDataUrl = `data:${mime};base64,${readFileSync(join(pagesDir, file)).toString('base64')}`;
    const entry = { model, file };
    const started = performance.now();
    try {
      const { completion, verified, attempts } = await session.send(transcribeRequest({ model, imageDataUrl }));
      entry.seconds = Number(((performance.now() - started) / 1000).toFixed(1));
      entry.attempts = attempts;
      entry.signature = verified.signatureKind + (attempts > 1 ? ` (attempt ${attempts})` : '');
      const usage = completion.usage ?? {};
      const [pin, pout] = PRICE[model] ?? [0, 0];
      entry.usd = Number((((usage.prompt_tokens ?? 0) * pin + (usage.completion_tokens ?? 0) * pout) / 1e6).toFixed(5));
      const page = parseTranscription(completion.choices[0]?.message?.content);
      page.rows = page.rows.map(tidyRow);
      entry.page = page;

      const style = detectDecimalStyle(page.rows.map((r) => r.value));
      const placed = page.rows.map((r) => placeInRange(r.value, r.range, style));
      const decided = placed.filter((p) => p !== 'unknown').length;
      // Rows where the page itself prints a mark: the code should call them out of range, and only them.
      let agree = 0;
      let disagree = 0;
      page.rows.forEach((r, i) => {
        if (placed[i] === 'unknown') return;
        const marked = String(r.flag ?? '').trim() !== '';
        if (marked === (placed[i] !== 'in')) agree += 1;
        else disagree += 1;
      });
      entry.check = { rows: page.rows.length, decided, agree, disagree };
      console.log(
        `${file}  ${page.document_kind}/${page.language}  rows ${page.rows.length}  range decided ${decided}  agrees with printed mark ${agree}  disagrees ${disagree}  unreadable ${page.unreadable.length}  text ${page.text.length} chars  ${entry.seconds}s  $${entry.usd}  ${entry.signature}`,
      );
    } catch (error) {
      entry.seconds = Number(((performance.now() - started) / 1000).toFixed(1));
      entry.error = `${error?.failure?.code ?? error?.name}: ${error?.message}`;
      console.log(`${file}  FAILED  ${entry.error}`);
    }
    results.push(entry);
  }
}

const failed = results.filter((r) => r.error).length;
const usd = results.reduce((a, r) => a + (r.usd ?? 0), 0);
console.log(`\n${results.length} page reads, ${failed} failed, $${usd.toFixed(4)} spent.`);
mkdirSync(join(here, 'results'), { recursive: true });
const out = join(here, 'results', `real-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log('saved', out);

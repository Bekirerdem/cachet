// Reads one fictional page through the relay, the way the app will: this side holds
// no API key, verifies the hardware itself and encrypts before anything leaves.
//
//   RELAY=http://127.0.0.1:8799 node via-relay.mjs            (start the relay first)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InferenceClient } from '@nearai/inference-sdk/node';
import { parseTranscription, transcribeRequest } from '../core/reading.mjs';
import { receiptOf } from '../core/receipt.mjs';
import { createSession } from '../core/session.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const relay = process.env.RELAY ?? 'http://127.0.0.1:8799';
const model = process.env.MODEL ?? 'Qwen/Qwen3.8-27B';

// A plain request must be refused by the relay.
const plain = await fetch(`${relay}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: 'user', content: 'readable text' }] }),
});
console.log('plain request ->', plain.status, (await plain.json()).error?.message);

const session = createSession(
  () =>
    new InferenceClient({
      apiKey: 'held-by-the-relay',
      headers: { Authorization: 'Bearer held-by-the-relay' },
      baseUrl: `${relay}/v1`,
      e2ee: true,
      // The certificate seen here is the relay's, so the gateway's TLS pin cannot be compared.
      gatewayVerification: { includeSpkiFingerprint: false },
    }),
);
const png = readFileSync(join(here, '..', 'samples', 'out', 'de-lab.photo.png'));
const started = performance.now();
const { completion, verified, attempts } = await session.send(transcribeRequest({ model, imageDataUrl: `data:image/png;base64,${png.toString('base64')}` }));
const page = parseTranscription(completion.choices[0]?.message?.content);
console.log(`encrypted request -> ${page.rows.length} rows, ${page.document_kind}/${page.language}, ${((performance.now() - started) / 1000).toFixed(1)}s, signature ${verified.signatureKind}, attempts ${attempts}`);
console.log('receipt', JSON.stringify(receiptOf(verified)).slice(0, 160) + '…');

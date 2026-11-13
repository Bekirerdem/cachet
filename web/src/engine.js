// Everything that talks to the model. The page is encrypted here, on the device, to a key
// the hardware evidence vouches for; the relay behind /v1 only adds the API key.
import { InferenceClient, createGpuEvidenceVerifier } from '@nearai/inference-sdk';
import { createSession } from '../../core/session.mjs';
import { parseTranscription, transcribeRequest } from '../../core/reading.mjs';
import { checkPlan, checkPlain, parsePlain, parsePlan, plainInput, plainRequest, planRequest } from '../../core/plan.mjs';
import { LANGUAGES, checkExplanation, explainInput, explainRequest, parseExplanation } from '../../core/explain.mjs';
import { receiptOf } from '../../core/receipt.mjs';

export const MODEL = 'Qwen/Qwen3.8-27B';
export { LANGUAGES };

// What leaves the device is observed where it leaves: the proof screen shows the size of
// each encrypted request and the first characters the relay could see.
const wire = { last: null };
const plainFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith('/v1/chat/completions')) {
    const request = input instanceof Request ? input.clone() : new Request(input, init);
    const body = await request.text();
    let seen = '';
    try {
      const content = JSON.parse(body).messages?.at(-1)?.content;
      seen = typeof content === 'string' ? content.slice(0, 72) : '';
    } catch {
      seen = '';
    }
    wire.last = { encrypted: request.headers.get('x-encrypt-all-fields') === 'true', bytes: body.length, seen };
    wire.onSend?.(wire.last);
  }
  return plainFetch(input, init);
};

function createClient() {
  return new InferenceClient({
    // The relay holds the real key and replaces this header.
    apiKey: 'held-by-the-relay',
    baseUrl: `${location.origin}/v1`,
    e2ee: true,
    // NVIDIA's attestation service refuses browser requests; the relay passes this one through unread.
    modelVerification: { verifiers: { gpuEvidence: createGpuEvidenceVerifier({ nrasUrl: `${location.origin}/attestation/nvidia` }) } },
  });
}

const seconds = (since) => Number(((performance.now() - since) / 1000).toFixed(1));

export function createEngine() {
  const session = createSession(createClient);
  const exchanges = []; // one entry per signed answer: { step, receipt, attestation, wire, seconds }

  async function exchange(step, body, parse, onSend, page = null) {
    const started = performance.now();
    wire.onSend = onSend;
    const { verified, parsed, attempts } = await session.send(body, { parse });
    const attestation = verified.attestation;
    exchanges.push({
      step,
      page,
      receipt: receiptOf(verified),
      wire: wire.last,
      seconds: seconds(started),
      attempts,
      hardware: { tcbStatus: attestation.tcbStatus, gpuEvidence: attestation.gpuEvidence, advisoryIds: [...attestation.advisoryIds] },
    });
    return parsed;
  }

  return {
    exchanges,
    /** Hardware evidence for the model, checked in this browser. Nothing has been sent yet. */
    async verifyHardware() {
      const started = performance.now();
      await session.verify(MODEL);
      return seconds(started);
    },
    /** Step 1: the model copies one page. */
    read(imageDataUrl, onSend, page) {
      return exchange('read', transcribeRequest({ model: MODEL, imageDataUrl }), parseTranscription, onSend, page);
    },
    /** Step 2 for letters: the instructions on one page, each with its line. Entries the check rejects are dropped. */
    async plan(text, page) {
      const plan = await exchange('plan', planRequest({ model: MODEL, text }), parsePlan, undefined, page);
      const rejected = new Set(checkPlan(plan, text).map((p) => p.split(':')[0]));
      const kept = {};
      for (const kind of ['medicines', 'follow_ups', 'cautions']) kept[kind] = plan[kind].filter((_, i) => !rejected.has(`${kind} ${i}`));
      return { plan: kept, rejected: rejected.size };
    },
    /** Step 3 for letters: the confirmed plan in the reader's language. Null when the check rejects it twice. */
    async plain(plan, lang) {
      const input = plainInput({ plan, language: LANGUAGES[lang] ?? 'English' });
      input.open_points = []; // questions about what the paper leaves open are written by code
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const told = await exchange('plain', plainRequest({ model: MODEL, input }), parsePlain);
        if (checkPlain(told, plan).length === 0) return told;
      }
      return null;
    },
    /** Step 2 for lab pages: plain explanation of confirmed rows. Null when the check rejects it twice. */
    async explain(page, placements, lang) {
      const input = explainInput({ page, placements, targetLanguage: lang });
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const explanation = await exchange('explain', explainRequest({ model: MODEL, input }), parseExplanation);
        if (checkExplanation(explanation, input).length === 0) return explanation;
      }
      return null;
    },
  };
}

/** Asks the relay to write one receipt to the chain. Resolves to { hash } or { error }. */
export async function recordReceipt(receipt) {
  try {
    const response = await plainFetch('/receipt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(receipt) });
    const data = await response.json();
    if (!response.ok) return { error: data?.error?.message ?? `HTTP ${response.status}` };
    return { hash: data.hash, already: data.already === true };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

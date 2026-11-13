// The relay. It exists for one reason: the NEAR AI API key cannot live in a browser.
// It adds that key to requests the browser has already encrypted to the model's
// attested key, and passes the answer back. It cannot read what it forwards, and it
// refuses any chat request that is not encrypted, so it cannot be used to send
// readable content by mistake. It also serves the app's own files (same origin) and
// writes reading receipts to the chain, because a browser without a wallet cannot.

import { callFunction, view } from './near.js';

const UPSTREAM = 'https://cloud-api.near.ai';
const NVIDIA_ATTEST = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
const INTEL_PCS = 'https://api.trustedservices.intel.com';
const MODELS = new Set(['Qwen/Qwen3.8-27B', 'z-ai/glm-5.3-flash']);
const MAX_BODY_BYTES = 9 * 1024 * 1024;
const MAX_TOKENS = 8000;

// What must be present for the body to be end-to-end encrypted, and what else the
// model service needs passed through unchanged.
const REQUIRED_ENCRYPTION_HEADERS = ['x-client-pub-key', 'x-model-pub-key', 'x-encrypt-all-fields'];
const FORWARDED_HEADERS = ['content-type', 'accept', 'x-client-pub-key', 'x-model-pub-key', 'x-encrypt-all-fields', 'x-encryption-version', 'x-signing-algo', 'x-no-aliasing'];

const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const json = (status, error) => reply(status, { error: { message: error } });

function upstreamHeaders(request, env, withKey) {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (withKey) headers.set('authorization', `Bearer ${env.NEARAI_API_KEY}`);
  return headers;
}

async function limited(limiter, request) {
  if (!limiter) return false; // not configured in local development
  const { success } = await limiter.limit({ key: request.headers.get('cf-connecting-ip') ?? 'unknown' });
  return !success;
}

// A public demo runs on a fixed credit. This stops forwarding once the day's allowance of
// model calls is used, so one visitor cannot spend what the others need. The count holds
// no address and nothing about the request.
async function overDailyAllowance(env) {
  if (!env.BUDGET) return false; // not configured in local development
  const key = `chat:${new Date().toISOString().slice(0, 10)}`;
  const used = Number(await env.BUDGET.get(key)) || 0;
  if (used >= Number(env.DAILY_CHAT_LIMIT ?? 800)) return true;
  await env.BUDGET.put(key, String(used + 1), { expirationTtl: 3 * 24 * 60 * 60 });
  return false;
}

async function chat(request, env) {
  const missing = REQUIRED_ENCRYPTION_HEADERS.filter((h) => !request.headers.get(h));
  if (missing.length > 0 || request.headers.get('x-encrypt-all-fields') !== 'true') {
    return json(400, 'This relay only forwards requests that are encrypted to the model on the device.');
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) return json(413, 'The page image is too large.');
  let outline;
  try {
    outline = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json(400, 'The request body is not JSON.');
  }
  if (!MODELS.has(outline.model)) return json(400, 'This relay does not serve that model.');
  if (typeof outline.max_tokens !== 'number' || outline.max_tokens > MAX_TOKENS) return json(400, 'max_tokens is missing or too high.');
  if (outline.stream) return json(400, 'Streaming is not used by this app.');
  if (await limited(env.CHAT_LIMIT, request)) return json(429, 'Too many readings from this network in a short time. Try again in a minute.');
  if (await overDailyAllowance(env)) return json(429, "Today's free readings on this demo are used up. They come back at midnight UTC.");

  // The exact bytes go on unchanged: the model signs a hash of them.
  return fetch(`${UPSTREAM}/v1/chat/completions`, { method: 'POST', headers: upstreamHeaders(request, env, true), body });
}

const HEX = (length) => new RegExp(`^[0-9a-f]{${length}}$`);
const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (byte) => parseInt(byte, 16));
let chainQueue = Promise.resolve(); // one transaction at a time per isolate, so nonces do not collide

// Writes one reading receipt to the contract. The contract checks the model's signature
// again by itself; checking it here first only avoids paying for a call that would fail.
async function receipt(request, env) {
  if (!env.NEAR_RECEIPT_KEY || !env.NEAR_ACCOUNT_ID || !env.RECEIPT_CONTRACT || !env.NEAR_RPC) return json(503, 'Chain records are not set up on this relay.');
  if (await limited(env.RECEIPT_LIMIT, request)) return json(429, 'Too many records from this network in a short time.');
  let r;
  try {
    r = await request.json();
  } catch {
    return json(400, 'The receipt is not JSON.');
  }
  const signers = String(env.ENCLAVE_SIGNERS ?? '').split(',').filter(Boolean);
  const shaped = MODELS.has(r?.model) && HEX(64).test(r.request_hash) && HEX(64).test(r.response_hash) && HEX(128).test(r.signature) && HEX(64).test(r.signer);
  if (!shaped) return json(400, 'The receipt does not have the expected fields.');
  if (!signers.includes(r.signer)) return json(400, 'The receipt is not signed by a model key this relay accepts.');
  const key = await crypto.subtle.importKey('raw', fromHex(r.signer), { name: 'Ed25519' }, false, ['verify']);
  const signed = new TextEncoder().encode(`${r.model}:${r.request_hash}:${r.response_hash}`);
  if (!(await crypto.subtle.verify('Ed25519', key, fromHex(r.signature), signed))) return json(400, 'The signature on the receipt is not valid.');

  const args = { model: r.model, request_hash: r.request_hash, response_hash: r.response_hash, signature: r.signature, signer: r.signer };
  const chain = { rpcUrl: env.NEAR_RPC, contractId: env.RECEIPT_CONTRACT };
  const run = chainQueue.then(async () => {
    if (await view({ ...chain, method: 'is_recorded', args: { response_hash: r.response_hash } })) return { already: true };
    const call = () => callFunction({ ...chain, accountId: env.NEAR_ACCOUNT_ID, secretKey: env.NEAR_RECEIPT_KEY, method: 'record', args });
    try {
      return await call();
    } catch (error) {
      // A nonce the chain has already seen, or a block hash that expired while waiting in the queue: once more with fresh values.
      if (!/nonce|expired/i.test(String(error?.message))) throw error;
      return call();
    }
  });
  chainQueue = run.catch(() => {});
  try {
    const outcome = await run;
    if (outcome.already) return reply(200, { already: true, hash: null, contract: env.RECEIPT_CONTRACT });
    if (!outcome.ok) return json(502, `The chain refused the record: ${outcome.error}`);
    return reply(200, { hash: outcome.hash, contract: env.RECEIPT_CONTRACT });
  } catch (error) {
    return json(502, `The record could not be sent: ${String(error?.message ?? error).slice(0, 300)}`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname, search } = url;

    if (request.method === 'POST' && pathname === '/receipt') return receipt(request, env);

    if (pathname.startsWith('/v1/') && !env.NEARAI_API_KEY) return json(500, 'The relay has no API key configured.');
    if (request.method === 'POST' && pathname === '/v1/chat/completions') return chat(request, env);

    if (await limited(env.LOOKUP_LIMIT, request)) return json(429, 'Too many requests. Try again in a minute.');

    if (request.method === 'GET' && (pathname === '/v1/attestation/report' || pathname.startsWith('/v1/model/') || pathname.startsWith('/v1/signature/'))) {
      // pathname is forwarded as received so a URL-encoded model ID stays encoded.
      return fetch(`${UPSTREAM}${pathname}${search}`, { headers: upstreamHeaders(request, env, true) });
    }
    if (request.method === 'POST' && pathname === '/attestation/nvidia') {
      // NVIDIA's GPU attestation service does not allow browser requests; this passes one through untouched.
      const body = await request.arrayBuffer();
      if (body.byteLength > 2 * 1024 * 1024) return json(413, 'Attestation evidence is too large.');
      return fetch(NVIDIA_ATTEST, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body });
    }
    if (request.method === 'GET' && /^\/attestation\/intel\/(sgx|tdx)\/certification\/v4\//.test(pathname)) {
      // Intel's certificate service does not allow browser requests either. Public data, passed through with its headers.
      return fetch(`${INTEL_PCS}${pathname.slice('/attestation/intel'.length)}${search}`, { headers: { accept: request.headers.get('accept') ?? '*/*' } });
    }
    return json(404, 'Not found.');
  },
};

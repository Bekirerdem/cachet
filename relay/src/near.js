// The smallest NEAR client that can do one thing: sign and send a function call.
// No dependencies; runs in a Worker. Layouts follow the NEAR transaction format (borsh).

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(text) {
  const bytes = [0];
  for (const char of text) {
    let carry = ALPHABET.indexOf(char);
    if (carry < 0) throw new Error('not base58');
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 255;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 255);
      carry >>= 8;
    }
  }
  for (const char of text) {
    if (char !== '1') break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

export function base58Encode(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += '1';
  }
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i]];
  return out;
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const u32 = (n) => new Uint8Array(new Uint32Array([n]).buffer);
const uint = (value, bytes) => {
  const out = new Uint8Array(bytes);
  let rest = BigInt(value);
  for (let i = 0; i < bytes; i += 1) {
    out[i] = Number(rest & 255n);
    rest >>= 8n;
  }
  return out;
};
const text = (s) => {
  const utf8 = new TextEncoder().encode(s);
  return concat(u32(utf8.length), utf8);
};
const base64 = (bytes) => btoa(String.fromCharCode(...bytes));
const base64url = (bytes) => base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function rpc(url, method, params) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'relay', method, params }) });
  const data = await response.json();
  if (data.error) {
    const detail = data.error.data ?? data.error.cause ?? data.error.message ?? 'RPC error';
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300));
  }
  return data.result;
}

let lastNonce = 0n; // the newest nonce this isolate has used; the chain's "final" view lags a few seconds behind

/**
 * Calls one contract method and waits for the result.
 * `secretKey` is the usual "ed25519:<base58>" form (32-byte seed followed by the public key).
 * Resolves to { hash, ok, error } and never to a guess: `ok` is true only when the chain says so.
 */
export async function callFunction({ rpcUrl, accountId, secretKey, contractId, method, args, gas = 30_000_000_000_000n }) {
  const raw = base58Decode(secretKey.replace(/^ed25519:/, ''));
  const seed = raw.slice(0, 32);
  const publicKey = raw.slice(32, 64);
  const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', d: base64url(seed), x: base64url(publicKey) }, { name: 'Ed25519' }, false, ['sign']);

  const access = await rpc(rpcUrl, 'query', { request_type: 'view_access_key', finality: 'optimistic', account_id: accountId, public_key: `ed25519:${base58Encode(publicKey)}` });
  const onChain = BigInt(access.nonce);
  lastNonce = (onChain > lastNonce ? onChain : lastNonce) + 1n;
  const argBytes = new TextEncoder().encode(JSON.stringify(args));
  const transaction = concat(
    text(accountId),
    Uint8Array.of(0), // key type: ed25519
    publicKey,
    uint(lastNonce, 8),
    text(contractId),
    base58Decode(access.block_hash),
    u32(1), // one action
    Uint8Array.of(2), // FunctionCall
    text(method),
    u32(argBytes.length),
    argBytes,
    uint(gas, 8),
    uint(0n, 16), // no deposit
  );
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', transaction));
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, hash));
  const signed = concat(transaction, Uint8Array.of(0), signature);

  const outcome = await rpc(rpcUrl, 'broadcast_tx_commit', [base64(signed)]);
  const failure = outcome.status?.Failure;
  return { hash: outcome.transaction?.hash ?? base58Encode(hash), ok: !failure, error: failure ? JSON.stringify(failure).slice(0, 400) : null };
}

/** Reads a contract view method. */
export async function view({ rpcUrl, contractId, method, args }) {
  const result = await rpc(rpcUrl, 'query', { request_type: 'call_function', finality: 'final', account_id: contractId, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result)));
}

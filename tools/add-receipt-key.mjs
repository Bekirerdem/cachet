// Gives the relay a key that can do exactly one thing: call `record` on the receipts
// contract, up to a small allowance. The relay never holds a key that can move funds.
//
//   OWNER=name.testnet node add-receipt-key.mjs
//
// The new secret key is written next to the other testnet credentials and never printed.
// Put it into the relay with:  wrangler secret put NEAR_RECEIPT_KEY
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, nearToYocto } from 'near-api-js';

const ownerId = process.env.OWNER;
if (!ownerId?.endsWith('.testnet')) throw new Error('Set OWNER to a testnet account. This script never touches mainnet.');
const contractId = `${process.env.PREFIX ?? 'receipts'}.${ownerId}`;
const dir = join(homedir(), '.near-credentials', 'testnet');
const out = join(dir, `${ownerId}.receipt-key.json`);
if (existsSync(out)) throw new Error(`A receipt key already exists at ${out}. Delete it first if you want a new one.`);

const provider = new JsonRpcProvider({ url: process.env.RPC ?? 'https://test.rpc.fastnear.com' });
const owner = new Account(ownerId, provider, JSON.parse(readFileSync(join(dir, `${ownerId}.json`), 'utf8')).private_key);
const pair = KeyPair.fromRandom('ed25519');
await owner.addFunctionCallAccessKey({
  publicKey: pair.getPublicKey(),
  contractId,
  methodNames: ['record'],
  allowance: nearToYocto(process.env.ALLOWANCE ?? '3'),
});
writeFileSync(out, JSON.stringify({ account_id: ownerId, public_key: pair.getPublicKey().toString(), private_key: pair.toString() }), { mode: 0o600 });
console.log('added a function-call key for', `${contractId}.record`, 'on', ownerId);
console.log('public key', pair.getPublicKey().toString());
console.log('secret saved to', out);

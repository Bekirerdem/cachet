// Records one fresh enclave-signed receipt on the testnet contract and prints what
// that transaction cost. Shows the chain footprint of a single reading.
//
//   OWNER=name.testnet node --env-file=../.env record-cost.mjs
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { InferenceClient } from '@nearai/inference-sdk/node';
import { Account, JsonRpcProvider, teraToGas } from 'near-api-js';
import { receiptOf } from '../core/receipt.mjs';
import { createSession } from '../core/session.mjs';

const ownerId = process.env.OWNER;
if (!ownerId?.endsWith('.testnet')) throw new Error('Set OWNER to a testnet account. This script never touches mainnet.');
const contractId = `${process.env.PREFIX ?? 'receipts'}.${ownerId}`;
const key = JSON.parse(readFileSync(join(homedir(), '.near-credentials', 'testnet', `${ownerId}.json`), 'utf8')).private_key;
const provider = new JsonRpcProvider({ url: process.env.RPC ?? 'https://test.rpc.fastnear.com' });
const sender = new Account(ownerId, provider, key);

const model = process.env.MODEL ?? 'Qwen/Qwen3.8-27B';
const session = createSession(() => new InferenceClient({ apiKey: process.env.NEARAI_API_KEY, baseUrl: 'https://cloud-api.near.ai/v1', e2ee: true }));
const { verified } = await session.send({
  model,
  temperature: 0,
  max_tokens: 20,
  stream: false,
  chat_template_kwargs: { enable_thinking: false },
  messages: [{ role: 'user', content: `Reply with the word ready. (${Date.now()})` }],
});
const receipt = receiptOf(verified);

const outcome = await sender.callFunctionRaw({ contractId, methodName: 'record', args: receipt, gas: teraToGas('30') });
const all = [outcome.transaction_outcome, ...outcome.receipts_outcome];
const gas = all.reduce((sum, o) => sum + BigInt(o.outcome.gas_burnt), 0n);
const yocto = all.reduce((sum, o) => sum + BigInt(o.outcome.tokens_burnt), 0n);
console.log('transaction', outcome.transaction.hash);
console.log('gas burnt', (Number(gas) / 1e12).toFixed(2), 'Tgas');
console.log('fee', (Number(yocto) / 1e24).toFixed(6), 'NEAR');
console.log('stats', JSON.stringify(await provider.callFunction({ contractId, method: 'stats', args: {} })));

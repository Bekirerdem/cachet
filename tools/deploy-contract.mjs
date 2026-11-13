// Deploys contract/ to NEAR testnet as a sub-account of the owner, registers the
// enclave signing keys and records one real receipt as a smoke test.
//
//   OWNER=name.testnet SIGNERS=<hex>,<hex> node deploy-contract.mjs
//
// Keys are read from and written to ~/.near-credentials/testnet (never printed).
// Build first:  cd ../contract && cargo build --target wasm32-unknown-unknown --release
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, JsonRpcProvider, KeyPair, nearToYocto, teraToGas } from 'near-api-js';

const here = dirname(fileURLToPath(import.meta.url));
const ownerId = process.env.OWNER;
if (!ownerId?.endsWith('.testnet')) throw new Error('Set OWNER to a testnet account. This script never touches mainnet.');
const contractId = `${process.env.PREFIX ?? 'receipts'}.${ownerId}`;
const signers = (process.env.SIGNERS ?? '').split(',').filter(Boolean);
const keyFile = (id) => join(homedir(), '.near-credentials', 'testnet', `${id}.json`);
const keyOf = (id) => JSON.parse(readFileSync(keyFile(id), 'utf8')).private_key;

const provider = new JsonRpcProvider({ url: process.env.RPC ?? 'https://test.rpc.fastnear.com' });
const owner = new Account(ownerId, provider, keyOf(ownerId));
const view = (method, args = {}) => provider.callFunction({ contractId, method, args });

if (!existsSync(keyFile(contractId))) {
  const pair = KeyPair.fromRandom('ed25519');
  writeFileSync(keyFile(contractId), JSON.stringify({ account_id: contractId, public_key: pair.getPublicKey().toString(), private_key: pair.toString() }), { mode: 0o600 });
  await owner.createSubAccount({ accountOrPrefix: contractId, publicKey: pair.getPublicKey(), nearToTransfer: nearToYocto('4') });
  console.log('created', contractId);
}
const contract = new Account(contractId, provider, keyOf(contractId));

const wasm = readFileSync(join(here, '..', 'contract', 'target', 'wasm32-unknown-unknown', 'release', 'reading_receipts.wasm'));
await contract.deployContract(wasm);
console.log('deployed', wasm.length, 'bytes to', contractId);

let initialised = true;
try {
  await view('signers');
} catch {
  initialised = false;
}
if (!initialised) {
  await contract.callFunction({ contractId, methodName: 'new', args: { owner: ownerId }, gas: teraToGas('30') });
  console.log('initialised, owner', ownerId);
}

const accepted = await view('signers');
for (const signer of signers) {
  if (accepted.includes(signer)) continue;
  await owner.callFunction({ contractId, methodName: 'add_signer', args: { signer }, gas: teraToGas('30') });
  console.log('accepted enclave key', signer.slice(0, 12) + '…');
}

const receipt = JSON.parse(readFileSync(join(here, '..', 'contract', 'tests', 'real-receipt.json'), 'utf8'));
if (!(await view('is_recorded', { response_hash: receipt.response_hash }))) {
  const total = await owner.callFunction({ contractId, methodName: 'record', args: receipt, gas: teraToGas('30') });
  console.log('recorded the test receipt, total now', total);
}
console.log('stats', JSON.stringify(await view('stats')));

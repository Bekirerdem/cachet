// Checks, without any API key, that the models we plan to use really run inside
// attested hardware and expose a key we can encrypt documents to.
//   node verify-tee.mjs
import {
  AttestationClient,
  verifyGatewayAttestation,
  verifyModelAttestation,
} from '@nearai/inference-sdk/node';

const BASE_URL = 'https://cloud-api.near.ai/v1/';
const MODELS = (process.env.MODELS ?? 'Qwen/Qwen3.8-27B,z-ai/glm-5.3-flash').split(',');
const SIGNING_ALGO = 'ed25519';

const client = new AttestationClient({ baseUrl: BASE_URL });
let failed = 0;

async function step(label, fn) {
  const started = performance.now();
  try {
    const detail = await fn();
    const ms = Math.round(performance.now() - started);
    console.log(`PASS  ${label}${detail ? `  (${detail})` : ''}  ${ms} ms`);
  } catch (error) {
    failed += 1;
    const code = error?.failure?.code ?? error?.code ?? error?.name;
    console.log(`FAIL  ${label}  ${code}: ${error?.message}`);
  }
}

await step('Gateway runs in attested hardware', async () => {
  const fetched = await client.fetchGatewayAttestation({ signingAlgo: SIGNING_ALGO });
  const verified = await verifyGatewayAttestation({
    attestation: fetched.attestation,
    clientBinding: fetched.clientBinding,
  });
  return `tls binding: ${verified.tlsBinding.kind}`;
});

for (const model of MODELS) {
  await step(`${model} runs in attested hardware and has an encryption key`, async () => {
    const fetched = await client.fetchModelAttestations({ model, signingAlgo: SIGNING_ALGO });
    if (fetched.attestations.length === 0) throw new Error('no model attestations returned');
    const verified = await Promise.all(
      fetched.attestations.map((attestation) =>
        verifyModelAttestation({ attestation, clientBinding: fetched.clientBinding }),
      ),
    );
    const withKey = verified.find(
      (v) => v.signer.signingAlgo === SIGNING_ALGO && v.signingPublicKey !== undefined,
    );
    if (!withKey) throw new Error('no verified ed25519 key for end-to-end encryption');
    return `${verified.length} report(s), key ${withKey.signingPublicKey.slice(0, 12)}…`;
  });
}

console.log(failed === 0 ? '\nVERIFIED' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);

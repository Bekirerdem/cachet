// A reading receipt: the model's own signature over the hashes of one encrypted
// exchange. It contains no document content, no account and no device identifier,
// and anyone can check it with the model's public signing key. The contract in
// contract/ checks exactly these five fields.

/** Builds the receipt from a verified completion (the result of session.send). */
export function receiptOf(verified) {
  const { signedText, signature, signer } = verified.signature;
  if (verified.signatureKind !== 'provider_tee') throw new Error('the reply was not signed inside the model enclave');
  if (signer.signingAlgo !== 'ed25519') throw new Error(`unsupported signature type: ${signer.signingAlgo}`);
  const hashes = signedText.lastIndexOf(':', signedText.lastIndexOf(':') - 1);
  const [request_hash, response_hash] = signedText.slice(hashes + 1).split(':');
  const receipt = { model: signedText.slice(0, hashes), request_hash, response_hash, signature: strip(signature), signer: strip(signer.signingAddress) };
  if (!/^[0-9a-f]{64}$/.test(request_hash) || !/^[0-9a-f]{64}$/.test(response_hash)) throw new Error('unexpected signed text');
  if (!/^[0-9a-f]{128}$/.test(receipt.signature) || !/^[0-9a-f]{64}$/.test(receipt.signer)) throw new Error('unexpected signature format');
  return receipt;
}

const strip = (hex) => String(hex).toLowerCase().replace(/^0x/, '');

// One verified, encrypted exchange with the model, with the two recoveries the live
// service needs:
//  - "Decryption failed": the model's key changed (its enclave restarted) while this
//    client still held the old one. A new client checks the hardware again, takes the
//    new key and the request is sent once more. Nothing readable left the device.
//  - The reply's signature is sometimes not ready the instant the reply arrives.
// `createClient` builds an InferenceClient (node or browser entry of the SDK).

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (error) => `${error?.failure?.code ?? ''} ${error?.message ?? ''}`;
const isStaleKey = (error) => /decryption failed/i.test(text(error));
const isSignatureNotReady = (error) => /completion signature/i.test(text(error)) && /404|not.?found|unavailable/i.test(text(error));

export function createSession(createClient, { maxAttempts = 3 } = {}) {
  let client = createClient();

  async function verify(id) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await client.verifyResponse(id);
      } catch (error) {
        if (attempt >= 4 || !isSignatureNotReady(error)) throw error;
        await wait(1500 * attempt);
      }
    }
  }

  /**
   * Sends one chat request. Resolves to { completion, verified, attempts, parsed }.
   * `parse` turns the reply text into data and throws when the reply is unusable
   * (cut off, not JSON); the request is then sent again, up to maxAttempts in total.
   */
  async function send(body, { parse } = {}) {
    for (let attempt = 1; ; attempt += 1) {
      let completion;
      try {
        completion = await client.chat.completions.create(body);
      } catch (error) {
        if (attempt >= maxAttempts || !isStaleKey(error)) throw error;
        client = createClient();
        continue;
      }
      let parsed;
      if (parse) {
        try {
          parsed = parse(completion.choices[0]?.message?.content);
        } catch (error) {
          if (attempt >= maxAttempts) throw error;
          continue;
        }
      }
      const verified = await verify(completion.id);
      return { completion, verified, attempts: attempt, parsed };
    }
  }

  /** Checks the hardware evidence for a model before anything is sent. Rejects when a check fails. */
  async function verifyHardware(model) {
    await client.verify(model);
  }

  return { send, verify: verifyHardware };
}

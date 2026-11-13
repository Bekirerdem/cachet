//! Reading receipts.
//!
//! Every answer from a NEAR AI private model is signed inside the model's enclave over
//! `model:sha256(request):sha256(response)`. Both bodies are ciphertext, so the hashes
//! say nothing about the document that was read. This contract checks that signature
//! itself and counts each exchange once. Anyone may submit a receipt; nobody, including
//! the people who run the app, can add a reading the model did not sign.
//!
//! What it does not do: it does not verify the hardware attestation of a signing key.
//! The owner lists the keys taken from attestation reports that were verified off-chain;
//! `signers()` returns them so anyone can compare against the live report.

use near_sdk::store::{IterableMap, LookupSet};
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

#[near(serializers = [json])]
pub struct Stats {
    pub total: u64,
    pub models: Vec<(String, u64)>,
    pub signers: Vec<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    /// Accepted enclave signing keys, 32-byte ed25519 public keys as lowercase hex.
    signers: Vec<String>,
    /// Response hashes already counted.
    seen: LookupSet<[u8; 32]>,
    per_model: IterableMap<String, u64>,
    total: u64,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self { owner, signers: Vec::new(), seen: LookupSet::new(b"s"), per_model: IterableMap::new(b"m"), total: 0 }
    }

    /// Owner only: accept an enclave signing key (64 lowercase hex characters).
    pub fn add_signer(&mut self, signer: String) {
        self.only_owner();
        decode::<32>(&signer);
        if !self.signers.contains(&signer) {
            self.signers.push(signer);
        }
    }

    /// Owner only: stop accepting a key. Readings already counted stay counted.
    pub fn remove_signer(&mut self, signer: String) {
        self.only_owner();
        self.signers.retain(|s| s != &signer);
    }

    /// Counts one reading. Open to anyone; the signature decides. Returns the new total.
    pub fn record(&mut self, model: String, request_hash: String, response_hash: String, signature: String, signer: String) -> u64 {
        require!(!model.is_empty() && model.len() <= 96, "model name must be 1 to 96 characters");
        require!(self.signers.contains(&signer), "signer is not an accepted enclave key");
        let public_key = decode::<32>(&signer);
        let signature = decode::<64>(&signature);
        decode::<32>(&request_hash);
        let response = decode::<32>(&response_hash);

        let message = format!("{model}:{request_hash}:{response_hash}");
        require!(env::ed25519_verify(&signature, message.as_bytes(), &public_key), "signature does not match this reading");
        require!(self.seen.insert(response), "this reading is already recorded");

        self.total += 1;
        let count = self.per_model.get(&model).copied().unwrap_or(0) + 1;
        self.per_model.insert(model.clone(), count);
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"reading-receipt\",\"version\":\"1.0.0\",\"event\":\"recorded\",\"data\":[{{\"model\":\"{}\",\"response_hash\":\"{response_hash}\",\"total\":{}}}]}}",
            model.replace(['"', '\\'], ""),
            self.total
        ));
        self.total
    }

    pub fn stats(&self) -> Stats {
        Stats { total: self.total, models: self.per_model.iter().map(|(m, c)| (m.clone(), *c)).collect(), signers: self.signers.clone() }
    }

    pub fn is_recorded(&self, response_hash: String) -> bool {
        self.seen.contains(&decode::<32>(&response_hash))
    }

    pub fn signers(&self) -> Vec<String> {
        self.signers.clone()
    }

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can change accepted keys");
    }
}

/// Lowercase hex to bytes. Uppercase is rejected so the signed text is rebuilt exactly.
fn decode<const N: usize>(hex: &str) -> [u8; N] {
    let bytes = hex.as_bytes();
    require!(bytes.len() == N * 2, "wrong length for a hex field");
    let nibble = |c: u8| -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            _ => env::panic_str("hex fields must be lowercase hex"),
        }
    };
    let mut out = [0u8; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = (nibble(bytes[2 * i]) << 4) | nibble(bytes[2 * i + 1]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::{self, Value};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    /// A real receipt: signed by the Qwen3.8-27B enclave on NEAR AI Cloud for a two-word test prompt.
    fn real() -> (String, String, String, String, String) {
        let v: Value = serde_json::from_str(include_str!("../tests/real-receipt.json")).unwrap();
        let f = |k: &str| v[k].as_str().unwrap().to_string();
        (f("model"), f("request_hash"), f("response_hash"), f("signature"), f("signer"))
    }

    fn as_account(name: &str) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(name.parse().unwrap()).build());
    }

    fn contract_with_real_signer() -> Contract {
        as_account("owner.testnet");
        let mut c = Contract::new("owner.testnet".parse().unwrap());
        c.add_signer(real().4);
        c
    }

    #[test]
    fn a_real_enclave_signature_is_counted_once() {
        let mut c = contract_with_real_signer();
        let (model, req, res, sig, signer) = real();
        as_account("anyone.testnet");
        assert_eq!(c.record(model.clone(), req, res.clone(), sig, signer), 1);
        assert!(c.is_recorded(res));
        let stats = c.stats();
        assert_eq!(stats.total, 1);
        assert_eq!(stats.models, vec![(model, 1)]);
    }

    #[test]
    #[should_panic(expected = "this reading is already recorded")]
    fn the_same_reading_cannot_be_counted_twice() {
        let mut c = contract_with_real_signer();
        let (model, req, res, sig, signer) = real();
        c.record(model.clone(), req.clone(), res.clone(), sig.clone(), signer.clone());
        c.record(model, req, res, sig, signer);
    }

    #[test]
    #[should_panic(expected = "signature does not match this reading")]
    fn a_changed_hash_is_rejected() {
        let mut c = contract_with_real_signer();
        let (model, req, res, sig, signer) = real();
        let forged = format!("{}{}", &res[..63], if res.ends_with('0') { '1' } else { '0' });
        c.record(model, req, forged, sig, signer);
    }

    #[test]
    #[should_panic(expected = "signature does not match this reading")]
    fn another_model_name_is_rejected() {
        let mut c = contract_with_real_signer();
        let (_, req, res, sig, signer) = real();
        c.record("some/other-model".to_string(), req, res, sig, signer);
    }

    #[test]
    #[should_panic(expected = "signer is not an accepted enclave key")]
    fn an_unknown_key_is_rejected() {
        as_account("owner.testnet");
        let mut c = Contract::new("owner.testnet".parse().unwrap());
        let (model, req, res, sig, signer) = real();
        c.record(model, req, res, sig, signer);
    }

    #[test]
    #[should_panic(expected = "only the owner can change accepted keys")]
    fn only_the_owner_adds_keys() {
        let mut c = contract_with_real_signer();
        as_account("anyone.testnet");
        c.add_signer("00".repeat(32));
    }
}

//! Joker Hegemon Extension Wallet — core (pure Rust, compiled to WebAssembly).
//!
//! Wraps Hegemon's own `wallet` crate (v0.11.4): encrypted wallet store, keys
//! and addresses, block scanning and note decryption, PrivateSpend witness
//! building and proving, and the `hegemon_submitAction` request. Keys and
//! proofs never leave this module; JavaScript only passes public chain data in
//! and gets the finished, self-contained action back.
//!
//! The spend flow mirrors Hegemon's `private-spend` CLI:
//! authority → sync → reference → select inputs → prepare → reserve → prove →
//! retain → submission bytes → `hegemon_submitAction` → mark submitted.

mod files;
mod ops;
#[cfg(feature = "bench")]
pub mod bench;

pub use ops::run_json;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod web {
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen(start)]
    pub fn start() {
        console_error_panic_hook::set_once();
    }

    /// Result of one core call.
    #[wasm_bindgen]
    pub struct CallOutput {
        reply: String,
        wallet: Option<Vec<u8>>,
    }

    #[wasm_bindgen]
    impl CallOutput {
        /// JSON reply: `{"ok":true,"result":…}` or `{"ok":false,"error":"…"}`.
        #[wasm_bindgen(getter)]
        pub fn reply(&self) -> String {
            self.reply.clone()
        }
        /// The encrypted wallet file after the call (save it), if one exists.
        #[wasm_bindgen(getter)]
        pub fn wallet(&self) -> Option<Vec<u8>> {
            self.wallet.clone()
        }
    }

    /// Run one wallet operation.
    ///
    /// `request` is the JSON request; `wallet` is the encrypted wallet file
    /// as last saved (or `undefined` before the wallet exists).
    #[wasm_bindgen]
    pub fn call(request: &str, wallet: Option<Vec<u8>>) -> CallOutput {
        crate::files::load(wallet);
        let reply = crate::ops::run_json(request);
        CallOutput { reply, wallet: crate::files::take() }
    }

    /// Development benchmark: prove and verify one ordinary PrivateSpend on
    /// Hegemon's public qualification fixture, with the same prover the wallet uses.
    #[cfg(feature = "bench")]
    #[wasm_bindgen]
    pub fn bench_prove() -> String {
        crate::bench::prove_fixture()
    }

    /// Core build information.
    #[wasm_bindgen]
    pub fn core_version() -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}

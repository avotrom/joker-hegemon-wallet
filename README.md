# Joker Hegemon Extension Wallet

A Chrome extension wallet for **Hegemon (HGN)** pre-mainnet v0.11 (node software v0.11.4).
Keys, block scanning, note decryption and zero-knowledge proofs all run inside the browser,
in Hegemon's own wallet code compiled from **pure Rust to WebAssembly** (wasm-bindgen).
Nothing secret is sent to the node.

All rights reserved. No use, copying or redistribution without the author's permission.

## Features

- 24-word recovery phrase (BIP-39 wordlist, 256-bit entropy), checked with a 3-word quiz; restore from 24 words
- Password-encrypted wallet file: Hegemon's own format (Argon2id + ChaCha20-Poly1305), stored in IndexedDB
- Auto-lock (5/15/30/60 min), unlock rate limiting, reveal phrase, change password, encrypted backup download
- Balance: available, being sent, maturing mining rewards (120 blocks), locked contract notes, other assets
- Hide amounts (eye button)
- Receive: your one shielded address, copy, save as file, QR code
- Send: address validation in the core, amount checks, 3 fee levels, proof built on this device, confirm with password
- Live send tracker: sync → proof (timer) → Dandelion stem → submit → mempool → confirmations; send again, cancel
- Merge notes (a PrivateSpend uses at most two input notes)
- Release funds held by an expired send (rescan)
- Activity list with filters; received-note details
- Network page: node checks (network identity, version, sync, accepts sends), latency, peers, wallet sync speed and ETA, latest blocks
- Chain strip indicator: latest 24 blocks, which ones your wallet has scanned, blocks with transactions, blocks with your notes
- Toolbar badge: node offline (!), scanning (…), send in progress (⇡)
- Notifications: received, confirmed, final (N confirmations), failed/expired, node offline, chain reorganisation
- Privacy: Tor for node traffic only (SOCKS5 via Chrome's proxy API, no direct fallback), Dandelion-style sending
  through a random other node after a random delay
- Several nodes; v0.11.4 upgrade warning (block 18,660); rate-limit backoff for public nodes
- Keyboard shortcut Alt+Shift+H; full-tab view

## Install (from the GitHub Actions zip)

1. Download `joker-hegemon-wallet-<version>.zip` from the workflow run (or a release) and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the unzipped folder.
3. Pin the extension. The welcome page opens.

## Node

The wallet reads public chain data from a Hegemon v0.11.4 node.

- Same Mac: start your node with `--wallet-rpc` (default address `http://127.0.0.1:9944`).
- Another machine: start it with public submission and allow this extension's origin
  (Settings → Nodes shows the exact command and origin to copy):

  ```
  python3 start.py --public-submit-rpc --rpc-external --rpc-cors chrome-extension://<extension id>
  ```

A read-only node can sync but not send; the wallet tells you which nodes accept sends.

## Build

Requirements: latest stable Rust with the `rust-src` component, `wasm-bindgen-cli`
matching `core/Cargo.lock`, Node 22, and optionally `wasm-opt` (binaryen).

```
rustup component add rust-src
cargo install wasm-bindgen-cli --version 0.2.130
npm ci
bash scripts/build-core.sh          # Hegemon v0.11.4 → Rust → WebAssembly → JS bindings (core/pkg)
node scripts/build.mjs --zip        # extension in dist/ and joker-hegemon-wallet-<version>.zip
```

`node scripts/build.mjs --mock` builds a UI-only version with a fake core for design work. It is
labelled as a mock and must never be used as a wallet.

### How the core is built

`scripts/patch_hegemon_browser.py` adapts a Hegemon checkout for the browser target only
(native behaviour is unchanged):

- the wallet file lives in memory during a call; JavaScript loads and saves it (IndexedDB)
- no file lock; browser clock (`Date.now`) instead of `SystemTime`; `web-time` instead of `Instant`
- 32-bit `usize` fixes for the depth-32 note tree (`1usize << 32`)
- browser randomness (`crypto.getRandomValues`) for every getrandom version

`scripts/patch_std_instant.py` patches the Rust standard library source, and the core is built with
`-Zbuild-std`: on `wasm32-unknown-unknown` std's `Instant::now()` panics, and Hegemon's prover
calls it for trace logging in a file that is part of the proof digest. The patched std returns a
monotonic counter on targets without a clock; native builds don't use that file.

It refuses to run if any source file hashed into a proof relation digest, or Hegemon's
`Cargo.lock`, would change — proofs made by the extension match the node's verifier exactly.

## Layout

```
core/                 Rust crate (wasm-bindgen): JSON operations over Hegemon's wallet
  src/ops.rs          create, unlock, addresses, status, sync (canonical block checks), send/prove, submit
  tests/ops.rs        native tests of the operations
extension/src/
  background.js       service worker: alarms, badge, notifications, Tor proxy
  offscreen.js        engine: session, node RPC, sync loop, send pipeline, Dandelion
  core-worker.js      runs the WebAssembly core in a Web Worker
  popup.*             the interface
scripts/              build, patch, icons
.github/workflows/    CI: builds the core and the extension zip
```

## Logo

Put your artwork at `extension/assets/logo.png` (square, at least 512 px) and run
`python3 scripts/make_icons.py`. Without it a placeholder mark is used.

## Security model

What protects the wallet:

- Keys, scanning and proofs stay inside the WebAssembly core. JavaScript never sees key material;
  it passes the password in and gets public data and finished transactions out.
- Wallet file: Hegemon's own format, Argon2id + ChaCha20-Poly1305. The extension's own data
  (the copy of the 24 words, send history, your address) is sealed with AES-256-GCM under a
  second Argon2id key from the same password. Nothing private is stored in plaintext.
- Lock clears the password, the session key, the address and the history from memory.
  Every password prompt (unlock, send, reveal phrase, backup actions) shares one failure
  counter with increasing delays.
- Only the extension's own pages can command the engine (no content scripts, no web-page
  API, sender checked). Settings cannot be changed while locked. Extension CSP allows no
  inline or remote scripts.
- Tor is fail-closed: with Tor on, requests to public nodes are refused unless Chrome confirms
  this extension's proxy rule is active; there is no direct fallback. Nodes on this computer or
  your local network always connect directly (Tor cannot reach them).
- Change returns to address 0, so a restore from the 24 words finds every note.

What it does not protect against:

- A malicious node (or anyone on the path to a plain-HTTP node) cannot take funds or learn keys,
  but it can show false chain data (for example a payment that never happened), hide your
  transactions, and see your IP address unless Tor is on. Block headers and proof-of-work are
  not verified by the wallet, the same as Hegemon's own wallet client. Use your own node for
  anything that matters, and wait for confirmations on it.
- Malware on the computer, a malicious browser extension with debugger access, or someone who
  can use the unlocked browser.
- A weak password: the encrypted files can be copied from the browser profile and guessed
  offline. Use a long password.
- "Dandelion-style" sending is a wallet-side measure (random other node, random delay), not the
  network-level Dandelion++ protocol. With a single node it only adds a delay.
- The recovery phrase is the 256-bit wallet root shown as 24 BIP-39 words; it restores this
  wallet in this extension. "Copy to clipboard" exposes it to other apps: prefer paper.

## Limits

- Proving runs single-threaded in WebAssembly and uses about 2–2.5 GB of memory; expect several
  minutes per send. Keep Chrome open until the send is submitted (the popup can be closed).
- A first sync over a rate-limited public node is slow; your own node is much faster.
- Hegemon v0.11 is pre-mainnet.

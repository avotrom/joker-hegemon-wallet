#!/usr/bin/env bash
# Build the Joker wallet core: Hegemon v0.11.4 wallet (pure Rust) → WebAssembly
# (wasm32-unknown-unknown) → JavaScript bindings (wasm-bindgen, --target web).
#
# Needs: latest stable Rust with the rust-src component (std is rebuilt for
#        wasm32-unknown-unknown with a small clock patch, see
#        scripts/patch_std_instant.py), wasm-bindgen-cli matching
#        core/Cargo.lock, git, python3.
# Optional: wasm-opt (binaryen) for a smaller, faster module.
#
# Env:
#   HEGEMON_REF   Hegemon tag to build against (default v0.11.4)
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
ref="${HEGEMON_REF:-v0.11.4}"
cd "$here"

if [ ! -d hegemon/.git ] && [ ! -L hegemon ]; then
  git clone --depth 1 --branch "$ref" https://github.com/Pauli-Group/Hegemon.git hegemon
fi
lock_sha_before="$(sha256sum hegemon/Cargo.lock | cut -d' ' -f1)"
python3 scripts/patch_hegemon_browser.py hegemon

# core/Cargo.lock starts from Hegemon's so shared crates resolve identically.
[ -f core/Cargo.lock ] || cp hegemon/Cargo.lock core/Cargo.lock

# Hegemon's prover calls Instant::now() (trace logging), which panics on
# wasm32-unknown-unknown; std is rebuilt from source with a monotonic counter.
# -Zbuild-std is unstable: RUSTC_BOOTSTRAP enables it on the stable compiler.
python3 scripts/patch_std_instant.py

cd core
RUSTC_BOOTSTRAP=1 cargo build --release --target wasm32-unknown-unknown -Zbuild-std=std,panic_abort

[ "$(sha256sum ../hegemon/Cargo.lock | cut -d' ' -f1)" = "$lock_sha_before" ] \
  || { echo "Hegemon Cargo.lock changed: refusing (proof digests depend on it)"; exit 1; }

want="$(awk '/^name = "wasm-bindgen"$/{getline; gsub(/version = |"/,""); print; exit}' Cargo.lock)"
have="$(wasm-bindgen --version | awk '{print $2}')"
if [ "$want" != "$have" ]; then
  echo "wasm-bindgen-cli $have does not match crate $want: cargo install wasm-bindgen-cli --version $want"
  exit 1
fi

rm -rf pkg
wasm-bindgen --target web --out-dir pkg --no-typescript \
  target/wasm32-unknown-unknown/release/joker_core.wasm

if command -v wasm-opt >/dev/null; then
  wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-mutable-globals --enable-reference-types --enable-multivalue \
    pkg/joker_core_bg.wasm -o pkg/joker_core_bg.opt.wasm
  mv pkg/joker_core_bg.opt.wasm pkg/joker_core_bg.wasm
fi
ls -la pkg

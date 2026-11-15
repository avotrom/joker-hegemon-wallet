#!/usr/bin/env python3
"""Give std::time::Instant::now() a monotonic value on wasm32-unknown-unknown.

On that target Rust's std has no clock and Instant::now() panics. Hegemon's
prover (circuits/transaction/src/smallwood_engine.rs) calls it for optional
trace logging (HEGEMON_SMALLWOOD_TRACE). That file is hashed into the proof
relation digest, so it cannot be edited; instead the standard library is built
from source (-Zbuild-std) with this patch.

The patched file, library/std/src/sys/time/unsupported.rs, is only compiled for
targets without a clock, so native builds are unaffected. Instants become a
monotonic tick counter: ordering is kept, durations are not wall time (they are
only used for diagnostics). SystemTime is left unchanged.

Usage: patch_std_instant.py [<rust sysroot>]   (default: `rustc --print sysroot`)
"""
import pathlib
import subprocess
import sys

sysroot = sys.argv[1] if len(sys.argv) > 1 else subprocess.check_output(
    ["rustc", "--print", "sysroot"], text=True).strip()
lib = pathlib.Path(sysroot) / "lib/rustlib/src/rust/library"
f = lib / "std/src/sys/time/unsupported.rs"
if not f.exists():
    sys.exit(f"{f} not found: install the rust-src component (rustup component add rust-src)")

text = f.read_text()
old = '''    pub fn now() -> Instant {
        panic!("time not implemented on this platform")
    }'''
new = '''    pub fn now() -> Instant {
        // joker-hegemon: monotonic tick counter instead of a panic (no clock here).
        use crate::sync::atomic::{AtomicU64, Ordering};
        static TICKS: AtomicU64 = AtomicU64::new(0);
        Instant(Duration::from_micros(TICKS.fetch_add(1, Ordering::Relaxed)))
    }'''
if new in text:
    print(f"already patched: {f}")
elif text.count(old) == 1:
    f.write_text(text.replace(old, new))
    print(f"patched {f}")
else:
    sys.exit(f"unexpected contents in {f}; update this patch for this Rust version")

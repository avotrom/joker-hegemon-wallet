#!/usr/bin/env python3
"""Adapt a Hegemon checkout so the `wallet` crate builds for wasm32-unknown-unknown
(browser WebAssembly through wasm-bindgen), without changing native behaviour.

Rules this script enforces:
  * Hegemon's Cargo.lock is never modified.
  * None of the source files hashed into proof relation digests (every
    include_bytes!/include_str! target) is modified. The script snapshots
    their SHA-256 before patching and aborts if any changed.

What it changes (all gated on the browser target, BROWSER below):
  wallet/Cargo.toml
      fs2 / rpassword / multi-thread tokio only for non-browser targets;
      js-sys for the browser clock.
  wallet/src/store.rs
      the wallet file lives in an in-memory map (`browser_vfs`) that the
      JavaScript side fills from IndexedDB and saves back after each call;
      no advisory file lock (one wallet worker, calls are serialised);
      SystemTime::now() -> Date.now() in the browser.
  wallet/src/poseidon2_v8_sync.rs, circuits/superneo-backend-lattice/src/lib.rs
      std::time::Instant -> web_time::Instant (identical to std on native;
      std's Instant panics on wasm32-unknown-unknown).
  wallet/src/poseidon2_v8_sync.rs
      two pure canonical-action helpers made `pub` for the extension's
      block-body checks (same checks as NodeRpcClient::canonical_block_actions).

Usage: patch_hegemon_browser.py <path-to-hegemon-checkout>
"""
import hashlib
import os
import pathlib
import re
import sys

BROWSER = 'all(target_arch = "wasm32", target_os = "unknown")'
NATIVE = f"not({BROWSER})"

root = pathlib.Path(sys.argv[1]).resolve()


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


# ------------------------------------------------------------ protected files
SKIP = ("target/", "node/", "experimental/", "prototypes/", "fuzz/")
protected = {root / "Cargo.lock"}
for rs in root.rglob("*.rs"):
    rel = rs.relative_to(root).as_posix()
    if rel.startswith(SKIP) or "/tests/" in rel:
        continue
    text = rs.read_text(errors="ignore")
    for m in re.findall(r'include_(?:bytes|str)!\(\s*"([^"]+)"', text):
        protected.add(pathlib.Path(os.path.normpath(rs.parent / m)))
protected = {p for p in protected if p.exists()}
before = {p: sha(p) for p in protected}


def patch(rel, old, new, count=1):
    path = root / rel
    if path in protected:
        sys.exit(f"refusing to patch digested file {rel}")
    text = path.read_text()
    if (new and new in text) or (not new and old not in text):
        return  # already applied
    if text.count(old) != count:
        sys.exit(f"patch failed: {rel}: expected {count} match(es) of {old!r}, found {text.count(old)}")
    path.write_text(text.replace(old, new))


def append_once(rel, marker, block):
    path = root / rel
    text = path.read_text()
    if marker not in text:
        path.write_text(text.rstrip("\n") + "\n" + block)


# ------------------------------------------------------------ wallet/Cargo.toml
if "# joker-browser-target" not in (root / "wallet/Cargo.toml").read_text():
    for line in (
        'fs2 = "0.4"\n',
        'rpassword = "7.4"\n',
        'tokio = { version = "1", features = ["macros", "rt-multi-thread", "sync", "time"] }\n',
    ):
        patch("wallet/Cargo.toml", line, "")
patch("wallet/Cargo.toml", 'hegemon-hash384 = { path = "../crypto/hash384" }\n',
      'hegemon-hash384 = { path = "../crypto/hash384" }\nweb-time = "1"\n')
append_once(
    "wallet/Cargo.toml",
    "# joker-browser-target",
    f"""
# joker-browser-target
[target.'cfg({NATIVE})'.dependencies]
fs2 = "0.4"
rpassword = "7.4"
tokio = {{ version = "1", features = ["macros", "rt-multi-thread", "sync", "time"] }}

[target.'cfg({BROWSER})'.dependencies]
tokio = {{ version = "1", default-features = false, features = ["macros", "rt", "sync", "time"] }}
js-sys = "0.3"
""",
)

# ------------------------------------------------------------ store.rs
S = "wallet/src/store.rs"
patch(S, "use fs2::FileExt;", f"#[cfg({NATIVE})]\nuse fs2::FileExt;")
patch(S, "    _file_lock: Option<fs::File>,", "    _file_lock: Option<WalletFileLock>,")
patch(S, "fn lock_wallet_file(path: &Path) -> Result<(PathBuf, fs::File), WalletError> {",
      f"#[cfg({NATIVE})]\nfn lock_wallet_file(path: &Path) -> Result<(PathBuf, WalletFileLock), WalletError> {{")
patch(S, "        let bytes = fs::read(&path)?;\n        let file: WalletFile = deserialize_exact(&bytes)?;",
      "        let bytes = read_wallet_file(&path)?;\n        let file: WalletFile = deserialize_exact(&bytes)?;")
patch(S, "        if fs::symlink_metadata(destination.as_ref()).is_ok() {\n            return Err(WalletError::StoreAlreadyExists);",
      "        if wallet_path_exists(destination.as_ref()) {\n            return Err(WalletError::StoreAlreadyExists);")
patch(S, "        if fail_if_exists && path.exists() {",
      "        if fail_if_exists && wallet_path_exists(&path) {")
patch(S, "pub fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), WalletError> {",
      f"#[cfg({NATIVE})]\npub fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), WalletError> {{")

# SystemTime::now() call site(s) outside tests.
store = (root / S).read_text()
if "browser_now_since_epoch" not in store:
    store = store.replace("use std::time::{SystemTime, UNIX_EPOCH};",
                          f"#[cfg({NATIVE})]\nuse std::time::{{SystemTime, UNIX_EPOCH}};", 1)
    n = store.count("SystemTime::now()")
    store = re.sub(r"SystemTime::now\(\)\s*\.duration_since\(UNIX_EPOCH\)",
                   "browser_now_since_epoch()", store)
    if "SystemTime::now()" in store:
        sys.exit("store.rs: unexpected SystemTime::now() shape - update the patch")
    if n == 0:
        sys.exit("store.rs: SystemTime::now() not found")
    (root / S).write_text(store)

append_once(S, "// joker-browser-shim", f"""
// joker-browser-shim ------------------------------------------------------
// Native: the original file-backed store. Browser (wasm32-unknown-unknown):
// the encrypted wallet file lives in `browser_vfs`; JavaScript moves the bytes
// to and from IndexedDB around each call. The bytes are exactly the same
// Argon2id + ChaCha20-Poly1305 wallet file the native wallet writes.

#[cfg({NATIVE})]
type WalletFileLock = fs::File;

#[cfg({NATIVE})]
fn read_wallet_file(path: &Path) -> Result<Vec<u8>, WalletError> {{
    Ok(fs::read(path)?)
}}

#[cfg({NATIVE})]
fn wallet_path_exists(path: &Path) -> bool {{
    fs::symlink_metadata(path).is_ok()
}}

#[cfg({NATIVE})]
fn browser_now_since_epoch() -> Result<std::time::Duration, std::time::SystemTimeError> {{
    SystemTime::now().duration_since(UNIX_EPOCH)
}}

#[cfg({BROWSER})]
fn browser_now_since_epoch() -> Result<std::time::Duration, std::convert::Infallible> {{
    Ok(std::time::Duration::from_millis(js_sys::Date::now() as u64))
}}

/// In-memory file map used as the wallet's filesystem in the browser.
#[cfg({BROWSER})]
pub mod browser_vfs {{
    use std::cell::RefCell;
    use std::collections::BTreeMap;
    use std::path::{{Path, PathBuf}};

    thread_local! {{
        static FILES: RefCell<BTreeMap<PathBuf, Vec<u8>>> = RefCell::new(BTreeMap::new());
    }}

    fn key(path: &Path) -> PathBuf {{
        let mut out = PathBuf::from("/");
        for c in path.components() {{
            match c {{
                std::path::Component::Normal(s) => out.push(s),
                std::path::Component::ParentDir => {{
                    out.pop();
                }}
                _ => {{}}
            }}
        }}
        out
    }}

    pub fn put(path: impl AsRef<Path>, bytes: Vec<u8>) {{
        FILES.with(|f| f.borrow_mut().insert(key(path.as_ref()), bytes));
    }}
    pub fn get(path: impl AsRef<Path>) -> Option<Vec<u8>> {{
        FILES.with(|f| f.borrow().get(&key(path.as_ref())).cloned())
    }}
    pub fn exists(path: impl AsRef<Path>) -> bool {{
        FILES.with(|f| f.borrow().contains_key(&key(path.as_ref())))
    }}
    pub fn remove(path: impl AsRef<Path>) -> Option<Vec<u8>> {{
        FILES.with(|f| f.borrow_mut().remove(&key(path.as_ref())))
    }}
    pub fn rename(from: impl AsRef<Path>, to: impl AsRef<Path>) -> bool {{
        FILES.with(|f| {{
            let mut f = f.borrow_mut();
            match f.remove(&key(from.as_ref())) {{
                Some(v) => {{
                    f.insert(key(to.as_ref()), v);
                    true
                }}
                None => false,
            }}
        }})
    }}
    pub fn clear() {{
        FILES.with(|f| f.borrow_mut().clear());
    }}
}}

#[cfg({BROWSER})]
#[derive(Debug)]
pub struct WalletFileLock;

#[cfg({BROWSER})]
fn lock_wallet_file(path: &Path) -> Result<(PathBuf, WalletFileLock), WalletError> {{
    if path.file_name().is_none() {{
        return Err(WalletError::InvalidArgument("wallet file has no filename"));
    }}
    Ok((path.to_path_buf(), WalletFileLock))
}}

#[cfg({BROWSER})]
fn read_wallet_file(path: &Path) -> Result<Vec<u8>, WalletError> {{
    browser_vfs::get(path).ok_or_else(|| {{
        WalletError::from(std::io::Error::new(std::io::ErrorKind::NotFound, "wallet file not found"))
    }})
}}

#[cfg({BROWSER})]
fn wallet_path_exists(path: &Path) -> bool {{
    browser_vfs::exists(path)
}}

#[cfg({BROWSER})]
pub fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), WalletError> {{
    browser_vfs::put(path, bytes.to_vec());
    Ok(())
}}
""")

# Any other fs::read / existence checks on the wallet path must go through the shim.
store = (root / S).read_text()
body = store.split("#[cfg(test)]")[0]
for pat in (r"fs::read\((?!path\)\?\)\n)", r"\.exists\(\)", r"fs::metadata\("):
    for m in re.finditer(pat, body):
        line = body[: m.start()].count("\n") + 1
        ctx = body.splitlines()[line - 1].strip()
        if "read_wallet_file" in ctx or ctx.startswith("//") or "fn read_wallet_file" in body.splitlines()[max(0, line - 3)]:
            continue
        print(f"note: store.rs:{line}: {ctx}")

# ------------------------------------------------------------ Instant -> web_time
for rel in ("wallet/src/poseidon2_v8_sync.rs", "circuits/superneo-backend-lattice/src/lib.rs"):
    path = root / rel
    if path in protected:
        sys.exit(f"refusing to patch digested file {rel}")
    t = path.read_text()
    t2 = t.replace("std::time::Instant", "web_time::Instant")
    if "    time::Instant,\n};" in t2 and "use web_time::Instant;" not in t2:
        t2 = t2.replace("    time::Instant,\n};", "};\nuse web_time::Instant;", 1)
    t2 = re.sub(r"use std::time::\{([^}]*)\bInstant\b([^}]*)\};",
                lambda m: f"use std::time::{{{(m.group(1) + m.group(2)).strip(' ,').replace(', ,', ',')}}};\nuse web_time::Instant;"
                if (m.group(1) + m.group(2)).strip(" ,") else "use web_time::Instant;", t2)
    path.write_text(t2)

lat = root / "circuits/superneo-backend-lattice/Cargo.toml"
lt = lat.read_text()
if "web-time" not in lt:
    lt = lt.replace("[dependencies]\n", '[dependencies]\nweb-time = "1"\n', 1)
    lat.write_text(lt)

# ------------------------------------------------------------ 32-bit usize
# wasm32 has a 32-bit usize. The note tree has depth 32, so `1usize << 32`
# overflows (a compile error for constants, and a silent wrap to 1 at run time
# in release builds). Compare in u64/u128 instead: identical on 64-bit hosts.
V8 = "wallet/src/poseidon2_v8_sync.rs"
t = (root / V8).read_text()
t2 = re.sub(
    r"(\b[\w.]+(?:\(\))?) (>=|>) \(1usize << SMALLWOOD_POSEIDON2_V8_MERKLE_DEPTH\)",
    r"(\1 as u64) \2 (1u64 << SMALLWOOD_POSEIDON2_V8_MERKLE_DEPTH)",
    t,
)
if "1usize << SMALLWOOD_POSEIDON2_V8_MERKLE_DEPTH" in t2:
    sys.exit(f"{V8}: unhandled 1usize << SMALLWOOD_POSEIDON2_V8_MERKLE_DEPTH")
(root / V8).write_text(t2)

M = "state/merkle/src/lib.rs"
patch(M, "    pub fn capacity(&self) -> usize {\n        1usize << self.depth\n    }",
      "    pub fn capacity(&self) -> usize {\n        usize::try_from(self.capacity_exact()).unwrap_or(usize::MAX)\n    }\n\n"
      "    fn capacity_exact(&self) -> u128 {\n        1u128.checked_shl(self.depth as u32).unwrap_or(u128::MAX)\n    }")
patch(M, "        self.leaf_count == self.capacity()",
      "        self.leaf_count as u128 == self.capacity_exact()")
patch(M, "        if values.len() > self.capacity().saturating_sub(self.leaf_count) {",
      "        if values.len() as u128 > self.capacity_exact().saturating_sub(self.leaf_count as u128) {")

# ------------------------------------------------------------ pub helpers
patch("wallet/src/poseidon2_v8_sync.rs", "pub(crate) fn canonical_action_id_exact(", "pub fn canonical_action_id_exact(")
patch("wallet/src/poseidon2_v8_sync.rs", "pub(crate) fn canonical_recovery_action_body(", "pub fn canonical_recovery_action_body(")

# ------------------------------------------------------------ verify
after = {p: sha(p) for p in protected}
changed = [str(p.relative_to(root)) for p in protected if before[p] != after[p]]
if changed:
    sys.exit("digested files changed (proofs would be rejected): " + ", ".join(changed))
print(f"patched {root}; {len(protected)} digested files (incl. Cargo.lock) verified unchanged")

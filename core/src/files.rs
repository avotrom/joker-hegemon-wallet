//! Where the encrypted wallet file lives.
//!
//! Browser: an in-memory map inside Hegemon's patched store
//! (`wallet::store::browser_vfs`); JavaScript loads it from IndexedDB before a
//! call and saves it back afterwards. Native (tests): a real directory.

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod imp {
    use anyhow::{bail, Result};
    use wallet::store::browser_vfs as vfs;

    pub const WALLET_DIR: &str = "/wallet";
    pub const WALLET_PATH: &str = "/wallet/joker.wallet";

    pub fn exists(p: &str) -> bool {
        vfs::exists(p)
    }
    pub fn create_dir_all(_p: &str) -> Result<()> {
        Ok(())
    }
    pub fn remove(p: &str) {
        vfs::remove(p);
    }
    pub fn rename(from: &str, to: &str) -> Result<()> {
        if !vfs::rename(from, to) {
            bail!("rename: {from} not found");
        }
        Ok(())
    }
    pub fn load(bytes: Option<Vec<u8>>) {
        vfs::clear();
        if let Some(b) = bytes {
            vfs::put(WALLET_PATH, b);
        }
    }
    pub fn take() -> Option<Vec<u8>> {
        let out = vfs::get(WALLET_PATH);
        vfs::clear();
        out
    }
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
mod imp {
    use anyhow::Result;
    use std::path::Path;

    pub const WALLET_DIR: &str = "joker-native-wallet";
    pub const WALLET_PATH: &str = "joker-native-wallet/joker.wallet";

    pub fn exists(p: &str) -> bool {
        Path::new(p).exists()
    }
    pub fn create_dir_all(p: &str) -> Result<()> {
        Ok(std::fs::create_dir_all(p)?)
    }
    pub fn remove(p: &str) {
        let _ = std::fs::remove_file(p);
    }
    pub fn rename(from: &str, to: &str) -> Result<()> {
        Ok(std::fs::rename(from, to)?)
    }
}

pub use imp::*;

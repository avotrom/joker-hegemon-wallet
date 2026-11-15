//! Joker Hegemon Extension Wallet — core.
//!
//! Wallet operations behind one JSON request/reply function (`run_json`).
//! In the browser the request comes from JavaScript through wasm-bindgen and
//! the encrypted wallet file (Hegemon's own Argon2id + ChaCha20-Poly1305
//! format) is handed in and out as bytes; natively it is a normal file. Keys, scanning, decryption, witness construction and
//! PrivateSpend proving never leave this module; the extension only moves
//! public chain data in and the finished, self-contained action out.
//!
//! The spend flow mirrors Hegemon's `private-spend` CLI (v0.11.x):
//! authority → sync → reference → select inputs → prepare → reserve → prove →
//! retain → submission bytes → `hegemon_submitAction` → mark submitted.

use anyhow::{Context, Result, anyhow, bail, ensure};
use codec::{DecodeWithMemLimit, Encode};
use hegemon_hash384::{blake2b_384_domain_hash, domains};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};
use synthetic_crypto::private_note_payload::NoteState;
use wallet::poseidon2_v8_sync::{self as v8sync, Poseidon2V8CanonicalBlock};
use wallet::private_spend_build::{
    self as build, OutputRequest, SpendInput, SpendOperation, SpendReference,
};
use wallet::private_spend_rpc::{SourcePrivateSpendAuthority, prepare_submit_request};
use wallet::{DerivedKeys, RootSecret, ShieldedAddress, WalletStore};
use zeroize::Zeroizing;

use crate::files::{self, WALLET_DIR, WALLET_PATH};
const NATIVE_ASSET_ID: u64 = 0;
const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

// Same bounds as wallet::node_rpc (v0.11.4).
const ACTION_BODY_CHUNK_SCHEMA: &str = "hegemon.native.action-body-chunk-v1";
const MAX_CHUNK_BYTES: usize = 1024 * 1024;
const MAX_BLOCK_ACTIONS: usize = 10_000;
const MAX_ACTION_PAYLOAD_BYTES: usize = 2 * 1024 * 1024 + 16 * 1024;
const MAX_BLOCK_ACTION_BYTES: usize = 64 * 1024 * 1024;
const MAX_ACTION_BODY_BYTES: usize = MAX_BLOCK_ACTION_BYTES + 5 * (MAX_BLOCK_ACTIONS + 1);

#[derive(Deserialize)]
struct Request {
    op: String,
    #[serde(default)]
    passphrase: Option<String>,
    #[serde(default)]
    new_passphrase: Option<String>,
    #[serde(default)]
    entropy: Option<String>,
    #[serde(default)]
    authority: Option<AuthorityInput>,
    #[serde(default)]
    node_hashes: BTreeMap<u64, String>,
    #[serde(default)]
    blocks: Vec<BlockInput>,
    #[serde(default)]
    recipient: Option<String>,
    #[serde(default, deserialize_with = "opt_u64")]
    amount: Option<u64>,
    #[serde(default, deserialize_with = "opt_u64")]
    fee: Option<u64>,
    #[serde(default)]
    attempt: Option<String>,
    #[serde(default)]
    ack: Option<String>,
    #[serde(default)]
    index: Option<u32>,
    #[serde(default)]
    address: Option<String>,
    #[serde(default)]
    salt: Option<String>,
    /// Explicit input positions (used by "Merge notes").
    #[serde(default)]
    positions: Option<Vec<u64>>,
}

#[derive(Deserialize)]
struct AuthorityInput {
    manifest: String,
    expected_genesis: String,
    node_genesis: String,
    node_config: Value,
    parameters: Value,
    tip_height: u64,
}

#[derive(Deserialize)]
struct BlockInput {
    height: u64,
    hash: String,
    chunks: Vec<ChunkResponse>,
}

#[derive(Deserialize, Clone)]
struct ChunkResponse {
    schema: String,
    block_hash: String,
    height: u64,
    parent_hash: String,
    tx_count: u32,
    extrinsics_root: String,
    action_body_hash: String,
    action_body_len: u64,
    chunk_index: u32,
    chunk_count: u32,
    chunk_len: u64,
    chunk: String,
}

/// Accept u64 as a JSON number or a decimal string (JavaScript cannot hold
/// every u64 exactly as a number).
fn opt_u64<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Option<u64>, D::Error> {
    use serde::de::Error;
    match Option::<Value>::deserialize(d)? {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n
            .as_u64()
            .map(Some)
            .ok_or_else(|| D::Error::custom("not a u64")),
        Some(Value::String(s)) => s.parse::<u64>().map(Some).map_err(D::Error::custom),
        Some(_) => Err(D::Error::custom("expected integer")),
    }
}

/// One request in, one reply out: `{"ok":true,"result":…}` or `{"ok":false,"error":"…"}`.
pub fn run_json(raw: &str) -> String {
    match run(raw) {
        Ok(v) => json!({ "ok": true, "result": v }),
        Err(e) => json!({ "ok": false, "error": format!("{e:#}") }),
    }
    .to_string()
}

fn run(raw: &str) -> Result<Value> {
    let req: Request = serde_json::from_str(raw).context("bad request")?;
    match req.op.as_str() {
        "version" => Ok(json!({
            "core": CORE_VERSION,
            "relation_digest": hex::encode(transaction_circuit::private_spend::relation_digest()),
            "address_version": wallet::address::POSEIDON2_V8_ADDRESS_VERSION,
        })),
        "exists" => Ok(json!({ "exists": files::exists(WALLET_PATH) })),
        "create" => op_create(&req),
        "check" => {
            open(&req)?;
            Ok(json!({ "unlocked": true }))
        }
        "address" => {
            let s = open(&req)?;
            let a = s.private_spend_address(req.index.unwrap_or(0))?;
            Ok(json!({ "index": a.diversifier_index, "address": a.encode()? }))
        }
        "validate_address" => op_validate_address(&req),
        "status" => op_status(&open(&req)?),
        "sync" => op_sync(&req),
        "send" => op_send(&req),
        "submit_request" => op_submit_request(&req),
        "mark_submitted" => {
            let s = open(&req)?;
            let id = unhex::<32>(req.attempt.as_deref().context("attempt")?)?;
            let ack = unhex::<48>(req.ack.as_deref().context("ack")?)?;
            s.mark_private_spend_submitted(id, ack)?;
            op_status(&s)
        }
        "cancel" => {
            let s = open(&req)?;
            let id = unhex::<32>(req.attempt.as_deref().context("attempt")?)?;
            s.cancel_private_spend_preparation(id)?;
            op_status(&s)
        }
        "change_passphrase" => op_change_passphrase(&req),
        "rescan" => op_rescan(&req),
        "kdf" => op_kdf(&req),
        other => bail!("unknown op {other}"),
    }
}

// ---------------------------------------------------------------- helpers

fn passphrase(req: &Request) -> Result<Zeroizing<String>> {
    let p = req.passphrase.clone().context("passphrase required")?;
    ensure!(!p.is_empty(), "passphrase must not be empty");
    Ok(Zeroizing::new(p))
}

fn open(req: &Request) -> Result<WalletStore> {
    let p = passphrase(req)?;
    ensure!(files::exists(WALLET_PATH), "no wallet");
    WalletStore::open(WALLET_PATH, &p).map_err(|e| anyhow!("unlock failed: {e}"))
}

fn unhex<const N: usize>(s: &str) -> Result<[u8; N]> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let v = hex::decode(s).context("hex")?;
    v.try_into()
        .map_err(|v: Vec<u8>| anyhow!("expected {N} bytes, got {}", v.len()))
}

fn atoms(v: u128) -> String {
    v.to_string()
}

fn authority(req: &Request) -> Result<SourcePrivateSpendAuthority> {
    let a = req.authority.as_ref().context("authority required")?;
    ensure!(a.manifest.len() <= 16 * 1024, "manifest too large");
    SourcePrivateSpendAuthority::from_verified_node(
        a.manifest.as_bytes(),
        unhex::<32>(&a.expected_genesis)?,
        unhex::<32>(&a.node_genesis)?,
        &a.node_config,
        &a.parameters,
        a.tip_height,
    )
    .map_err(|e| anyhow!("node is not the expected Hegemon network: {e}"))
}

// ---------------------------------------------------------------- create / addresses

fn op_create(req: &Request) -> Result<Value> {
    let p = passphrase(req)?;
    ensure!(
        p.chars().count() >= 8,
        "password must have at least 8 characters"
    );
    ensure!(
        !files::exists(WALLET_PATH),
        "a wallet already exists in this extension"
    );
    files::create_dir_all(WALLET_DIR)?;
    let entropy = Zeroizing::new(unhex::<32>(req.entropy.as_deref().context("entropy")?)?);
    let store = WalletStore::create_from_root(WALLET_PATH, &p, RootSecret::from_bytes(*entropy))?;
    let a = store.private_spend_address(0)?;
    Ok(json!({ "index": 0, "address": a.encode()? }))
}

/// Decode a recipient and require the current address version, crypto suite
/// and canonical encoding. `Err` carries the user-facing reason.
fn checked_recipient(text: &str) -> std::result::Result<ShieldedAddress, String> {
    let a = ShieldedAddress::decode(text).map_err(|e| e.to_string())?;
    if a.version != wallet::address::POSEIDON2_V8_ADDRESS_VERSION || a.crypto_suite != 7 {
        return Err("not a current (V8) Hegemon address".into());
    }
    match a.encode() {
        Ok(canonical) if canonical == text => Ok(a),
        _ => Err("non-canonical address encoding".into()),
    }
}

fn op_validate_address(req: &Request) -> Result<Value> {
    let text = req.address.as_deref().context("address")?.trim();
    Ok(match checked_recipient(text) {
        Ok(_) => json!({ "valid": true }),
        Err(reason) => json!({ "valid": false, "reason": reason }),
    })
}

/// Argon2id key for the extension's own encrypted data (recovery-phrase copy,
/// send history). Same KDF and parameters as Hegemon's wallet file, with a
/// separate random salt, so no part of the stored data is weaker than the
/// wallet file itself. Requires the correct wallet password.
fn op_kdf(req: &Request) -> Result<Value> {
    let p = passphrase(req)?;
    open(req)?; // only derive for the real password
    let salt = unhex::<16>(req.salt.as_deref().context("salt")?)?;
    let mut key = Zeroizing::new([0u8; 32]);
    argon2::Argon2::default()
        .hash_password_into(p.as_bytes(), &salt, key.as_mut_slice())
        .map_err(|e| anyhow!("key derivation failed: {e}"))?;
    Ok(json!({ "key": hex::encode(key.as_slice()) }))
}

// ---------------------------------------------------------------- status

fn empty_status() -> Value {
    let zero = json!({ "atoms": "0", "notes": 0 });
    json!({
        "tip": null,
        "initialized": false,
        "balance": {
            "synced_height": null,
            "available": zero, "reserved": zero, "immature": zero,
            "next_maturity_height": null, "blocks_until_next_maturity": null,
            "htlc": zero, "policy": zero, "treasury_value": zero,
            "accumulator_notes": 0, "other_assets": {},
        },
        "notes": [],
        "attempts": [],
    })
}

fn op_status(s: &WalletStore) -> Result<Value> {
    // A new or restored wallet has no chain mirror until its first sync.
    let tip = match s.poseidon2_v8_tip() {
        Ok(tip) => tip,
        Err(e) if e.to_string().contains("not initialized") => return Ok(empty_status()),
        Err(e) => return Err(e.into()),
    };
    let b = s.private_spend_balance()?;
    let amt =
        |a: &wallet::store::BalanceAmount| json!({ "atoms": atoms(a.atoms), "notes": a.notes });

    let mut notes = Vec::new();
    for n in s.poseidon2_v8_owned_notes()? {
        notes.push(json!({
            "kind": "ordinary",
            "position": n.position,
            "value": n.opening.value.to_string(),
            "asset": n.opening.asset_id,
            "created_height": n.created_height,
            "created_block": hex::encode(n.created_block_hash),
            "spent": n.spent,
        }));
    }
    for n in s.private_spend_notes()? {
        let p = n.opening()?;
        let kind = match &p.state {
            NoteState::Ordinary { .. } => "ordinary",
            NoteState::Htlc(_) => "htlc",
            NoteState::Policy(_) => "policy",
            NoteState::TreasuryValue(_) => "treasury-value",
            NoteState::TreasuryAccumulator(_) => "accumulator",
        };
        notes.push(json!({
            "kind": kind,
            "position": n.position,
            "value": p.note.value.to_string(),
            "asset": p.note.asset_id,
            "created_height": n.created_height,
            "created_block": hex::encode(n.created_block_hash),
            "spent": n.spent,
        }));
    }
    let attempts: Vec<Value> = s
        .private_spend_attempts()?
        .into_iter()
        .map(|a| {
            json!({
                "id": hex::encode(a.id),
                "status": format!("{:?}", a.status),
                "mined_height": a.mined_in.map(|(h, _)| h),
                "mined_block": a.mined_in.map(|(_, b)| hex::encode(b)),
                "inputs_consumed": a.inputs_consumed,
            })
        })
        .collect();

    Ok(json!({
        "tip": { "height": tip.height, "hash": hex::encode(tip.block_hash) },
        "initialized": true,
        "balance": {
            "synced_height": b.synced_height,
            "available": amt(&b.ordinary_available),
            "reserved": amt(&b.ordinary_reserved),
            "immature": amt(&b.immature_coinbase),
            "next_maturity_height": b.next_maturity_height,
            "blocks_until_next_maturity": b.blocks_until_next_maturity,
            "htlc": amt(&b.htlc),
            "policy": amt(&b.policy),
            "treasury_value": amt(&b.treasury_value),
            "accumulator_notes": b.accumulator_notes,
            "other_assets": b.non_native.iter()
                .map(|(k, v)| (k.to_string(), amt(v)))
                .collect::<serde_json::Map<_, _>>(),
        },
        "notes": notes,
        "attempts": attempts,
    }))
}

// ---------------------------------------------------------------- sync

fn reassemble(block: &BlockInput) -> Result<Poseidon2V8CanonicalBlock> {
    let expected_hash = unhex::<32>(&block.hash)?;
    ensure!(
        !block.chunks.is_empty(),
        "block {} has no body chunks",
        block.height
    );
    let first = &block.chunks[0];
    ensure!(
        first.schema == ACTION_BODY_CHUNK_SCHEMA,
        "action-body chunk schema mismatch"
    );
    let body_len = usize::try_from(first.action_body_len)?;
    ensure!(
        body_len > 0 && body_len <= MAX_ACTION_BODY_BYTES,
        "action body length out of bounds"
    );
    let chunk_count = body_len.div_ceil(MAX_CHUNK_BYTES);
    ensure!(
        first.chunk_count as usize == chunk_count,
        "action-body chunk count mismatch"
    );
    ensure!(
        block.chunks.len() == chunk_count,
        "missing action-body chunks"
    );
    ensure!(
        (first.tx_count as usize) <= MAX_BLOCK_ACTIONS,
        "too many actions"
    );
    let parent_hash = unhex::<32>(&first.parent_hash)?;
    let extrinsics_root = unhex::<32>(&first.extrinsics_root)?;
    let body_hash = unhex::<48>(&first.action_body_hash)?;
    ensure!(
        unhex::<32>(&first.block_hash)? == expected_hash && first.height == block.height,
        "action-body chunk block binding mismatch"
    );

    let mut body = Vec::with_capacity(body_len);
    for (i, c) in block.chunks.iter().enumerate() {
        ensure!(
            c.schema == first.schema
                && c.block_hash == first.block_hash
                && c.height == first.height
                && c.parent_hash == first.parent_hash
                && c.tx_count == first.tx_count
                && c.extrinsics_root == first.extrinsics_root
                && c.action_body_hash == first.action_body_hash
                && c.action_body_len == first.action_body_len
                && c.chunk_count == first.chunk_count,
            "action-body metadata changed between chunks"
        );
        ensure!(
            c.chunk_index as usize == i,
            "action-body chunk out of order"
        );
        let start = i * MAX_CHUNK_BYTES;
        let expect_len = (body_len - start).min(MAX_CHUNK_BYTES);
        ensure!(
            c.chunk_len as usize == expect_len,
            "action-body chunk length mismatch"
        );
        let hexpart = c.chunk.strip_prefix("0x").context("chunk lacks 0x")?;
        ensure!(hexpart.len() == expect_len * 2, "chunk hex length mismatch");
        body.extend_from_slice(&hex::decode(hexpart)?);
    }
    ensure!(
        body.len() == body_len,
        "action body length differs after reassembly"
    );
    ensure!(
        blake2b_384_domain_hash(domains::NATIVE_ACTION_BODY_V3, [body.as_slice()]) == body_hash,
        "action-body digest mismatch"
    );
    let mut cursor = body.as_slice();
    let actions = Vec::<Vec<u8>>::decode_with_mem_limit(&mut cursor, MAX_ACTION_BODY_BYTES)
        .map_err(|e| anyhow!("decode action body: {e}"))?;
    ensure!(
        cursor.is_empty() && actions.encode() == body,
        "non-canonical action body encoding"
    );
    ensure!(
        actions.len() == first.tx_count as usize,
        "action count differs from header"
    );
    let mut total = 0usize;
    let mut ids = Vec::with_capacity(actions.len());
    let mut unique = HashSet::with_capacity(actions.len());
    for a in &actions {
        if a.len() > MAX_ACTION_PAYLOAD_BYTES {
            ensure!(
                v8sync::canonical_recovery_action_body(a)?.is_some(),
                "action exceeds per-action cap"
            );
        }
        total = total
            .checked_add(a.len())
            .context("action bytes overflow")?;
        ensure!(
            total <= MAX_BLOCK_ACTION_BYTES,
            "block action bytes exceed cap"
        );
        let id = v8sync::canonical_action_id_exact(a)?;
        ensure!(unique.insert(id), "duplicate action id");
        ids.push(id);
    }
    ensure!(
        protocol_kernel::compute_native_action_root_v1(&ids) == extrinsics_root,
        "action root differs from header"
    );
    Ok(Poseidon2V8CanonicalBlock {
        height: block.height,
        hash: expected_hash,
        parent_hash,
        action_bytes: actions,
    })
}

fn op_sync(req: &Request) -> Result<Value> {
    let s = open(req)?;
    let token = authority(req)?;
    s.initialize_private_spend_source_context(&token)?;

    // Reorg handling: walk back until our tip matches the node's canonical hash.
    let mut rolled_back = 0u64;
    loop {
        let tip = s.poseidon2_v8_tip()?;
        match req.node_hashes.get(&tip.height) {
            None => {
                return Ok(json!({
                    "need_hash_at": tip.height,
                    "tip": { "height": tip.height, "hash": hex::encode(tip.block_hash) },
                    "rolled_back": rolled_back,
                }));
            }
            Some(h) if unhex::<32>(h)? == tip.block_hash => break,
            Some(_) => {
                ensure!(tip.height > 0, "node genesis differs from this wallet");
                let height = tip.height - 1;
                let hash = s
                    .poseidon2_v8_canonical_hash(height)?
                    .context("rollback checkpoint absent")?;
                s.rollback_poseidon2_v8_to(height, hash)?;
                rolled_back += 1;
            }
        }
    }

    let mut recovered = 0usize;
    let mut spent = 0usize;
    let mut applied = 0u64;
    for b in &req.blocks {
        let tip = s.poseidon2_v8_tip()?;
        if b.height <= tip.height {
            continue; // already applied (e.g. retried batch)
        }
        ensure!(
            b.height == tip.height + 1,
            "blocks must be contiguous from {}",
            tip.height + 1
        );
        let block = reassemble(b)?;
        ensure!(
            block.parent_hash == tip.block_hash,
            "fork detected at {}",
            b.height
        );
        let delta = s.apply_private_spend_source_block(&block, &token)?;
        recovered += delta.recovered;
        spent += delta.spent;
        applied += 1;
    }
    let tip = s.poseidon2_v8_tip()?;
    Ok(json!({
        "tip": { "height": tip.height, "hash": hex::encode(tip.block_hash) },
        "applied": applied,
        "recovered": recovered,
        "spent": spent,
        "rolled_back": rolled_back,
        "status": op_status(&s)?,
    }))
}

// ---------------------------------------------------------------- send

struct Candidate {
    position: u64,
    value: u64,
}

fn reference(s: &WalletStore, t: &SourcePrivateSpendAuthority) -> Result<SpendReference> {
    let tip = s.poseidon2_v8_tip()?;
    t.authorize_current(tip.height.checked_add(1).context("height overflow")?)?;
    s.require_launch_context(t.context())?;
    Ok(SpendReference {
        chain_id: t.context().chain_id(),
        parent_hash: tip.block_hash,
        parent_height: tip.height,
        merkle_root: tip.anchor,
    })
}

// Same as private-spend CLI `ordinary_input`.
fn ordinary_input(
    s: &WalletStore,
    k: &DerivedKeys,
    r: SpendReference,
    position: u64,
) -> Result<(SpendInput, u64)> {
    if let Some(n) = s
        .private_spend_notes()?
        .into_iter()
        .find(|n| n.position == position && !n.spent)
    {
        let p = n.opening()?;
        ensure!(
            matches!(p.state, NoteState::Ordinary { .. }),
            "selected input is a policy note"
        );
        let path = s
            .poseidon2_v8_canonical_note_witness_at(n.commitment, n.position)?
            .context("canonical membership absent")?;
        ensure!(
            path.anchor == s.poseidon2_v8_tip()?.anchor,
            "stale membership"
        );
        return Ok((SpendInput::stored(&n, k, path.path)?, p.note.value));
    }
    let n = s
        .poseidon2_v8_owned_notes()?
        .into_iter()
        .find(|n| n.position == position && !n.spent)
        .context("unspent ordinary input absent")?;
    Ok((
        SpendInput::legacy(n.opening, n.position.try_into()?, n.path, k, r.chain_id)?,
        n.opening.value,
    ))
}

fn spendable(s: &WalletStore) -> Result<Vec<Candidate>> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for n in s.private_spend_notes()? {
        if n.spent {
            continue;
        }
        let p = n.opening()?;
        if matches!(p.state, NoteState::Ordinary { .. })
            && p.note.asset_id == NATIVE_ASSET_ID
            && p.note.value > 0
            && seen.insert(n.position)
        {
            out.push(Candidate {
                position: n.position,
                value: p.note.value,
            });
        }
    }
    for n in s.poseidon2_v8_owned_notes()? {
        if !n.spent
            && n.opening.asset_id == NATIVE_ASSET_ID
            && n.opening.value > 0
            && seen.insert(n.position)
        {
            out.push(Candidate {
                position: n.position,
                value: n.opening.value,
            });
        }
    }
    out.sort_by_key(|c| c.value);
    Ok(out)
}

/// Input sets (1 or 2 notes) covering `need`, best (smallest total) first.
fn input_sets(c: &[Candidate], need: u64, limit: usize) -> Vec<Vec<u64>> {
    let mut sets: Vec<(u128, Vec<u64>)> = Vec::new();
    for a in c {
        if a.value >= need {
            sets.push((a.value as u128, vec![a.position]));
        }
    }
    let n = c.len().min(400);
    for i in 0..n {
        for j in (i + 1)..n {
            let sum = c[i].value as u128 + c[j].value as u128;
            if sum >= need as u128 && c[i].value < need && c[j].value < need {
                sets.push((sum, vec![c[i].position, c[j].position]));
            }
        }
    }
    sets.sort_by_key(|(sum, v)| (*sum, v.len()));
    sets.into_iter().take(limit).map(|(_, v)| v).collect()
}

fn op_send(req: &Request) -> Result<Value> {
    let s = open(req)?;
    let token = authority(req)?;
    let recipient_text = req
        .recipient
        .as_deref()
        .context("recipient")?
        .trim()
        .to_string();
    let recipient = checked_recipient(&recipient_text)
        .map_err(|reason| anyhow!("invalid recipient address: {reason}"))?;
    let amount = req.amount.context("amount")?;
    let fee = req.fee.context("fee")?;
    ensure!(amount > 0, "amount must be positive");
    let need = amount.checked_add(fee).context("amount overflow")?;

    // The node must be at our tip, otherwise the proof would reference a stale parent.
    let tip = s.poseidon2_v8_tip()?;
    let node_tip = req.authority.as_ref().map(|a| a.tip_height).unwrap_or(0);
    ensure!(
        node_tip == tip.height,
        "wallet is not synced to the node tip ({} vs {}) — sync first",
        tip.height,
        node_tip
    );

    let keys = s
        .derived_keys()?
        .context("watch-only wallet cannot spend")?;
    let r = reference(&s, &token)?;
    let candidates = spendable(&s)?;
    let total: u128 = candidates.iter().map(|c| c.value as u128).sum();
    ensure!(total >= need as u128, "insufficient spendable balance");
    let sets = match &req.positions {
        Some(p) => {
            ensure!((1..=2).contains(&p.len()), "select one or two inputs");
            ensure!(p.len() == 1 || p[0] != p[1], "duplicate input");
            vec![p.clone()]
        }
        None => input_sets(&candidates, need, 8),
    };
    ensure!(
        !sets.is_empty(),
        "no one or two notes cover this amount — use 'Merge notes' first (a PrivateSpend has two input slots)"
    );

    let mut last_err = None;
    for positions in sets {
        let (first, a) = ordinary_input(&s, &keys, r, positions[0])?;
        let (second, b) = if positions.len() == 2 {
            ordinary_input(&s, &keys, r, positions[1])?
        } else {
            (SpendInput::dummy()?, 0)
        };
        let input_total = a.checked_add(b).context("value overflow")?;
        let change_value = input_total
            .checked_sub(need)
            .context("insufficient value")?;
        // Change returns to address index 0. A wallet restored from the 24 words
        // only scans index 0, so change on any other index would be invisible
        // after a restore. Addresses never appear on chain, so this costs no privacy.
        let change = s.private_spend_address(0)?;
        let prepared = build::prepare(
            r,
            fee,
            [first, second],
            [
                OutputRequest {
                    recipient: recipient.clone(),
                    value: amount,
                },
                OutputRequest {
                    recipient: change,
                    value: change_value,
                },
            ],
            SpendOperation::Ordinary,
        )?;
        token.authorize_current(
            prepared
                .public_statement()
                .reference_parent_height
                .checked_add(1)
                .context("height overflow")?,
        )?;
        let id = match s.reserve_private_spend(token.context(), &prepared) {
            Ok(id) => id,
            Err(e) => {
                last_err = Some(e);
                continue; // inputs reserved by another attempt: try the next set
            }
        };
        let carrier = prepared
            .prove_authorized(token.context())
            .with_context(|| {
                format!(
                    "attempt {} stays reserved — cancel it to free inputs",
                    hex::encode(id)
                )
            })?;
        let action = v8sync::encode_private_spend_candidate_action(token.context(), &carrier)?;
        s.retain_private_spend_action(token.context(), id, &action)?;
        return Ok(json!({
            "attempt": hex::encode(id),
            "inputs": positions,
            "change": change_value.to_string(),
            "reference_height": r.parent_height,
            "action_bytes": action.len(),
        }));
    }
    Err(anyhow!(
        "all candidate inputs are reserved by unfinished sends: {}",
        last_err.map(|e| e.to_string()).unwrap_or_default()
    ))
}

fn op_submit_request(req: &Request) -> Result<Value> {
    let s = open(req)?;
    let token = authority(req)?;
    let id = unhex::<32>(req.attempt.as_deref().context("attempt")?)?;
    // Marks the attempt "submission uncertain" durably *before* any RPC.
    let action = s.private_spend_submission_bytes(token.context(), id)?;
    let (expected, carrier) = v8sync::project_private_spend_candidate_action(&action)?;
    let height = req
        .authority
        .as_ref()
        .map(|a| a.tip_height)
        .unwrap_or(0)
        .checked_add(1)
        .context("height overflow")?;
    let request = prepare_submit_request(token.context(), height, &carrier)?;
    Ok(
        json!({ "attempt": hex::encode(id), "expected_ack": hex::encode(expected), "request": request }),
    )
}

fn op_change_passphrase(req: &Request) -> Result<Value> {
    let old = passphrase(req)?;
    let new = Zeroizing::new(req.new_passphrase.clone().context("new_passphrase")?);
    ensure!(
        new.chars().count() >= 8,
        "password must have at least 8 characters"
    );
    {
        let s = WalletStore::open(WALLET_PATH, &old).map_err(|e| anyhow!("unlock failed: {e}"))?;
        ensure!(
            s.private_spend_attempts()?
                .iter()
                .all(|a| a.mined_in.is_some()),
            "finish or cancel pending sends before changing the password"
        );
    }
    let fresh = format!("{WALLET_DIR}/joker.wallet.new");
    files::remove(&fresh);
    WalletStore::recover_keys_to_fresh_wallet(WALLET_PATH, &old, &fresh, &new)?;
    files::rename(&fresh, WALLET_PATH)?;
    Ok(json!({ "changed": true, "requires_rescan": true }))
}

/// Rebuild the wallet from its own keys (same password). Clears the local
/// chain mirror and the send journal; the next sync rescans from genesis and
/// re-derives every note and spend from the chain. Used to release inputs held
/// by sends whose 12-block reference window expired without inclusion.
fn op_rescan(req: &Request) -> Result<Value> {
    let p = passphrase(req)?;
    WalletStore::open(WALLET_PATH, &p).map_err(|e| anyhow!("unlock failed: {e}"))?;
    let fresh = format!("{WALLET_DIR}/joker.wallet.new");
    files::remove(&fresh);
    WalletStore::recover_keys_to_fresh_wallet(WALLET_PATH, &p, &fresh, &p)?;
    files::rename(&fresh, WALLET_PATH)?;
    Ok(json!({ "rescan": true }))
}

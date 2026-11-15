// Joker Hegemon Extension Wallet — engine.
// Lives in the offscreen document: owns the unlocked session, talks to the
// Hegemon node, drives the Rust/WebAssembly core (sync, prove, submit) and
// broadcasts state to the popup.
import { NETWORK, DEFAULT_SETTINGS, FEES } from './lib/constants.js';
import { Rpc, RpcError, withBackoff } from './lib/rpc.js';
import { idbGet, idbSet, idbSetMany } from './lib/idb.js';
import { importKey, seal, unseal, openLegacyPhrase, randomSaltHex } from './lib/vault.js';
import { isPrivateUrl } from './lib/net.js';
import { compareVersions, formatHgn } from './lib/format.js';

// ------------------------------------------------------------------ state
const S = {
  ready: false,
  hasWallet: false,
  locked: true,
  address: null,
  settings: structuredClone(DEFAULT_SETTINGS),
  node: { online: false, checking: false },
  sync: { running: false, walletHeight: null, nodeHeight: null, phase: 'idle' },
  wallet: null, // last core status
  sends: [], // send metadata (persisted)
  recentBlocks: [],
  tor: { enabled: false, applied: false, verified: null },
  core: null,
  busy: null, // short label of the current foreground task
  lastError: null,
  unlockFailures: 0,
};
let passphrase = null; // only in memory, cleared on lock
let sessionKey = null; // AES-GCM key for stored history/phrase, cleared on lock
let lockTimer = null;
let authorityCache = null; // { at, value }
let seenPositions = new Set();
let syncPromise = null;
let manifestText = null;

const blockCache = new Map(); // height -> { hash, txCount, time }

// ------------------------------------------------------------------ helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const activeNode = () => S.settings.nodes[S.settings.activeNode] ?? S.settings.nodes[0];
// Fail closed: with Tor switched on, a request to a public node is only allowed
// once Chrome has confirmed that this extension's proxy rule is active.
function torBlock(url) {
  if (!S.settings.tor.enabled || isPrivateUrl(url) || S.tor.applied) return null;
  return `Tor is on but not active (${S.tor.reason ?? 'proxy not applied'}). Requests are blocked to protect your IP.`;
}
const rpcFor = (node, timeoutMs) => new Rpc(node.url, { timeoutMs, blocked: torBlock(node.url) });
const ACTIVE_PHASES = ['syncing', 'proving', 'waiting', 'submitting'];
const sendActive = () => S.sends.some((s) => ACTIVE_PHASES.includes(s.phase));
/** Amount text for notifications; empty when "Hide amounts" is on. */
const hgn = (atoms) => (S.settings.hideAmounts ? 'HGN' : `${formatHgn(atoms)} HGN`);
const rpc = (timeoutMs) => rpcFor(activeNode(), timeoutMs);

function publicState() {
  const { _lockAt, _lastFail, _initialScan, ...pub } = S;
  return {
    ...pub,
    settings: S.settings,
    network: NETWORK,
    sessionExpiresAt: lockTimer ? S._lockAt : null,
  };
}

let broadcastQueued = false;
function broadcast() {
  if (broadcastQueued) return;
  broadcastQueued = true;
  queueMicrotask(() => {
    broadcastQueued = false;
    chrome.runtime.sendMessage({ type: 'engine-state', state: publicState() }).catch(() => {});
  });
}

function toSw(cmd, args = {}) {
  return chrome.runtime.sendMessage({ to: 'sw', cmd, ...args }).catch(() => {});
}

function notify(kind, title, message) {
  if (!S.settings.notifications?.[kind]) return;
  toSw('notify', { title, message });
}

function badge() {
  let text = '';
  let color = '#0E1C36';
  if (!S.hasWallet) text = '';
  else if (!S.node.online) { text = '!'; color = '#FF4E4E'; }
  else if (S.sends.some((s) => ['proving', 'submitting', 'waiting'].includes(s.phase))) { text = '⇡'; color = '#F5A623'; }
  else if (S.sync.running && S.sync.nodeHeight - (S.sync.walletHeight ?? 0) > 3) { text = '…'; color = '#1BE7FF'; }
  else if (S.locked) { text = ''; }
  else { text = ''; color = '#19B37E'; }
  toSw('badge', { text, color, title: badgeTitle() });
}

function badgeTitle() {
  const n = S.node;
  const parts = ['Joker Hegemon Wallet'];
  parts.push(n.online ? `Node ${n.height?.toLocaleString?.() ?? ''} · ${n.peers ?? 0} peers` : 'Node offline');
  if (S.locked) parts.push('Locked');
  else if (S.sync.walletHeight != null) parts.push(`Wallet synced to ${S.sync.walletHeight.toLocaleString()}`);
  return parts.join('\n');
}

// Send history, address and scan position are private: stored only encrypted.
async function persistMeta() {
  if (!sessionKey) return;
  await idbSet('meta.sealed', await seal(sessionKey, {
    sends: S.sends,
    seen: [...seenPositions],
    address: S.address,
    lastTip: S.sync.walletHeight,
  }));
}

/** Ask the service worker to (re)apply the Tor proxy and record whether it took effect. */
async function applyProxy() {
  const r = await toSw('apply-proxy', { settings: S.settings });
  const res = r?.ok ? r.result : { applied: false, reason: 'service worker did not answer' };
  S.tor = { ...S.tor, enabled: S.settings.tor.enabled, applied: !!res?.applied, reason: res?.reason ?? null };
  if (!S.tor.applied) S.tor.verified = S.settings.tor.enabled ? false : null;
}

async function saveSettings() {
  await idbSet('settings', S.settings);
  await applyProxy();
}

// ------------------------------------------------------------------ core worker
let worker = null;
let workerSeq = 1;
const pending = new Map();
let coreChain = Promise.resolve();

function getWorker() {
  if (worker) return worker;
  worker = new Worker('core-worker.js', { type: 'module' });
  worker.onmessage = (ev) => {
    const p = pending.get(ev.data.id);
    if (p) { pending.delete(ev.data.id); p.resolve(ev.data); }
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'core worker failed'));
    pending.clear();
    worker = null;
  };
  return worker;
}

async function digest(bytes) {
  if (!bytes) return null;
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d)).join(',');
}

/** Serialised call into the core. Persists the wallet file when it changed. */
function core(op, extra = {}, { needPass = true } = {}) {
  const run = async () => {
    const walletBytes = (await idbGet('wallet')) ?? null;
    const request = { op, ...extra };
    if (needPass) {
      if (!passphrase && !extra.passphrase) throw new Error('Wallet is locked');
      request.passphrase ??= passphrase;
    }
    const id = workerSeq++;
    const res = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      getWorker().postMessage({ id, request, walletBytes: walletBytes ? walletBytes.slice() : null });
    });
    if (res.crashed) {
      // The wasm instance aborted; start clean on the next call.
      worker?.terminate();
      worker = null;
    }
    // Saved even when the reply is an error: the store persists durable steps
    // (e.g. a send reservation) before a later step can fail.
    if (res.walletBytes) {
      const [a, b] = await Promise.all([digest(walletBytes), digest(res.walletBytes)]);
      if (a !== b) {
        await idbSetMany([
          ['wallet', res.walletBytes],
          ['wallet.prev', walletBytes ?? undefined],
          ['walletSavedAt', now()],
        ]);
      }
    }
    if (!res.reply.ok) throw new Error(res.reply.error);
    return res.reply.result;
  };
  const p = coreChain.then(run, run);
  coreChain = p.catch(() => {});
  return p;
}

// ------------------------------------------------------------------ session
function touch() {
  if (!passphrase) return;
  clearTimeout(lockTimer);
  const ms = Math.max(1, S.settings.autoLockMinutes) * 60_000;
  S._lockAt = now() + ms;
  lockTimer = setTimeout(() => lock('auto'), ms);
}

function lock(reason = 'manual') {
  // A send in progress still needs the password for its next steps
  // (submission is recorded in the encrypted wallet file): finish it first.
  if (sendActive()) {
    if (reason !== 'auto') throw new Error('A send is in progress. Lock the wallet when it has been submitted.');
    clearTimeout(lockTimer);
    S._lockAt = now() + 60_000;
    lockTimer = setTimeout(() => lock('auto'), 60_000);
    return;
  }
  passphrase = null;
  sessionKey = null;
  clearTimeout(lockTimer);
  lockTimer = null;
  S.locked = true;
  S.wallet = null;
  // History and address stay on disk encrypted; nothing private remains in memory.
  S.sends = [];
  S.address = null;
  seenPositions = new Set();
  broadcast();
  badge();
}

/** Check the wallet password. Every password prompt shares one failure counter. */
async function verifyPassword(password) {
  if (S.unlockFailures >= 5) {
    const wait = Math.min(300, 2 ** (S.unlockFailures - 4)) * 1000;
    const left = wait - (now() - (S._lastFail ?? 0));
    if (left > 0) throw new Error(`Too many wrong passwords. Try again in ${Math.ceil(left / 1000)}s`);
  }
  if (typeof password !== 'string' || !password) throw new Error('Enter your password');
  try {
    await core('check', { passphrase: password }, { needPass: false });
  } catch (e) {
    if (!/unlock failed/i.test(e.message)) throw e;
    S.unlockFailures++;
    S._lastFail = now();
    throw new Error('Wrong password');
  }
  S.unlockFailures = 0;
}

async function deriveSessionKey(password, { fresh = false } = {}) {
  let salt = fresh ? null : await idbGet('kdfSalt');
  if (!salt) {
    salt = randomSaltHex();
    await idbSet('kdfSalt', salt);
  }
  const { key } = await core('kdf', { passphrase: password, salt }, { needPass: false });
  return importKey(key);
}

/** Load the encrypted history after unlock (and migrate data written by 0.2.0). */
async function loadMeta(password) {
  let meta = null;
  const sealedMeta = await idbGet('meta.sealed');
  // History is a convenience copy; the wallet file is the source of truth.
  // Unreadable history must never keep the user out of the wallet.
  if (sealedMeta) meta = await unseal(sessionKey, sealedMeta).catch(() => null);
  const legacyMeta = await idbGet('meta');
  if (!meta && legacyMeta) meta = legacyMeta;
  S.sends = meta?.sends ?? [];
  seenPositions = new Set(meta?.seen ?? []);
  S.address = meta?.address ?? null;
  S._initialScan = seenPositions.size === 0;
  // Sends cut off by a browser restart: nothing can still be running.
  for (const s of S.sends) {
    if (!ACTIVE_PHASES.includes(s.phase)) continue;
    if (s.attempt) {
      s.phase = 'uncertain';
      s.error = 'The browser closed before this send was confirmed. Use “Send again” to submit the same proof.';
    } else {
      s.phase = 'failed';
      s.error = 'The browser closed while the proof was being built. Nothing was sent.';
    }
  }
  const phrase = await idbGet('phrase');
  if (phrase && phrase.v === 1) {
    try {
      await idbSet('phrase', await seal(sessionKey, { phrase: await openLegacyPhrase(phrase, password) }));
    } catch { /* keep the old record; reveal will report it */ }
  }
  await persistMeta();
  if (legacyMeta) await idbSetMany([['meta', undefined]]);
}

async function unlock(password) {
  S.busy = 'Unlocking';
  broadcast();
  try {
    await verifyPassword(password);
    sessionKey = await deriveSessionKey(password);
    await loadMeta(password);
  } catch (e) {
    sessionKey = null;
    throw e;
  } finally {
    S.busy = null;
  }
  passphrase = password;
  S.locked = false;
  touch();
  if (!S.address) {
    const a = await core('address', { index: 0 });
    S.address = a.address;
    await persistMeta();
  }
  await refreshStatus();
  broadcast();
  kickSync();
}

async function refreshStatus() {
  const st = await core('status');
  applyStatus(st);
}

function applyStatus(st) {
  S.wallet = st;
  S.sync.walletHeight = st.tip?.height ?? null;
  // First status after create/restore: everything already on chain counts as seen.
  const firstRun = seenPositions.size === 0 && (S._initialScan ?? true);
  const changeHeights = new Set(st.attempts.filter((a) => a.mined_height != null).map((a) => a.mined_height));
  for (const n of st.notes) {
    if (seenPositions.has(n.position)) continue;
    seenPositions.add(n.position);
    n._new = true;
    const nearTip = S.sync.nodeHeight == null || S.sync.nodeHeight - n.created_height < 30;
    if (!firstRun && nearTip && !changeHeights.has(n.created_height) && n.asset === 0) {
      notify('received', 'HGN received', `${hgn(n.value)} in block ${n.created_height.toLocaleString()}`);
    }
  }
  reconcileSends();
}

// ------------------------------------------------------------------ wallet creation
async function createWallet({ mnemonic, entropyHex, password, restored }) {
  if ((await idbGet('wallet')) && S.hasWallet) throw new Error('A wallet already exists');
  S.busy = restored ? 'Restoring wallet' : 'Creating wallet';
  broadcast();
  try {
    const r = await core('create', { entropy: entropyHex, passphrase: password }, { needPass: false });
    sessionKey = await deriveSessionKey(password, { fresh: true });
    await idbSetMany([
      ['phrase', await seal(sessionKey, { phrase: mnemonic })],
      ['meta', undefined],
      ['meta.sealed', undefined],
      ['createdAt', now()],
      ['restored', !!restored],
    ]);
    S.hasWallet = true;
    S.address = r.address;
    S.sends = [];
    seenPositions = new Set();
    S._initialScan = true;
    await persistMeta();
    passphrase = password;
    S.locked = false;
    touch();
    await refreshStatus();
    S._initialScan = false;
  } finally {
    S.busy = null;
    broadcast();
  }
  kickSync();
}

// ------------------------------------------------------------------ node
async function loadManifest() {
  manifestText ??= await (await fetch('assets/network-manifest.json')).text();
  return manifestText;
}

/** Full node check: reachability, network identity, version, submit capability. */
async function checkNode(node = activeNode(), { quiet = false } = {}) {
  const r = rpcFor(node, 12_000);
  const out = { url: node.url, label: node.label, checkedAt: now(), checks: [] };
  const add = (id, ok, text) => out.checks.push({ id, ok, text });
  try {
    const [version, config, genesis, latest, consensus] = await r.batch([
      ['system_version'],
      ['hegemon_nodeConfig'],
      ['chain_getBlockHash', [0]],
      ['hegemon_latestBlock'],
      ['hegemon_consensusStatus'],
    ]);
    let methods = [];
    try {
      const m = await r.call('rpc_methods');
      methods = Array.isArray(m) ? m : m?.methods ?? [];
    } catch { /* optional */ }
    out.online = true;
    out.latencyMs = r.lastLatencyMs;
    out.version = String(version ?? '');
    out.height = latest.height;
    out.hash = latest.hash;
    out.timestamp = latest.timestamp;
    out.peers = consensus.peers;
    out.nodeSyncing = !!consensus.syncing;
    out.syncTarget = consensus.sync_target_height;
    out.rpcPolicy = config.rpcMethods;
    out.canSubmit = methods.includes('hegemon_submitAction') || /unsafe|public-submit/.test(String(config.rpcMethods));
    out.genesisOk = (genesis ?? '').toLowerCase() === NETWORK.genesis;
    out.chainOk = String(config.chainId).toLowerCase() === NETWORK.chainId;
    out.profileOk = config.networkProfile === NETWORK.profile;
    out.manifestOk = !!config.networkManifestDigest;
    out.networkOk = out.genesisOk && out.chainOk && out.profileOk;
    const vMatch = out.version.match(/\d+\.\d+\.\d+/)?.[0];
    out.versionOk = vMatch ? compareVersions(vMatch, NETWORK.minSoftware) >= 0 : null;
    add('reach', true, `Reachable in ${out.latencyMs} ms`);
    add('network', out.networkOk, out.networkOk ? 'Hegemon pre-mainnet v0.11 (genesis and chain ID match)' : 'Different network — genesis or chain ID does not match v0.11');
    add('sync', !out.nodeSyncing, out.nodeSyncing ? `Node is still syncing (target ${out.syncTarget ?? '?'})` : `Node at block ${out.height.toLocaleString()} with ${out.peers} peers`);
    add('version', out.versionOk !== false, out.versionOk === false
      ? `Node runs ${vMatch}; upgrade to ${NETWORK.minSoftware} before block ${NETWORK.upgradeHeight.toLocaleString()}`
      : `Software ${vMatch ?? out.version}`);
    add('submit', out.canSubmit, out.canSubmit ? 'Accepts private sends (hegemon_submitAction)' : 'Read-only node: sync works, sending needs --public-submit-rpc or --wallet-rpc');
    if (out.height < NETWORK.upgradeHeight && out.versionOk === false) {
      out.upgradeNotice = `Upgrade at block ${NETWORK.upgradeHeight.toLocaleString()} — ${(NETWORK.upgradeHeight - out.height).toLocaleString()} blocks left`;
    }
  } catch (e) {
    out.online = false;
    out.error = e.message;
    add('reach', false, `${e.message} — is the node running and allowed for this extension?`);
  }
  const entry = S.settings.nodes.find((n) => n.url === node.url);
  if (entry && out.online && entry.canSubmit !== out.canSubmit) {
    entry.canSubmit = out.canSubmit;
    idbSet('settings', S.settings).catch(() => {});
  }
  if (!quiet && node.url === activeNode().url) {
    const wasOnline = S.node.online;
    S.node = { ...S.node, ...out, checking: false };
    if (wasOnline && !out.online) notify('node', 'Hegemon node offline', `${node.label}: ${out.error}`);
    if (out.online) S.sync.nodeHeight = out.height;
    broadcast();
    badge();
  }
  return out;
}

async function authority(tipHeight) {
  if (!authorityCache || now() - authorityCache.at > 10 * 60_000 || authorityCache.url !== activeNode().url) {
    const r = rpc(20_000);
    const [config, params, genesis] = await r.batch([
      ['hegemon_nodeConfig'],
      ['hegemon_privateSpendParameters'],
      ['chain_getBlockHash', [0]],
    ]);
    if ((genesis ?? '').toLowerCase() !== NETWORK.genesis) throw new Error('Node is on a different Hegemon network (genesis mismatch)');
    authorityCache = {
      at: now(),
      url: activeNode().url,
      value: {
        manifest: await loadManifest(),
        expected_genesis: NETWORK.genesis,
        node_genesis: genesis,
        node_config: config,
        parameters: params,
      },
    };
  }
  return { ...authorityCache.value, tip_height: tipHeight };
}

// ------------------------------------------------------------------ sync
async function fetchHashes(r, heights) {
  const out = {};
  for (let i = 0; i < heights.length; i += 8) {
    const part = heights.slice(i, i + 8);
    const res = await withBackoff(() => r.batch(part.map((h) => ['chain_getBlockHash', [h]])), {
      onWait: (ms) => setPhase(`Node rate limit — waiting ${Math.round(ms / 1000)}s`),
    });
    part.forEach((h, k) => { if (res[k]) out[h] = res[k]; });
  }
  return out;
}

async function fetchBlocks(r, from, to) {
  const heights = [];
  for (let h = from; h <= to; h++) heights.push(h);
  const hashes = await fetchHashes(r, heights);
  const blocks = [];
  for (let i = 0; i < heights.length; i += 8) {
    const part = heights.slice(i, i + 8).filter((h) => hashes[h]);
    const first = await withBackoff(() => r.batch(part.map((h) => ['chain_getBlockActionsChunk', [hashes[h], 0]])), {
      onWait: (ms) => setPhase(`Node rate limit — waiting ${Math.round(ms / 1000)}s`),
    });
    for (let k = 0; k < part.length; k++) {
      const chunks = [first[k]];
      // A block body is at most 65 one-MiB chunks; never follow a larger claim.
      const count = Number.isInteger(first[k]?.chunk_count) ? Math.min(first[k].chunk_count, 66) : 1;
      for (let c = 1; c < count; c++) {
        chunks.push(await withBackoff(() => r.call('chain_getBlockActionsChunk', [hashes[part[k]], c])));
      }
      blocks.push({ height: part[k], hash: hashes[part[k]], chunks });
      blockCache.set(part[k], { hash: hashes[part[k]], txCount: first[k].tx_count });
    }
  }
  // Keep only a small window for the chain strip / mini explorer.
  for (const h of blockCache.keys()) if (h < to - 40) blockCache.delete(h);
  return blocks;
}

function setPhase(p) {
  S.sync.phase = p;
  broadcast();
}

async function syncOnce() {
  if (S.locked || !S.hasWallet) return;
  const node = await checkNode();
  if (!node.online) throw new Error(node.error);
  if (!node.networkOk) throw new Error('Node is not on Hegemon pre-mainnet v0.11');
  const r = rpc(60_000);
  S.sync.running = true;
  S.sync.startedAt ??= now();
  S.sync.error = null;
  setPhase('Checking wallet against node');
  badge();
  let walletTip = S.wallet?.tip?.height ?? 0;
  let target = node.height;
  const startHeight = walletTip;
  const t0 = now();
  let hashes = await fetchHashes(r, rangeDown(walletTip, 12));
  const batch = Math.max(8, S.settings.syncBatchBlocks | 0);
  for (let guard = 0; guard < 100_000; guard++) {
    const to = Math.min(target, walletTip + batch);
    setPhase(walletTip >= target ? 'Up to date' : `Downloading blocks ${(walletTip + 1).toLocaleString()}–${to.toLocaleString()}`);
    const blocks = to > walletTip ? await fetchBlocks(r, walletTip + 1, to) : [];
    if (blocks.length) setPhase(`Scanning blocks ${(walletTip + 1).toLocaleString()}–${to.toLocaleString()}`);
    let res;
    try {
      res = await core('sync', { authority: await authority(target), node_hashes: hashes, blocks });
    } catch (e) {
      if (!/fork detected|parent|contiguous/i.test(e.message) || guard > 50) throw e;
      // The chain moved under us: send fresh canonical hashes so the core can roll back.
      setPhase('Chain reorganised — re-checking recent blocks');
      hashes = await fetchHashes(r, rangeDown(walletTip, 24));
      const rb = await core('sync', { authority: await authority(target), node_hashes: hashes, blocks: [] });
      walletTip = rb.tip.height;
      if (rb.need_hash_at != null) {
        Object.assign(hashes, await fetchHashes(r, rangeDown(rb.need_hash_at, 24)));
      } else {
        if (rb.status) applyStatus(rb.status);
        hashes = { [walletTip]: rb.tip.hash.startsWith('0x') ? rb.tip.hash : '0x' + rb.tip.hash };
      }
      continue;
    }
    if (res.need_hash_at != null) {
      // Reorg deeper than the hashes we sent: fetch more history and retry.
      Object.assign(hashes, await fetchHashes(r, rangeDown(res.need_hash_at, 24)));
      walletTip = res.tip.height;
      continue;
    }
    if (res.rolled_back) notify('node', 'Chain reorganised', `Rolled back ${res.rolled_back} block(s) and resynced`);
    applyStatus(res.status);
    walletTip = res.tip.height;
    hashes = { [walletTip]: res.tip.hash.startsWith('0x') ? res.tip.hash : '0x' + res.tip.hash };
    const elapsed = (now() - t0) / 1000;
    const done = walletTip - startHeight;
    S.sync.blocksPerSec = elapsed > 0 ? done / elapsed : null;
    S.sync.etaSecs = S.sync.blocksPerSec ? (target - walletTip) / S.sync.blocksPerSec : null;
    S.sync.walletHeight = walletTip;
    broadcast();
    if (walletTip >= target) {
      // The node may have moved on while we scanned.
      const latest = await r.call('hegemon_latestBlock');
      S.sync.nodeHeight = latest.height;
      S.node.height = latest.height;
      S.node.hash = latest.hash;
      S.node.timestamp = latest.timestamp;
      if (latest.height <= walletTip) break;
      target = latest.height;
    }
  }
  if (startHeight + 20 < walletTip && S.wallet) {
    notify('confirmed', 'Wallet synced', `Synced to block ${walletTip.toLocaleString()}`);
  }
  S.sync.lastSyncAt = now();
  S.sync.startedAt = null;
  setPhase('Up to date');
  await persistMeta();
  refreshRecentBlocks().catch(() => {});
}

function rangeDown(h, n) {
  const out = [];
  for (let i = Math.max(0, h - n + 1); i <= h; i++) out.push(i);
  return out;
}

function kickSync() {
  if (syncPromise || S.locked) return syncPromise;
  syncPromise = syncOnce()
    .catch((e) => {
      S.sync.error = e.message;
      S.sync.phase = 'Sync paused';
    })
    .finally(() => {
      S.sync.running = false;
      syncPromise = null;
      broadcast();
      badge();
    });
  return syncPromise;
}

async function refreshRecentBlocks() {
  const tip = S.node.height;
  if (tip == null) return;
  const start = Math.max(0, tip - 11);
  let times = [];
  try {
    times = await rpc(10_000).call('hegemon_blockTimestamps', [start, tip]);
  } catch { /* optional */ }
  const tmap = new Map((times ?? []).map((t) => [t.height, t.timestamp_ms]));
  const list = [];
  for (let h = tip; h >= start; h--) {
    const c = blockCache.get(h) ?? {};
    list.push({ height: h, hash: c.hash ?? null, txCount: c.txCount ?? null, time: tmap.get(h) ?? null });
  }
  S.recentBlocks = list;
  broadcast();
}

// ------------------------------------------------------------------ sends
function reconcileSends() {
  if (!S.wallet?.tip) return;
  const tip = S.wallet.tip.height;
  for (const s of S.sends) {
    if (!s.attempt) continue;
    const a = S.wallet.attempts.find((x) => x.id === s.attempt);
    if (a?.mined_height != null) {
      const conf = tip - a.mined_height + 1;
      const first = s.phase !== 'confirmed';
      s.phase = 'confirmed';
      s.minedHeight = a.mined_height;
      s.confirmations = conf;
      if (first) notify('confirmed', s.kind === 'merge' ? 'Notes merged' : 'Send confirmed', `${hgn(s.amount)} included in block ${a.mined_height.toLocaleString()}`);
      if (conf >= S.settings.confirmationsTarget && !s.finalNotified) {
        s.finalNotified = true;
        notify('confirmed', 'Send final', `${S.settings.confirmationsTarget} confirmations for ${hgn(s.amount)}`);
      }
    } else if (a?.inputs_consumed) {
      s.phase = 'confirmed';
    } else if (s.referenceHeight != null && tip > s.referenceHeight + NETWORK.referenceWindow + 1 && !['failed', 'expired'].includes(s.phase)) {
      s.phase = 'expired';
      s.error = 'Not included within the 12-block window. Inputs stay held until you release them (Settings → Release held funds).';
      notify('failed', 'Send expired', `${hgn(s.amount)} was not included in time`);
    }
  }
  persistMeta().catch(() => {});
}

async function startSend({ recipient, amount, fee, positions, kind = 'send', note }) {
  if (sendActive()) throw new Error('Another send is in progress');
  const v = await core('validate_address', { address: recipient });
  if (!v.valid) throw new Error(`Recipient address: ${v.reason}`);
  if (!S.settings.nodes.some((n) => n.canSubmit)) throw new Error('None of your nodes accepts sends. Add one in Settings → Nodes (needs --public-submit-rpc or --wallet-rpc).');
  const meta = {
    localId: crypto.randomUUID(),
    kind,
    recipient,
    toSelf: recipient === S.address,
    amount: String(amount),
    fee: String(fee),
    note: note ?? '',
    createdAt: now(),
    phase: 'syncing',
    log: [{ t: now(), text: 'Syncing to the latest block' }],
  };
  S.sends.unshift(meta);
  broadcast();
  badge();
  runSend(meta, positions).catch(() => {});
  return meta.localId;
}

function step(meta, phase, text) {
  touch();
  meta.phase = phase;
  if (text) meta.log.push({ t: now(), text });
  broadcast();
  badge();
  persistMeta().catch(() => {});
}

async function runSend(meta, positions) {
  try {
    await (syncPromise ?? Promise.resolve());
    await syncOnce();
    const tip = S.wallet.tip.height;
    step(meta, 'proving', `Building the zero-knowledge proof on block ${tip.toLocaleString()} (stays on this device)`);
    meta.provingStartedAt = now();
    const res = await core('send', {
      authority: await authority(tip),
      recipient: meta.recipient,
      amount: meta.amount,
      fee: meta.fee,
      positions: positions ?? undefined,
    });
    meta.provingSecs = Math.round((now() - meta.provingStartedAt) / 1000);
    meta.attempt = res.attempt;
    meta.referenceHeight = res.reference_height;
    meta.change = res.change;
    meta.inputs = res.inputs;
    meta.actionBytes = res.action_bytes;
    step(meta, 'submitting', `Proof ready in ${meta.provingSecs}s (${Math.round(res.action_bytes / 1024)} KB)`);
    await refreshStatus();
    await submit(meta);
  } catch (e) {
    meta.error = e.message;
    step(meta, meta.attempt ? 'uncertain' : 'failed', e.message);
    notify('failed', 'Send failed', e.message);
  }
}

function pickStemNode() {
  const able = S.settings.nodes.filter((n) => n.canSubmit);
  const others = able.filter((n) => n.url !== activeNode().url);
  const list = others.length ? others : able.length ? able : [activeNode()];
  const rand = crypto.getRandomValues(new Uint32Array(1))[0];
  return list[rand % list.length];
}

async function submit(meta, { rebroadcast = false } = {}) {
  const tried = new Set();
  for (let attemptNo = 0; attemptNo < 3; attemptNo++) {
    const latest = await rpc(15_000).call('hegemon_latestBlock');
    if (meta.referenceHeight != null && latest.height + 1 > meta.referenceHeight + NETWORK.referenceWindow + 1) {
      throw new Error('The 12-block window for this proof has passed');
    }
    const req = await core('submit_request', { authority: await authority(latest.height), attempt: meta.attempt });
    const dand = S.settings.dandelion.enabled;
    let node = dand ? pickStemNode() : activeNode();
    if (tried.has(node.url)) node = S.settings.nodes.find((n) => n.canSubmit && !tried.has(n.url)) ?? node;
    tried.add(node.url);
    if (dand) {
      const { minDelay, maxDelay } = S.settings.dandelion;
      const wait = (minDelay + Math.random() * Math.max(0, maxDelay - minDelay)) * 1000;
      step(meta, 'waiting', `Dandelion stem: sending through ${node.label} in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
    step(meta, 'submitting', `${rebroadcast ? 'Re-sending the same proof' : 'Submitting'} to ${node.label}`);
    meta.node = node.label;
    try {
      const reply = await rpcFor(node, 180_000).call('hegemon_submitAction', [req.request]);
      if (reply?.success !== true) {
        throw new RpcError(`Node rejected the send: ${reply?.error ?? 'unknown reason'}`, { retry: false });
      }
      const ack = String(reply.tx_hash ?? reply.tx_id ?? '').replace(/^0x/, '').toLowerCase();
      if (ack !== req.expected_ack.toLowerCase()) throw new Error('Node acknowledged a different transaction id');
      const st = await core('mark_submitted', { attempt: meta.attempt, ack });
      meta.ack = ack;
      step(meta, 'submitted', `Accepted into the mempool of ${node.label}. Waiting for a block.`);
      applyStatus(st);
      return;
    } catch (e) {
      if (e instanceof RpcError && e.retry) {
        step(meta, 'submitting', `${e.message} — trying again`);
        await sleep(5_000 + Math.random() * 10_000);
        continue;
      }
      if (e instanceof RpcError && e.uncertain) {
        meta.error = 'Lost contact with the node — the send may still go through. The wallet keeps the same proof and watches the chain.';
        step(meta, 'uncertain', meta.error);
        return;
      }
      throw e;
    }
  }
  meta.error = 'Nodes are busy. Use “Send again” to retry the same proof.';
  step(meta, 'uncertain', meta.error);
}

async function cancelSend(localId) {
  const meta = S.sends.find((s) => s.localId === localId);
  if (!meta) return;
  if (meta.attempt && meta.phase !== 'failed') {
    try {
      applyStatus(await core('cancel', { attempt: meta.attempt }));
    } catch (e) {
      throw new Error(`This send was already handed to the network and cannot be cancelled (${e.message})`);
    }
  }
  S.sends = S.sends.filter((s) => s !== meta);
  await persistMeta();
  broadcast();
}

// ------------------------------------------------------------------ tor
async function testTor() {
  await applyProxy();
  if (S.settings.tor.enabled && !S.tor.applied) {
    S.tor = { ...S.tor, verified: false, error: S.tor.reason };
    broadcast();
    return S.tor;
  }
  S.tor = { ...S.tor, verified: null, checking: true };
  broadcast();
  try {
    const res = await fetch('https://check.torproject.org/api/ip', { cache: 'no-store', credentials: 'omit' });
    const j = await res.json();
    S.tor = { ...S.tor, checking: false, verified: !!j.IsTor, ip: j.IP, checkedAt: now(), error: null };
  } catch (e) {
    S.tor = { ...S.tor, checking: false, verified: false, error: `Tor proxy not reachable at ${S.settings.tor.host}:${S.settings.tor.port}` };
  }
  broadcast();
  return S.tor;
}

// ------------------------------------------------------------------ commands
function requireUnlocked() {
  if (S.locked || !passphrase) throw new Error('Wallet is locked');
}

const commands = {
  async getState() { return publicState(); },
  async ping() { return true; },
  async unlock({ password }) { await unlock(password); return publicState(); },
  async lock() { lock('manual'); return publicState(); },
  async create(args) { await createWallet(args); return publicState(); },
  async syncNow() { touch(); kickSync(); return true; },
  async checkNode({ node }) { return checkNode(node ?? activeNode(), { quiet: !!node }); },
  async validateAddress({ address }) { return core('validate_address', { address }, { needPass: false }); },
  async send(args) {
    requireUnlocked();
    touch();
    await verifyPassword(args.password);
    const amount = BigInt(args.amount);
    const fee = BigInt(args.fee);
    if (amount <= 0n || fee < 0n) throw new Error('Invalid amount');
    return startSend({ recipient: String(args.recipient).trim(), note: String(args.note ?? '').slice(0, 80), amount, fee });
  },
  async merge({ password, positions }) {
    requireUnlocked();
    touch();
    await verifyPassword(password);
    if (!Array.isArray(positions) || positions.length !== 2) throw new Error('Pick two notes to merge');
    const notes = (S.wallet?.notes ?? []).filter((n) => positions.includes(n.position) && !n.spent);
    if (notes.length !== 2) throw new Error('Those notes are no longer available');
    const total = notes.reduce((a, n) => a + BigInt(n.value), 0n);
    const fee = FEES[S.settings.feePreset] ?? FEES.normal;
    if (total <= fee) throw new Error('These notes are smaller than the fee');
    return startSend({ recipient: S.address, amount: total - fee, fee, positions, kind: 'merge' });
  },
  async rebroadcast({ localId }) {
    requireUnlocked();
    if (sendActive()) throw new Error('Another send is in progress');
    const meta = S.sends.find((s) => s.localId === localId);
    if (!meta?.attempt) throw new Error('Nothing to send again');
    submit(meta, { rebroadcast: true }).catch((e) => step(meta, 'uncertain', e.message));
    return true;
  },
  async cancelSend({ localId }) { requireUnlocked(); await cancelSend(localId); return true; },
  async dismissSend({ localId }) { requireUnlocked(); S.sends = S.sends.filter((s) => s.localId !== localId); await persistMeta(); broadcast(); return true; },
  async revealPhrase({ password }) {
    requireUnlocked();
    touch();
    await verifyPassword(password);
    const sealed = await idbGet('phrase');
    if (!sealed) throw new Error('No recovery phrase stored in this extension');
    return (await unseal(sessionKey, sealed)).phrase;
  },
  async changePassword({ password, newPassword }) {
    requireUnlocked();
    await verifyPassword(password);
    if (sendActive()) throw new Error('Finish the send in progress first');
    if (typeof newPassword !== 'string' || newPassword.length < 8) throw new Error('Use at least 8 characters.');
    const sealed = await idbGet('phrase');
    const phrase = sealed ? (await unseal(sessionKey, sealed)).phrase : null;
    await core('change_passphrase', { passphrase: password, new_passphrase: newPassword }, { needPass: false });
    // Everything stored by the extension moves to a key from the new password.
    sessionKey = await deriveSessionKey(newPassword, { fresh: true });
    if (phrase) await idbSet('phrase', await seal(sessionKey, { phrase }));
    passphrase = newPassword;
    seenPositions = new Set(S.wallet?.notes?.map((n) => n.position) ?? []);
    await persistMeta();
    await refreshStatus();
    kickSync();
    return true;
  },
  async releaseHeld({ password }) {
    requireUnlocked();
    await verifyPassword(password);
    if (sendActive()) throw new Error('Finish the send in progress first');
    const unmined = (S.wallet?.attempts ?? []).filter((a) => a.mined_height == null);
    const tip = S.wallet?.tip?.height ?? 0;
    const live = S.sends.filter((s) => unmined.some((a) => a.id === s.attempt) && s.referenceHeight != null && tip <= s.referenceHeight + NETWORK.referenceWindow + 1);
    if (live.length) throw new Error('A send is still inside its 12-block window. Wait until it confirms or expires.');
    await core('rescan', { passphrase: password }, { needPass: false });
    S.sends = S.sends.filter((s) => s.phase === 'confirmed');
    await refreshStatus();
    kickSync();
    return true;
  },
  async exportBackup() {
    requireUnlocked();
    const bytes = await idbGet('wallet');
    if (!bytes) throw new Error('No wallet');
    return { bytes: Array.from(bytes), name: `joker-hegemon-${new Date().toISOString().slice(0, 10)}.wallet` };
  },
  async wipe({ password, confirm }) {
    // Forgot-password path: explicit typed confirmation instead of the password.
    if (confirm !== undefined) {
      if (confirm !== 'ERASE') throw new Error('Type ERASE to confirm');
    } else {
      await verifyPassword(password);
    }
    if (sendActive()) throw new Error('A send is in progress. Wait until it has been submitted.');
    if (!S.locked) lock('manual');
    await idbSetMany([
      ['wallet', undefined], ['wallet.prev', undefined], ['phrase', undefined],
      ['meta', undefined], ['meta.sealed', undefined], ['kdfSalt', undefined],
    ]);
    Object.assign(S, { hasWallet: false, address: null, wallet: null, sends: [] });
    S.sync = { running: false, walletHeight: null, nodeHeight: S.node.height, phase: 'idle' };
    seenPositions = new Set();
    broadcast();
    badge();
    return true;
  },
  async setSettings({ patch }) {
    // With a wallet present, settings (node, Tor, lock time) change only while unlocked.
    if (S.hasWallet && S.locked) throw new Error('Unlock the wallet to change settings');
    const allowed = ['nodes', 'activeNode', 'tor', 'dandelion', 'autoLockMinutes', 'hideAmounts', 'notifications', 'feePreset', 'confirmationsTarget'];
    patch = Object.fromEntries(Object.entries(patch ?? {}).filter(([k]) => allowed.includes(k)));
    const before = JSON.stringify([S.settings.nodes[S.settings.activeNode], S.settings.tor]);
    S.settings = { ...S.settings, ...patch };
    await saveSettings();
    touch();
    const after = JSON.stringify([S.settings.nodes[S.settings.activeNode], S.settings.tor]);
    if (before !== after) {
      authorityCache = null;
      checkNode().then(() => kickSync());
    }
    broadcast();
    badge();
    return S.settings;
  },
  async testTor() { return testTor(); },
  async touch() { touch(); return true; },
  async tick() {
    // Called by the service worker alarm.
    // Re-confirm the Tor proxy each minute: another extension may have taken it over.
    if (S.settings.tor.enabled) { await applyProxy(); broadcast(); }
    if (S.locked) { await checkNode().catch(() => {}); return true; }
    for (const s of S.sends) if (s.phase === 'submitted' || s.phase === 'uncertain') reconcileSends();
    kickSync();
    return true;
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Only this extension's own pages (popup, service worker) may command the engine.
  if (sender.id !== chrome.runtime.id || msg?.to !== 'engine') return false;
  const fn = commands[msg.cmd];
  if (!fn) { reply({ ok: false, error: `unknown command ${msg.cmd}` }); return false; }
  Promise.resolve()
    .then(() => fn(msg.args ?? {}))
    .then((result) => reply({ ok: true, result }))
    .catch((e) => reply({ ok: false, error: e.message ?? String(e) }));
  return true;
});

// ------------------------------------------------------------------ boot
(async () => {
  const saved = await idbGet('settings');
  if (saved) S.settings = { ...structuredClone(DEFAULT_SETTINGS), ...saved };
  S.hasWallet = !!(await idbGet('wallet'));
  try { S.core = await core('version', {}, { needPass: false }); } catch (e) { S.core = { error: e.message }; }
  // The proxy state must be known before the first request to a node.
  await applyProxy();
  S.ready = true;
  broadcast();
  checkNode().catch(() => {}).finally(() => { badge(); refreshRecentBlocks().catch(() => {}); });
})();

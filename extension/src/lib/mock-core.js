// DEVELOPMENT ONLY — never shipped in release builds (excluded unless built with --mock).
// Imitates the core's JSON replies so the UI can be exercised without the wasm build.
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const dec = new TextDecoder();
const fakeAddr = (seed) => {
  const cs = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  let s = 'shca1';
  let x = seed;
  for (let i = 0; i < 2051; i++) { x = (x * 1103515245 + 12345) >>> 0; s += cs[x % 32]; }
  return s;
};

export async function runMock(req, bytes) {
  let st = bytes ? JSON.parse(dec.decode(bytes)) : null;
  const save = () => enc.encode(JSON.stringify(st));
  const ok = (result) => ({ reply: { ok: true, result }, walletBytes: st ? save() : null });
  const fail = (error) => ({ reply: { ok: false, error }, walletBytes: bytes ?? null });
  const status = () => ({
    tip: st.tip,
    balance: {
      synced_height: st.tip.height,
      available: { atoms: String(st.notes.filter((n) => !n.spent && !n.reserved).reduce((a, n) => a + Number(n.value), 0)), notes: st.notes.filter((n) => !n.spent).length },
      reserved: { atoms: String(st.notes.filter((n) => n.reserved && !n.spent).reduce((a, n) => a + Number(n.value), 0)), notes: 0 },
      immature: { atoms: '400000000', notes: 1 },
      next_maturity_height: st.tip.height + 37,
      blocks_until_next_maturity: 36,
      htlc: { atoms: '0', notes: 0 }, policy: { atoms: '0', notes: 0 }, treasury_value: { atoms: '0', notes: 0 },
      accumulator_notes: 0, other_assets: {},
    },
    notes: st.notes,
    attempts: st.attempts,
  });
  if (req.op === 'version') return ok({ core: '0.1.0-mock', relation_digest: 'mock', address_version: 5 });
  if (req.op === 'exists') return ok({ exists: !!st });
  if (req.op === 'create') {
    if (st) return fail('a wallet already exists in this extension');
    st = { pass: req.passphrase, tip: { height: 0, hash: '00'.repeat(32) }, notes: [], attempts: [], seed: parseInt(req.entropy.slice(0, 6), 16) };
    return ok({ index: 0, address: fakeAddr(st.seed) });
  }
  if (!st) return fail('no wallet');
  if (req.passphrase !== st.pass) return fail('unlock failed: wallet decryption failed');
  await delay(250);
  switch (req.op) {
    case 'check': return ok({ unlocked: true });
    case 'kdf': return ok({ key: Array.from(enc.encode((req.passphrase + req.salt).padEnd(32, '.')).slice(0, 32), (b) => b.toString(16).padStart(2, '0')).join('') });
    case 'address': return ok({ index: req.index ?? 0, address: fakeAddr(st.seed + (req.index ?? 0)) });
    case 'validate_address':
      return ok(/^shca1[02-9ac-hj-np-z]{100,}$/.test(req.address?.trim() ?? '') ? { valid: true } : { valid: false, reason: 'invalid bech32m address' });
    case 'status': return ok(status());
    case 'sync': {
      const h = st.tip.height;
      if (!(h in (req.node_hashes ?? {}))) return ok({ need_hash_at: h, tip: st.tip, rolled_back: 0 });
      let rec = 0;
      for (const b of req.blocks) {
        if (b.height !== st.tip.height + 1) continue;
        st.tip = { height: b.height, hash: b.hash.replace(/^0x/, '') };
        if (b.height % 97 === 0 || b.height === 18_590) {
          st.notes.push({ kind: 'ordinary', position: st.notes.length * 3 + 7, value: String(150_000_000 + (b.height % 7) * 12_500_000), asset: 0, created_height: b.height, created_block: st.tip.hash, spent: false });
          rec++;
        }
        for (const a of st.attempts) if (!a.mined_height && b.height >= a._mineAt) { a.mined_height = b.height; a.mined_block = st.tip.hash; a.inputs_consumed = true; a.status = 'Submitted'; for (const n of st.notes) if (a._inputs.includes(n.position)) { n.spent = true; n.reserved = false; } }
      }
      return ok({ tip: st.tip, applied: req.blocks.length, recovered: rec, spent: 0, rolled_back: 0, status: status() });
    }
    case 'send': {
      const need = BigInt(req.amount) + BigInt(req.fee);
      const c = st.notes.filter((n) => !n.spent && !n.reserved).sort((a, b) => Number(a.value) - Number(b.value));
      const one = c.find((n) => BigInt(n.value) >= need);
      const set = req.positions ? c.filter((n) => req.positions.includes(n.position)) : one ? [one] : c.slice(-2);
      const total = set.reduce((a, n) => a + BigInt(n.value), 0n);
      if (total < need) return fail('no one or two notes cover this amount — use \'Merge notes\' first (a PrivateSpend has two input slots)');
      await delay(6000); // "proving"
      set.forEach((n) => (n.reserved = true));
      const id = Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, '0')).join('');
      st.attempts.push({ id, status: 'Candidate', mined_height: null, mined_block: null, inputs_consumed: false, _inputs: set.map((n) => n.position), _mineAt: st.tip.height + 2 });
      const change = total - need;
      if (change > 0n) st.notes.push({ kind: 'ordinary', position: 9000 + st.notes.length, value: String(change), asset: 0, created_height: st.tip.height + 2, created_block: '', spent: false, reserved: false, _pendingChange: true });
      return ok({ attempt: id, inputs: set.map((n) => n.position), change: String(change), reference_height: st.tip.height, action_bytes: 176_412 });
    }
    case 'submit_request': {
      const a = st.attempts.find((x) => x.id === req.attempt);
      a.status = 'SubmissionUncertain';
      return ok({ attempt: a.id, expected_ack: 'ab'.repeat(48), request: { family_id: 1, action_id: 15 } });
    }
    case 'mark_submitted': { const a = st.attempts.find((x) => x.id === req.attempt); a.status = 'Submitted'; return ok(status()); }
    case 'cancel': st.attempts = st.attempts.filter((x) => x.id !== req.attempt); return ok(status());
    case 'change_passphrase': st.pass = req.new_passphrase; st.tip = { height: 0, hash: '00'.repeat(32) }; st.notes = []; return ok({ changed: true, requires_rescan: true });
    case 'rescan': st.tip = { height: 0, hash: '00'.repeat(32) }; st.notes = []; st.attempts = []; return ok({ rescan: true });
    default: return fail('unknown op ' + req.op);
  }
}

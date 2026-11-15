import { ATOMS_PER_HGN, HGN_DECIMALS } from './constants.js';

/** atoms (bigint|string|number) -> "12.3456 HGN" style string (no unit). */
export function formatHgn(atoms, { maxDecimals = HGN_DECIMALS, minDecimals = 2 } = {}) {
  const a = BigInt(atoms ?? 0);
  const neg = a < 0n;
  const v = neg ? -a : a;
  const whole = v / ATOMS_PER_HGN;
  let frac = (v % ATOMS_PER_HGN).toString().padStart(HGN_DECIMALS, '0').slice(0, maxDecimals);
  frac = frac.replace(/0+$/, '');
  if (frac.length < minDecimals) frac = frac.padEnd(minDecimals, '0');
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '−' : ''}${w}${frac ? '.' + frac : ''}`;
}

/** "1.5" -> 150000000n ; throws on bad input */
export function parseHgn(text) {
  const t = String(text).trim().replace(/,/g, '');
  if (!/^\d+(\.\d{0,8})?$/.test(t)) throw new Error('Enter an amount like 1.25 (up to 8 decimals)');
  const [w, f = ''] = t.split('.');
  return BigInt(w) * ATOMS_PER_HGN + BigInt(f.padEnd(HGN_DECIMALS, '0'));
}

export function shortAddr(addr, head = 12, tail = 8) {
  if (!addr) return '';
  return addr.length <= head + tail + 1 ? addr : `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function shortHash(h, n = 8) {
  if (!h) return '';
  const s = h.startsWith('0x') ? h.slice(2) : h;
  return `${s.slice(0, n)}…${s.slice(-4)}`;
}

export function timeAgo(ms) {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function duration(secs) {
  secs = Math.max(0, Math.round(secs));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

export function compareVersions(a, b) {
  const pa = String(a).match(/\d+/g)?.map(Number) ?? [];
  const pb = String(b).match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const hexToBytes = (h) => {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
};

// Encryption for the extension's own data at rest: the copy of the 24-word
// recovery phrase and the send history / wallet metadata.
//
// The key is derived from the wallet password by the Rust core with Argon2id
// (same KDF and parameters as Hegemon's wallet file, separate random salt), so
// nothing stored here is easier to brute-force than the wallet file itself.
// Data is sealed with AES-256-GCM (fresh random IV per write).
const enc = new TextEncoder();
const dec = new TextDecoder();

export const randomSaltHex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/** Import the 32-byte Argon2id key (hex) as a non-extractable AES-GCM key. */
export async function importKey(hex) {
  const raw = new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
  try {
    return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } finally {
    raw.fill(0);
  }
}

export async function seal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
  return { v: 2, iv: Array.from(iv), ct: Array.from(new Uint8Array(ct)) };
}

export async function unseal(key, sealed) {
  if (sealed?.v !== 2) throw new Error('Unknown stored data format');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(sealed.iv) }, key, new Uint8Array(sealed.ct));
  return JSON.parse(dec.decode(pt));
}

/** Read a version-1 phrase record (PBKDF2), written by 0.2.0. Used once to migrate. */
export async function openLegacyPhrase(sealed, password) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(sealed.salt), iterations: sealed.iter },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(sealed.iv) }, key, new Uint8Array(sealed.ct));
  return dec.decode(pt);
}

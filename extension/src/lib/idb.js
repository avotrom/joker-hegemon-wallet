// Tiny IndexedDB key/value store for the encrypted wallet file and metadata.
const DB = 'joker-hegemon';
const STORE = 'kv';

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const r = fn(s);
    t.oncomplete = () => { d.close(); resolve(r?.result); };
    t.onerror = () => { d.close(); reject(t.error); };
    t.onabort = () => { d.close(); reject(t.error); };
  });
}

export const idbGet = (k) => tx('readonly', (s) => s.get(k));
export const idbSet = (k, v) => tx('readwrite', (s) => s.put(v, k));
export const idbDel = (k) => tx('readwrite', (s) => s.delete(k));

/** Atomically write several keys in one transaction. */
export const idbSetMany = (entries) =>
  tx('readwrite', (s) => {
    for (const [k, v] of entries) v === undefined ? s.delete(k) : s.put(v, k);
  });

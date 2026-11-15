import { RPC_ADMISSION } from './constants.js';

export class RpcError extends Error {
  constructor(message, { code, data, method, retry = false, uncertain = false } = {}) {
    super(message);
    this.code = code;
    this.data = data;
    this.method = method;
    this.retry = retry;
    this.uncertain = uncertain;
  }
}

let nextId = 1;

// A batch of 8 one-MiB block-body chunks is about 17 MB of hex; anything far
// beyond that is not a valid reply and must not exhaust memory.
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;

async function readCapped(res, limit) {
  const reader = res.body?.getReader();
  if (!reader) return res.text();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      reader.cancel().catch(() => {});
      throw Object.assign(new Error('too large'), { tooLarge: true });
    }
    parts.push(value);
  }
  return new TextDecoder().decode(await new Blob(parts).arrayBuffer());
}

/** JSON-RPC 2.0 over HTTP POST (Hegemon native RPC is plaintext HTTP JSON-RPC). */
export class Rpc {
  constructor(url, { timeoutMs = 20_000, blocked = null } = {}) {
    this.url = url.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.lastLatencyMs = null;
    // When set, no request leaves the browser (e.g. Tor is on but not applied).
    this.blocked = blocked;
  }

  async _post(body, timeoutMs, method) {
    if (this.blocked) throw new RpcError(this.blocked, { method, retry: false, uncertain: false });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? this.timeoutMs);
    const t0 = performance.now();
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
    } catch (e) {
      clearTimeout(timer);
      // A lost connection does not prove the request was rejected.
      throw new RpcError(e.name === 'AbortError' ? 'Node did not answer in time' : 'Node unreachable', {
        method,
        uncertain: true,
      });
    }
    this.lastLatencyMs = Math.round(performance.now() - t0);
    let text;
    try {
      text = await readCapped(res, MAX_RESPONSE_BYTES);
    } catch (e) {
      ctrl.abort();
      throw new RpcError(e.tooLarge ? 'Node sent an oversized response' : 'Connection to the node was lost', { method, uncertain: true });
    } finally {
      clearTimeout(timer);
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new RpcError(`Node replied HTTP ${res.status} without JSON`, { method, uncertain: res.ok });
    }
    return json;
  }

  static _unwrap(json, method) {
    if (json.error) {
      const a = RPC_ADMISSION[json.error.code];
      throw new RpcError(a?.text ?? json.error.message ?? 'RPC error', {
        code: json.error.code,
        data: json.error.data,
        method,
        retry: a?.retry ?? false,
        uncertain: a?.uncertain ?? false,
      });
    }
    return json.result;
  }

  async call(method, params = [], { timeoutMs } = {}) {
    const json = await this._post({ jsonrpc: '2.0', id: nextId++, method, params }, timeoutMs, method);
    return Rpc._unwrap(json, method);
  }

  /** Batch of at most 8 calls (public-submit node limit). Returns results in order. */
  async batch(calls, { timeoutMs } = {}) {
    if (!calls.length) return [];
    if (calls.length > 8) throw new Error('batch too large');
    const body = calls.map(([method, params]) => ({ jsonrpc: '2.0', id: nextId++, method, params: params ?? [] }));
    const json = await this._post(body, timeoutMs, 'batch');
    if (!Array.isArray(json)) return [Rpc._unwrap(json, 'batch')];
    const byId = new Map(json.map((r) => [r.id, r]));
    return body.map((b) => Rpc._unwrap(byId.get(b.id) ?? { error: { message: 'missing batch reply' } }, b.method));
  }
}

/** Run fn with exponential backoff on retryable admission errors. */
export async function withBackoff(fn, { tries = 6, baseMs = 2_000, onWait } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!(e instanceof RpcError) || !e.retry) throw e;
      const wait = baseMs * 2 ** i + Math.random() * 500;
      onWait?.(wait, e);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

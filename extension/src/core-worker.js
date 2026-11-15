// Runs the Joker core (pure Rust → WebAssembly via wasm-bindgen) in a Web Worker,
// so syncing and minutes-long proofs never block the extension UI.
//
// Protocol (from offscreen.js):  { id, request, walletBytes }
//                         reply:  { id, reply, walletBytes, crashed? }
// The encrypted wallet file is passed in and returned as bytes; the core keeps
// nothing between calls.
import init, { call } from '../../core/pkg/joker_core.js';

let ready = null;
const boot = () =>
  (ready ??= init({ module_or_path: new URL('./joker_core_bg.wasm', self.location.href) }));

self.onmessage = async (ev) => {
  const { id, request, walletBytes } = ev.data;
  if (typeof __MOCK__ !== 'undefined' && __MOCK__) {
    const { runMock } = await import('./lib/mock-core.js');
    const out = await runMock(request, walletBytes);
    self.postMessage({ id, ...out });
    return;
  }
  try {
    await boot();
    const out = call(JSON.stringify(request), walletBytes ?? undefined);
    const reply = JSON.parse(out.reply);
    const bytes = out.wallet ?? null;
    out.free();
    self.postMessage({ id, reply, walletBytes: bytes }, bytes ? [bytes.buffer] : []);
  } catch (e) {
    // A Rust panic aborts the instance (wasm "unreachable"); its memory is no
    // longer usable, so ask the engine to start a fresh worker. The saved
    // wallet file is untouched because nothing was written back.
    self.postMessage({
      id,
      crashed: true,
      reply: { ok: false, error: `wallet core stopped: ${e?.message ?? e}` },
      walletBytes: null,
    });
  }
};

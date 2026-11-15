const { chromium } = require('playwright');
const path = '/home/claude/joker-hegemon-wallet/dist-mock';
const PW = 'correct horse 9!';
const out = [];
const check = (n, ok, x = '') => out.push(`${ok ? 'PASS' : 'FAIL'} | ${n} | ${x}`);
async function launch() {
  const ctx = await chromium.launchPersistentContext('/tmp/claude-0/ui/profile-send', { channel: 'chromium', headless: true, viewport: { width: 380, height: 600 },
    args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`] });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${sw.url().split('/')[2]}/popup.html`);
  const eng = (cmd, args) => page.evaluate(([c, a]) => chrome.runtime.sendMessage({ to: 'engine', cmd: c, args: a }), [cmd, args]);
  return { ctx, page, eng };
}
const waitFor = async (eng, pred, ms = 60000) => { const t = Date.now(); for (;;) { const s = (await eng('getState')).result; if (pred(s)) return s; if (Date.now() - t > ms) return s; await new Promise((r) => setTimeout(r, 500)); } };
(async () => {
  let { ctx, page, eng } = await launch();
  await page.waitForSelector('text=Create a new wallet', { timeout: 20000 });
  const words = 'abandon '.repeat(23) + 'art';
  const c = await eng('create', { mnemonic: words, entropyHex: '00'.repeat(32), password: PW, restored: true });
  check('create', c.ok, c.error);
  let s = await waitFor(eng, (s) => s.sync.phase === 'Up to date' && BigInt(s.wallet?.balance?.available?.atoms ?? 0) > 0n);
  check('synced with balance', BigInt(s.wallet.balance.available.atoms) > 0n, s.sync.error ?? s.sync.phase);
  await eng('setSettings', { patch: { dandelion: { enabled: true, minDelay: 1, maxDelay: 2 } } });
  const bad = await eng('send', { password: 'wrong', recipient: s.address, amount: '50000000', fee: '1000' });
  check('send needs the right password', bad.ok === false);
  const id = await eng('send', { password: PW, recipient: s.address, amount: '50000000', fee: '1000', note: 'test' });
  check('send accepted', id.ok, id.error);
  const lockTry = await eng('lock');
  check('manual lock refused during a send', lockTry.ok === false, lockTry.error);
  const second = await eng('send', { password: PW, recipient: s.address, amount: '1000', fee: '1000' });
  check('second concurrent send refused', second.ok === false, second.error);
  s = await waitFor(eng, (s) => ['submitted', 'confirmed', 'failed', 'uncertain'].includes(s.sends[0]?.phase), 90000);
  check('send reaches submitted/confirmed', ['submitted', 'confirmed'].includes(s.sends[0].phase), `${s.sends[0].phase} ${s.sends[0].error ?? ''}`);
  check('ack recorded and matches', s.sends[0].ack === 'ab'.repeat(48));

  // interrupted send: start, then kill the browser mid-proof
  const id2 = await eng('send', { password: PW, recipient: s.address, amount: '2000', fee: '1000' });
  check('second send starts', id2.ok, id2.error);
  await waitFor(eng, (s) => s.sends[0]?.phase === 'proving', 20000);
  await ctx.close();
  ({ ctx, page, eng } = await launch());
  await page.waitForSelector('#unlockpw', { timeout: 20000 });
  const st0 = (await eng('getState')).result;
  check('after restart: locked, no history in memory', st0.locked && st0.sends.length === 0);
  const un = await eng('unlock', { password: PW });
  check('unlock after restart', un.ok, un.error);
  const st1 = (await eng('getState')).result;
  const cut = st1.sends.find((x) => x.localId === id2.result);
  check('interrupted send marked failed, not stuck', cut?.phase === 'failed', cut?.phase);
  const again = await eng('send', { password: PW, recipient: st1.address, amount: '2000', fee: '1000' });
  check('new send possible after an interrupted one', again.ok, again.error);
  console.log(out.join('\n'));
  console.log(out.every((l) => l.startsWith('PASS')) ? 'ALL PASS' : 'SOME FAILED');
  await ctx.close();
})().catch((e) => { console.log(out.join('\n')); console.error('FAIL', e.message); process.exit(1); });

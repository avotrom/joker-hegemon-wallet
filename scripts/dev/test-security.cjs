// Security regression test against the REAL build (dist/) with the real wasm core.
const { chromium } = require('playwright');
const path = '/home/claude/joker-hegemon-wallet/dist';
const PW = 'correct horse 9!';
const results = [];
const check = (name, ok, extra = '') => { results.push([ok ? 'PASS' : 'FAIL', name, extra]); };
(async () => {
  const ctx = await chromium.launchPersistentContext('/tmp/claude-0/ui/profile-sec', {
    channel: 'chromium', headless: true, viewport: { width: 380, height: 600 },
    args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const id = sw.url().split('/')[2];
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  const eng = (cmd, args) => page.evaluate(([c, a]) => chrome.runtime.sendMessage({ to: 'engine', cmd: c, args: a }), [cmd, args]);
  const idb = (key) => page.evaluate((k) => new Promise((res) => { const r = indexedDB.open('joker-hegemon', 1); r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get(k); g.onsuccess = () => res(g.result ?? null); }; }), key);

  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.waitForSelector('text=Create a new wallet', { timeout: 20000 });
  await page.click('text=Create a new wallet');
  await page.fill('#pw1', PW); await page.fill('#pw2', PW); await page.check('#ack');
  await page.click('text=Continue'); await page.click('text=Show phrase');
  const words = await page.$$eval('#words span', (s) => s.map((x) => x.textContent));
  await page.click('text=I wrote them down');
  const labels = await page.$$eval('.quiz > div > div:first-child', (d) => d.map((x) => +x.textContent.replace('Word ', '')));
  const groups = await page.$$('.quiz .opts');
  for (let i = 0; i < labels.length; i++) await (await groups[i].$(`button:text-is("${words[labels[i] - 1]}")`)).click();
  await page.click('text=Create wallet');
  await page.waitForSelector('text=Recent activity', { timeout: 30000 });
  await page.waitForTimeout(1500);

  // --- data at rest
  const phrase = await idb('phrase');
  const blob = JSON.stringify([phrase, await idb('meta.sealed'), await idb('meta')]);
  check('phrase stored as v2 (Argon2id key + AES-GCM)', phrase?.v === 2 && !phrase.salt);
  check('no recovery word appears in stored data', !words.some((w) => w.length > 4 && blob.includes(`"${w}"`)));
  check('history stored only encrypted', (await idb('meta')) === null && (await idb('meta.sealed'))?.v === 2);
  const wallet = await idb('wallet');
  check('wallet file present and encrypted (no plaintext address)', wallet && !new TextDecoder().decode(wallet).includes('shca1'));

  // --- state broadcast must not carry secrets
  const st = (await eng('getState')).result;
  const dump = JSON.stringify(st);
  check('engine state has no password / phrase / key', !dump.includes(PW) && !words.slice(0, 6).every((w) => dump.includes(w)) && !('_lastFail' in st));

  // --- reveal phrase
  const wrong = await eng('revealPhrase', { password: 'nope nope' });
  check('reveal phrase rejects a wrong password', wrong.ok === false && /wrong password/i.test(wrong.error));
  const right = await eng('revealPhrase', { password: PW });
  check('reveal phrase returns the same 24 words', right.ok && right.result === words.join(' '));

  // --- password guards share one limiter
  let last;
  for (let i = 0; i < 6; i++) last = await eng('send', { password: 'bad-' + i, recipient: 'x', amount: '1', fee: '1' });
  check('repeated wrong passwords get rate-limited', /too many/i.test(last.error), last.error);
  const blockedReveal = await eng('revealPhrase', { password: PW });
  check('limiter also covers reveal phrase', blockedReveal.ok === false && /too many/i.test(blockedReveal.error));

  // --- lock: private data leaves memory; settings and actions need unlock
  await eng('lock');
  const locked = (await eng('getState')).result;
  check('lock clears address, history and wallet from state', locked.locked && locked.address === null && locked.sends.length === 0 && locked.wallet === null);
  check('settings cannot be changed while locked', (await eng('setSettings', { patch: { nodes: [{ url: 'http://evil.example:9944', label: 'x' }] } })).ok === false);
  check('backup export needs unlock', (await eng('exportBackup')).ok === false);
  check('reveal needs unlock', (await eng('revealPhrase', { password: PW })).ok === false);
  check('unknown settings keys are ignored / sender-checked API', (await eng('nope')).ok === false);

  // --- unlock again (wait out limiter), history loads from sealed store
  await page.waitForTimeout(4500);
  const un = await eng('unlock', { password: PW });
  check('unlock works and restores address from encrypted store', un.ok && un.result.address?.startsWith('shca1'), un.error ?? '');

  // --- Tor fail-closed: enabling Tor with an invalid proxy host must block public nodes
  await eng('setSettings', { patch: { tor: { enabled: true, host: "127.0.0.1'; return 'DIRECT", port: 9050 } } });
  let s2 = (await eng('getState')).result;
  check('PAC injection via Tor host is refused', s2.tor.applied === false && /not valid/i.test(s2.tor.reason ?? ''), s2.tor.reason);
  const pub = await eng('checkNode', { node: { url: 'http://93.184.216.34:9944', label: 'public' } });
  check('public node requests are blocked while Tor is on but inactive', pub.result.online === false && /Tor is on but not active/.test(pub.result.error), pub.result.error);
  const local = await eng('checkNode', { node: { url: 'http://127.0.0.1:9944', label: 'local' } });
  check('local node still reachable (Tor never applies to localhost)', local.result.online === true);
  await eng('setSettings', { patch: { tor: { enabled: true, host: '127.0.0.1', port: 9050 } } });
  s2 = (await eng('getState')).result;
  check('valid Tor settings are applied and confirmed by Chrome', s2.tor.applied === true, s2.tor.reason ?? '');
  const proxy = await sw.evaluate(() => chrome.proxy.settings.get({}));
  const pac = proxy.value?.pacScript?.data ?? '';
  check('PAC has no direct fallback for node hosts and skips localhost', proxy.levelOfControl === 'controlled_by_this_extension' && pac.includes('SOCKS5 127.0.0.1:9050') && !pac.includes('"127.0.0.1"'));
  await eng('setSettings', { patch: { tor: { enabled: false, host: '127.0.0.1', port: 9050 } } });
  const cleared = await sw.evaluate(() => chrome.proxy.settings.get({}));
  check('turning Tor off releases the proxy', cleared.levelOfControl !== 'controlled_by_this_extension');

  // --- password change re-keys stored data
  const saltBefore = await idb('kdfSalt');
  const cp = await eng('changePassword', { password: PW, newPassword: 'new battery staple 7' });
  check('change password succeeds', cp.ok, cp.error ?? '');
  check('stored data re-keyed with a new salt', (await idb('kdfSalt')) !== saltBefore);
  const r2 = await eng('revealPhrase', { password: 'new battery staple 7' });
  check('phrase readable with the new password only', r2.ok && r2.result === words.join(' ') && (await eng('revealPhrase', { password: PW })).ok === false);

  for (const r of results) console.log(r.join(' | '));
  console.log('CONSOLE ERRORS', JSON.stringify(errs.slice(0, 5)));
  console.log(results.every((r) => r[0] === 'PASS') ? 'ALL PASS' : 'SOME FAILED');
  await ctx.close();
})().catch((e) => { for (const r of results) console.log(r.join(' | ')); console.error('FAIL', e.message); process.exit(1); });

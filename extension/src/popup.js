import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import qrcode from 'qrcode-generator';
import { NETWORK, FEES, ATOMS_PER_HGN } from './lib/constants.js';
import { formatHgn, parseHgn, shortHash, timeAgo, duration, bytesToHex } from './lib/format.js';

const isTab = new URLSearchParams(location.search).has('tab');
if (isTab) document.body.classList.add('tab');
const $app = document.getElementById('app');

let S = null;
let route = { name: 'boot', params: {} };
let current = null; // { update(state) }
let activityFilter = 'all';

// ================================================================ helpers
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    // CSP (style-src 'self') blocks style *attributes*; CSSOM assignment is allowed.
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const svg = (name) => h('span', { html: ICONS[name] ?? '', style: 'display:contents' });

const ICONS = {
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  recv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14.3-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.5L20 16M20 20v-4h-4"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01"/></svg>',
  node: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="7" height="7" rx="1.5"/><rect x="14" y="4" width="7" height="7" rx="1.5"/><rect x="8.5" y="14" width="7" height="7" rx="1.5"/><path d="M6.5 11v2h11v-2M12 13v1"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeoff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.5 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.8 9.8 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>',
  merge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4v5a6 6 0 0 0 6 6h0a6 6 0 0 1 6 6M18 4v5a6 6 0 0 1-6 6"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>',
};

async function engine(cmd, args) {
  for (let i = 0; i < 30; i++) {
    try {
      if (i === 0 || i % 5 === 0) await chrome.runtime.sendMessage({ to: 'sw', cmd: 'ensureEngine' });
      const r = await chrome.runtime.sendMessage({ to: 'engine', cmd, args });
      if (r) {
        if (!r.ok) throw Object.assign(new Error(r.error), { engine: true });
        return r.result;
      }
    } catch (e) {
      if (e.engine) throw e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Wallet engine is not responding. Reload the extension.');
}

function toast(text, err = false) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: `toast${err ? ' err' : ''}`, role: 'status' }, text);
  $app.append(t);
  setTimeout(() => t.remove(), 3200);
}

async function copy(text, label = 'Copied') {
  await navigator.clipboard.writeText(text);
  toast(label);
}

function sheet(build) {
  const close = () => wrap.remove();
  const inner = h('div', { role: 'dialog', 'aria-modal': 'true' });
  const wrap = h('div', { class: 'sheet', onclick: (e) => e.target === wrap && close() }, inner);
  inner.append(...[build(close)].flat());
  $app.append(wrap);
  inner.querySelector('input,button')?.focus();
  return close;
}

const hide = () => S?.settings?.hideAmounts;
const amt = (atoms, opts) => (hide() ? '◈◈◈◈◈' : formatHgn(atoms, opts));
const tip = () => S?.wallet?.tip?.height ?? S?.sync?.walletHeight ?? 0;

function busyButton(btn, fn) {
  return async (...a) => {
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try { await fn(...a); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.textContent = label; }
  };
}

function go(name, params = {}) {
  route = { name, params };
  render();
  engine('touch').catch(() => {});
}

// ================================================================ shell
function nodeDot() {
  if (!S.node?.online) return 'bad';
  if (!S.node.networkOk || S.node.nodeSyncing || S.node.versionOk === false) return 'warn';
  return 'ok';
}

function topBar() {
  const pill = h('button', { class: 'pill', title: 'Node status', onclick: () => go('network') },
    h('i', { class: `dot ${nodeDot()} ${S.sync.running ? 'live' : ''}`, id: 'nodedot' }),
    h('span', { id: 'nodetext' }, nodeText()));
  return h('div', { class: 'top' },
    h('img', { class: 'logo', src: 'icons/icon-48.png', alt: '' }),
    h('div', { class: 'who' }, h('b', {}, 'Joker Wallet'), h('span', {}, 'HGN pre-mainnet')),
    pill,
    !S.locked && h('button', { class: 'iconbtn', title: hide() ? 'Show amounts' : 'Hide amounts', 'aria-label': 'Toggle amounts', onclick: () => engine('setSettings', { patch: { hideAmounts: !hide() } }) }, svg(hide() ? 'eyeoff' : 'eye')),
    !isTab && h('button', { class: 'iconbtn', title: 'Open in a tab', 'aria-label': 'Open in a tab', onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab=1') }) }, svg('expand')),
    S.hasWallet && !S.locked && h('button', { class: 'iconbtn', title: 'Lock', 'aria-label': 'Lock', onclick: () => engine('lock').catch((e) => toast(e.message, true)) }, svg('lock')),
  );
}

function nodeText() {
  if (S.node?.checking && !S.node.height) return 'Connecting';
  if (!S.node?.online) return 'Offline';
  return `#${(S.node.height ?? 0).toLocaleString()}`;
}

function chainStrip() {
  const wrap = h('div', { class: 'chain', id: 'chain' });
  fillChain(wrap);
  return wrap;
}

function fillChain(wrap) {
  wrap.textContent = '';
  const nodeH = S.node?.height ?? S.sync?.nodeHeight;
  const walletH = S.sync?.walletHeight;
  const N = isTab ? 32 : 24;
  const ticks = h('div', { class: 'ticks', 'aria-hidden': 'true' });
  const tx = new Map((S.recentBlocks ?? []).map((b) => [b.height, b.txCount]));
  const mine = new Set([
    ...(S.sends ?? []).map((s) => s.minedHeight).filter(Boolean),
    ...(S.wallet?.notes ?? []).map((n) => n.created_height),
  ]);
  for (let i = N - 1; i >= 0; i--) {
    const hgt = nodeH != null ? nodeH - i : null;
    const cls = ['t'];
    if (hgt != null) {
      if (walletH != null && hgt <= walletH && !S.locked) cls.push('synced');
      if (tx.get(hgt) > 0) cls.push('tx');
      if (mine.has(hgt) && !S.locked) cls.push('mine');
      if (i === 0) cls.push('tip');
    }
    ticks.append(h('i', { class: cls.join(' '), title: hgt != null ? `Block ${hgt.toLocaleString()}${tx.get(hgt) ? `, ${tx.get(hgt)} tx` : ''}` : '' }));
  }
  wrap.append(ticks);
  const left = nodeH != null ? h('span', {}, 'Block ', h('b', { class: 'num' }, nodeH.toLocaleString()), S.node?.timestamp ? `, ${timeAgo(S.node.timestamp)}` : '') : h('span', {}, 'No node connection');
  let right;
  const behind = nodeH != null && walletH != null ? nodeH - walletH : null;
  if (!S.hasWallet) right = h('span', {}, '');
  else if (S.locked) right = h('span', {}, 'Locked, sync paused');
  else if (S.sync?.error) right = h('span', { style: 'color:var(--amber)' }, 'Sync paused');
  else if (behind != null && behind > 1) right = h('span', {}, 'Scanning, ', h('b', { class: 'num' }, behind.toLocaleString()), ' to go');
  else if (walletH != null) right = h('span', { style: 'color:var(--green)' }, 'Wallet synced');
  else right = h('span', {}, 'Waiting for first sync');
  wrap.append(h('div', { class: 'meta' }, left, right));
  if (behind != null && behind > 1 && !S.locked && nodeH > 0) {
    const pct = Math.max(1, Math.min(100, (walletH / nodeH) * 100));
    wrap.append(h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: `width:${pct}%` })));
  }
}

function navBar() {
  const tabs = [['home', 'Wallet', 'home'], ['activity', 'Activity', 'list'], ['network', 'Network', 'node'], ['settings', 'Settings', 'gear']];
  return h('nav', { class: 'nav' }, tabs.map(([r, label, ic]) =>
    h('button', { class: route.name === r ? 'on' : '', onclick: () => go(r), 'aria-current': route.name === r ? 'page' : null }, svg(ic), label)));
}

const MAIN = new Set(['home', 'activity', 'network', 'settings']);
const PRE = new Set(['welcome', 'create', 'restore', 'nodes']);

function forcedRoute() {
  if (!S || !S.ready) return 'boot';
  if (!S.hasWallet) return PRE.has(route.name) ? null : 'welcome';
  if (S.locked) return route.name === 'lock' ? null : 'lock';
  if (route.name === 'lock' || route.name === 'boot' || route.name === 'welcome' || route.name === 'create' || route.name === 'restore') return 'home';
  return null;
}

function render() {
  const f = forcedRoute();
  if (f) route = { name: f, params: {} };
  $app.textContent = '';
  current = null;
  if (route.name === 'boot') {
    $app.append(h('div', { class: 'screen center', style: 'text-align:center' }, h('img', { src: 'icons/icon-128.png', width: 72, height: 72, alt: '', style: 'margin:0 auto 12px' }), h('p', { class: 'muted' }, 'Starting the wallet engine…')));
    return;
  }
  if (S.hasWallet || route.name === 'nodes') $app.append(topBar(), chainStrip());
  const screen = SCREENS[route.name] ?? SCREENS.home;
  const out = screen(route.params);
  const el = out.el ?? out;
  current = out.el ? out : null;
  $app.append(el);
  if (S.hasWallet && !S.locked && (MAIN.has(route.name) || route.name === 'receive' || route.name === 'send' || route.name === 'progress')) $app.append(navBar());
}

function onState(state) {
  const prev = S;
  S = state;
  const f = forcedRoute();
  if (!prev || f || prev.locked !== S.locked || prev.hasWallet !== S.hasWallet || !document.getElementById('chain') && S.hasWallet) {
    render();
    return;
  }
  // live updates without rebuilding forms
  const dot = document.getElementById('nodedot');
  if (dot) dot.className = `dot ${nodeDot()} ${S.sync.running ? 'live' : ''}`;
  const nt = document.getElementById('nodetext');
  if (nt) nt.textContent = nodeText();
  const ch = document.getElementById('chain');
  if (ch) fillChain(ch);
  current?.update?.(S);
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.type === 'engine-state') onState(msg.state);
});

// ================================================================ screens
const SCREENS = {};

// ---------------------------------------------------------------- welcome
SCREENS.welcome = () => {
  const node = S.settings.nodes[S.settings.activeNode] ?? S.settings.nodes[0];
  return h('div', { class: 'screen center' },
    h('img', { src: 'icons/icon-128.png', width: 88, height: 88, alt: 'Joker Hegemon Wallet', style: 'border-radius:20px;margin-bottom:14px' }),
    h('h1', {}, 'A private wallet for Hegemon'),
    h('p', { class: 'muted' }, 'Your keys, note scanning and zero-knowledge proofs are made and kept in this browser. Nothing secret is sent to the node.'),
    h('div', { class: 'stack' },
      h('button', { class: 'btn primary', onclick: () => go('create') }, 'Create a new wallet'),
      h('button', { class: 'btn', onclick: () => go('restore') }, 'Restore with 24 words')),
    h('p', { class: 'muted', style: 'font-size:13px;margin-top:18px' },
      'Node: ', h('span', { class: 'mono' }, node.url), ' ',
      h('button', { class: 'btn link', onclick: () => go('nodes', { back: 'welcome' }) }, 'Change node')),
  );
};

// ---------------------------------------------------------------- password field + strength
function strengthOf(p) {
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p) || p.length >= 18) s++;
  return Math.min(4, s);
}

function passwordFields() {
  const pw = h('input', { class: 'in', type: 'password', autocomplete: 'new-password', id: 'pw1' });
  const pw2 = h('input', { class: 'in', type: 'password', autocomplete: 'new-password', id: 'pw2' });
  const bar = h('div', { class: 'strength' }, h('i'), h('i'), h('i'), h('i'));
  const hint = h('div', { class: 'hint' });
  const check = () => {
    const s = strengthOf(pw.value);
    bar.className = `strength s${s}`;
    if (pw.value && pw.value.length < 8) { hint.className = 'hint err'; hint.textContent = 'Use at least 8 characters.'; }
    else if (pw2.value && pw2.value !== pw.value) { hint.className = 'hint err'; hint.textContent = 'Passwords do not match.'; }
    else { hint.className = 'hint'; hint.textContent = s < 3 && pw.value ? 'A longer password with mixed characters is safer.' : ''; }
  };
  pw.oninput = pw2.oninput = check;
  const el = [
    h('label', { class: 'f', for: 'pw1' }, h('span', {}, 'Password'), pw), bar,
    h('label', { class: 'f', for: 'pw2' }, h('span', {}, 'Repeat password'), pw2), hint,
  ];
  const value = () => {
    if (pw.value.length < 8) throw new Error('Use at least 8 characters.');
    if (pw.value !== pw2.value) throw new Error('Passwords do not match.');
    return pw.value;
  };
  return { el, value };
}

// ---------------------------------------------------------------- create
SCREENS.create = () => {
  const root = h('div', { class: 'screen' });
  let password = null;
  let mnemonic = null;

  const stepPw = () => {
    const pf = passwordFields();
    const ack = h('input', { type: 'checkbox', id: 'ack' });
    const next = h('button', { class: 'btn primary' }, 'Continue');
    next.onclick = () => {
      try {
        password = pf.value();
        if (!ack.checked) throw new Error('Please confirm you understand.');
        mnemonic = generateMnemonic(wordlist, 256);
        stepPhrase();
      } catch (e) { toast(e.message, true); }
    };
    root.replaceChildren(
      h('button', { class: 'back', onclick: () => go('welcome') }, svg('back'), 'Back'),
      h('h1', {}, 'Set a password'),
      h('p', { class: 'muted' }, 'It unlocks the wallet on this computer and encrypts the wallet file. It cannot be recovered.'),
      ...pf.el,
      h('label', { style: 'display:flex;gap:8px;align-items:flex-start;margin-top:12px;font-size:13px', for: 'ack' }, ack, h('span', { class: 'muted' }, 'I understand that only my 24-word phrase can restore this wallet if I forget the password.')),
      h('div', { class: 'stack' }, next),
    );
  };

  const stepPhrase = () => {
    const words = mnemonic.split(' ');
    const grid = h('div', { class: 'words blur', id: 'words' }, words.map((w) => h('span', {}, w)));
    const reveal = h('div', { class: 'reveal' }, h('button', { class: 'btn small', onclick: () => { grid.classList.remove('blur'); reveal.remove(); } }, svg('eye'), 'Show phrase'));
    const wrap = h('div', { style: 'position:relative' }, grid, reveal);
    root.replaceChildren(
      h('button', { class: 'back', onclick: stepPw }, svg('back'), 'Back'),
      h('h1', {}, 'Write down your 24 words'),
      h('p', { class: 'muted' }, 'In order, on paper. Anyone with these words can spend your HGN. Joker never sends them anywhere.'),
      wrap,
      h('button', { class: 'btn link', style: 'margin-top:8px', onclick: () => copy(mnemonic, 'Copied — clear your clipboard after saving') }, 'Copy to clipboard'),
      h('div', { class: 'stack' }, h('button', { class: 'btn primary', onclick: stepQuiz }, 'I wrote them down')),
    );
  };

  const stepQuiz = () => {
    const words = mnemonic.split(' ');
    const picks = [];
    while (picks.length < 3) {
      const i = crypto.getRandomValues(new Uint32Array(1))[0] % 24;
      if (!picks.includes(i)) picks.push(i);
    }
    picks.sort((a, b) => a - b);
    const solved = new Set();
    const done = h('button', { class: 'btn primary', disabled: true }, 'Create wallet');
    const qs = picks.map((i) => {
      const opts = new Set([words[i]]);
      while (opts.size < 3) opts.add(wordlist[crypto.getRandomValues(new Uint32Array(1))[0] % 2048]);
      const shuffled = [...opts].sort(() => Math.random() - 0.5);
      const row = h('div', { class: 'opts' });
      shuffled.forEach((w) => row.append(h('button', {
        onclick: (e) => {
          if (w === words[i]) { e.target.classList.add('right'); solved.add(i); }
          else { e.target.classList.add('wrong'); setTimeout(() => e.target.classList.remove('wrong'), 700); }
          done.disabled = solved.size !== 3;
        },
      }, w)));
      return h('div', {}, h('div', { class: 'muted', style: 'font-size:13px;margin-bottom:5px' }, `Word ${i + 1}`), row);
    });
    done.onclick = busyButton(done, async () => {
      const entropyHex = bytesToHex(mnemonicToEntropy(mnemonic, wordlist));
      await engine('create', { mnemonic, entropyHex, password, restored: false });
      mnemonic = null;
      password = null;
    });
    root.replaceChildren(
      h('button', { class: 'back', onclick: stepPhrase }, svg('back'), 'Back'),
      h('h1', {}, 'Check your phrase'),
      h('p', { class: 'muted' }, 'Pick the right word for each position.'),
      h('div', { class: 'quiz' }, qs),
      h('div', { class: 'stack' }, done),
    );
  };

  stepPw();
  return root;
};

// ---------------------------------------------------------------- restore
SCREENS.restore = () => {
  const ta = h('textarea', { class: 'in', id: 'phrase', rows: 5, spellcheck: 'false', autocomplete: 'off', placeholder: 'word1 word2 word3 …' });
  const hint = h('div', { class: 'hint' });
  const pf = passwordFields();
  const btn = h('button', { class: 'btn primary' }, 'Restore wallet');
  const norm = () => ta.value.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
  ta.oninput = () => {
    const ws = norm().split(' ').filter(Boolean);
    const unknown = ws.filter((w) => !wordlist.includes(w));
    if (!ws.length) { hint.className = 'hint'; hint.textContent = ''; }
    else if (unknown.length) { hint.className = 'hint err'; hint.textContent = `Not in the word list: ${unknown.slice(0, 4).join(', ')}`; }
    else if (ws.length !== 24) { hint.className = 'hint'; hint.textContent = `${ws.length} of 24 words`; }
    else if (!validateMnemonic(norm(), wordlist)) { hint.className = 'hint err'; hint.textContent = '24 words, but the checksum is wrong — check the order and spelling.'; }
    else { hint.className = 'hint ok'; hint.textContent = 'Phrase is valid.'; }
  };
  btn.onclick = busyButton(btn, async () => {
    const m = norm();
    if (m.split(' ').length !== 24 || !validateMnemonic(m, wordlist)) throw new Error('Enter a valid 24-word phrase.');
    const password = pf.value();
    await engine('create', { mnemonic: m, entropyHex: bytesToHex(mnemonicToEntropy(m, wordlist)), password, restored: true });
  });
  return h('div', { class: 'screen' },
    h('button', { class: 'back', onclick: () => go('welcome') }, svg('back'), 'Back'),
    h('h1', {}, 'Restore your wallet'),
    h('p', { class: 'muted' }, 'Enter your 24 words. The wallet then scans every Hegemon block for your notes; with your own node this takes minutes, with a rate-limited public node it can take hours.'),
    h('label', { class: 'f', for: 'phrase' }, h('span', {}, 'Recovery phrase'), ta), hint,
    ...pf.el,
    h('div', { class: 'stack' }, btn),
  );
};

// ---------------------------------------------------------------- lock
SCREENS.lock = () => {
  const pw = h('input', { class: 'in', type: 'password', id: 'unlockpw', autocomplete: 'current-password', autofocus: true });
  const hint = h('div', { class: 'hint' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Unlock');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true;
      btn.textContent = 'Unlocking…';
      hint.textContent = '';
      try { await engine('unlock', { password: pw.value }); }
      catch (err) { hint.className = 'hint err'; hint.textContent = err.message; pw.select(); }
      finally { btn.disabled = false; btn.textContent = 'Unlock'; }
    },
  }, h('label', { class: 'f', for: 'unlockpw' }, h('span', {}, 'Password'), pw), hint, h('div', { class: 'stack' }, btn));
  setTimeout(() => pw.focus(), 30);
  return h('div', { class: 'screen center' },
    h('h1', {}, 'Unlock your wallet'),
    h('p', { class: 'muted' }, 'Syncing and sending need the wallet unlocked. It locks itself after ', `${S.settings.autoLockMinutes} minutes`, ' of inactivity.'),
    form,
    h('button', { class: 'btn link', style: 'margin-top:18px', onclick: forgotSheet }, 'Forgot password?'),
  );
};

function forgotSheet() {
  sheet((close) => {
    const inp = h('input', { class: 'in', id: 'erase', placeholder: 'ERASE' });
    const b = h('button', { class: 'btn danger' }, 'Erase wallet from this browser');
    b.onclick = busyButton(b, async () => {
      await engine('wipe', { confirm: inp.value.trim() });
      close();
    });
    return [h('h2', {}, 'Forgot your password?'),
      h('p', { class: 'muted' }, 'The password cannot be recovered. You can erase this wallet from the browser and restore it with your 24 words. Without the words, the funds are lost.'),
      h('label', { class: 'f', for: 'erase' }, h('span', {}, 'Type ERASE to confirm'), inp),
      h('div', { class: 'stack' }, b, h('button', { class: 'btn', onclick: close }, 'Keep wallet'))];
  });
}

// ---------------------------------------------------------------- home
function bannersFor(st) {
  const out = [];
  const n = st.node ?? {};
  if (!n.online) out.push(['bad', h('div', {}, h('b', {}, 'Node offline. '), n.error ?? 'Cannot reach the node.', ' ', h('button', { class: 'btn link', onclick: () => go('network') }, 'Check node'))]);
  else {
    if (n.networkOk === false) out.push(['bad', h('div', {}, h('b', {}, 'Wrong network. '), 'This node is not Hegemon pre-mainnet v0.11. Syncing is stopped.')]);
    if (n.nodeSyncing) out.push(['warn', h('div', {}, h('b', {}, 'Node is catching up. '), 'Balances may lag until it reaches the network tip.')]);
    if (n.upgradeNotice) out.push(['warn', h('div', {}, h('b', {}, 'Node upgrade needed. '), n.upgradeNotice, '.')]);
    if (!st.settings.nodes.some((x) => x.canSubmit)) out.push(['warn', h('div', {}, h('b', {}, 'Receive-only. '), 'Your node does not accept sends. ', h('button', { class: 'btn link', onclick: () => go('nodes', { back: 'home' }) }, 'Add a sending node'))]);
  }
  if (st.sync?.error && n.online) out.push(['warn', h('div', {}, h('b', {}, 'Sync paused. '), st.sync.error, ' ', h('button', { class: 'btn link', onclick: () => engine('syncNow') }, 'Retry'))]);
  if (st.settings.tor.enabled && !st.tor?.applied) out.push(['bad', h('div', {}, h('b', {}, 'Tor is on but not active. '), `${st.tor?.reason ?? 'Chrome is not using the Tor proxy'}. Requests to public nodes are blocked to protect your IP.`)]);
  else if (st.settings.tor.enabled && st.tor?.verified === false) out.push(['bad', h('div', {}, h('b', {}, 'Tor is not reachable. '), 'Node requests fail instead of going out directly. Start Tor, or turn it off in Settings.')]);
  if ((st.sends ?? []).some((s) => s.phase === 'expired')) out.push(['warn', h('div', {}, h('b', {}, 'Funds held by an expired send. '), h('button', { class: 'btn link', onclick: () => go('settings', { section: 'wallet' }) }, 'Release them'))]);
  return out.map(([k, body]) => h('div', { class: `banner ${k}` }, h('i', { class: `dot ${k === 'bad' ? 'bad' : k === 'warn' ? 'warn' : 'ok'}` }), body));
}

function activityRows(st, limit) {
  const t = st.wallet?.tip?.height ?? 0;
  const changeHeights = new Set((st.sends ?? []).map((s) => s.minedHeight).filter(Boolean));
  const rows = [];
  for (const s of st.sends ?? []) {
    rows.push({ type: 'sent', at: s.createdAt, s });
  }
  for (const n of st.wallet?.notes ?? []) {
    if (changeHeights.has(n.created_height)) continue; // our own change output
    rows.push({ type: 'recv', at: n.created_height, n, height: n.created_height });
  }
  // Order: in-flight sends first, then by height/time.
  rows.sort((a, b) => {
    const ah = a.type === 'recv' ? a.height : a.s.minedHeight ?? Infinity;
    const bh = b.type === 'recv' ? b.height : b.s.minedHeight ?? Infinity;
    return bh - ah || (b.at ?? 0) - (a.at ?? 0);
  });
  const filtered = rows.filter((r) => activityFilter === 'all' || (activityFilter === 'in' ? r.type === 'recv' : r.type === 'sent'));
  return (limit ? filtered.slice(0, limit) : filtered).map((r) => (r.type === 'recv' ? recvRow(r.n, t) : sentRow(r.s, t)));
}

function recvRow(n, t) {
  const conf = t - n.created_height + 1;
  const assetNote = n.asset !== 0 ? ` (asset ${n.asset})` : '';
  return h('div', { class: 'row', tabindex: 0, onclick: () => noteSheet(n, t) },
    h('div', { class: 'ic recv' }, svg('recv')),
    h('div', {}, h('div', { class: 't1' }, `Received${assetNote}`), h('div', { class: 't2' }, `Block ${n.created_height.toLocaleString()}, ${conf.toLocaleString()} confirmation${conf === 1 ? '' : 's'}${n.spent ? ', spent' : ''}`)),
    h('div', { class: 'v recv' }, `+${amt(n.value)}`));
}

const PHASE = {
  syncing: ['Syncing', 'wait'], proving: ['Building proof', 'wait'], waiting: ['Waiting to send', 'wait'],
  submitting: ['Submitting', 'wait'], submitted: ['In mempool', 'wait'], confirmed: ['Confirmed', 'out'],
  uncertain: ['Unconfirmed', 'wait'], failed: ['Failed', 'bad'], expired: ['Expired', 'bad'],
};

function sentRow(s, t) {
  const [label, cls] = PHASE[s.phase] ?? [s.phase, 'wait'];
  const conf = s.minedHeight ? t - s.minedHeight + 1 : null;
  const sub = s.phase === 'confirmed' && conf ? `${label}, ${conf} confirmation${conf === 1 ? '' : 's'}` : s.phase === 'proving' && s.provingStartedAt ? `${label}, ${duration((Date.now() - s.provingStartedAt) / 1000)}` : `${label}, ${timeAgo(s.createdAt)}`;
  return h('div', { class: 'row', tabindex: 0, onclick: () => go('progress', { id: s.localId }) },
    h('div', { class: `ic ${cls}` }, svg(s.kind === 'merge' ? 'merge' : cls === 'wait' ? 'clock' : cls === 'bad' ? 'x' : 'send')),
    h('div', {}, h('div', { class: 't1' }, s.kind === 'merge' ? 'Merged notes' : s.toSelf ? 'Sent to yourself' : 'Sent'), h('div', { class: 't2' }, sub)),
    h('div', { class: 'v' }, s.kind === 'merge' ? amt(s.amount) : `−${amt(BigInt(s.amount) + BigInt(s.fee))}`));
}

function noteSheet(n, t) {
  sheet((close) => [
    h('h2', {}, `Received ${hide() ? '' : formatHgn(n.value) + ' HGN'}`),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Amount'), h('dd', { class: 'num' }, `${amt(n.value)} ${n.asset === 0 ? 'HGN' : `asset ${n.asset}`}`),
      h('dt', {}, 'Block'), h('dd', { class: 'num' }, n.created_height.toLocaleString()),
      h('dt', {}, 'Confirmations'), h('dd', { class: 'num' }, (t - n.created_height + 1).toLocaleString()),
      h('dt', {}, 'Block hash'), h('dd', { class: 'mono' }, shortHash(n.created_block, 10)),
      h('dt', {}, 'Note type'), h('dd', {}, n.kind),
      h('dt', {}, 'Tree position'), h('dd', { class: 'num' }, n.position.toLocaleString()),
      h('dt', {}, 'Status'), h('dd', {}, n.spent ? 'Spent' : 'Unspent')),
    h('p', { class: 'muted', style: 'font-size:12px;margin-top:12px' }, 'Shielded: the sender, amount and your address are not visible on chain.'),
    h('div', { class: 'stack' }, h('button', { class: 'btn', onclick: close }, 'Close')),
  ]);
}

SCREENS.home = () => {
  const banners = h('div', { id: 'banners' });
  const bal = h('div', { class: 'balance' });
  const pendingBox = h('div');
  const recent = h('div', { class: 'list' });
  const fill = (st) => {
    banners.replaceChildren(...bannersFor(st));
    const b = st.wallet?.balance;
    const avail = b?.available?.atoms ?? '0';
    const h1 = hide();
    bal.replaceChildren(
      h('div', { class: 'label' }, 'Available'),
      h('div', { class: `amt num ${h1 ? 'hid' : ''}` }, b ? amt(avail) : '—', h('small', {}, 'HGN')),
      b && h('div', { class: 'subs' },
        BigInt(b.reserved.atoms) > 0n && h('span', { class: 'amber' }, 'Sending ', h('b', { class: 'num' }, amt(b.reserved.atoms))),
        BigInt(b.immature.atoms) > 0n && h('span', { title: `Mining rewards spend after ${NETWORK.coinbaseMaturity} blocks` }, 'Maturing ', h('b', { class: 'num' }, amt(b.immature.atoms)), b.blocks_until_next_maturity != null ? `, next in ${b.blocks_until_next_maturity} blocks` : ''),
        b.available.notes > 0 && h('span', {}, h('b', { class: 'num' }, b.available.notes), ` note${b.available.notes === 1 ? '' : 's'}`),
        BigInt(b.htlc.atoms) + BigInt(b.policy.atoms) > 0n && h('span', {}, 'Locked contracts ', h('b', { class: 'num' }, amt(BigInt(b.htlc.atoms) + BigInt(b.policy.atoms)))),
        Object.keys(b.other_assets ?? {}).length > 0 && h('span', {}, `${Object.keys(b.other_assets).length} other asset(s)`)),
    );
    const live = (st.sends ?? []).filter((s) => !['confirmed', 'failed'].includes(s.phase)).slice(0, 3);
    pendingBox.replaceChildren(...(live.length ? [h('h2', {}, 'In progress'), h('div', { class: 'list' }, live.map((s) => sentRow(s, st.wallet?.tip?.height ?? 0)))] : []));
    const rows = activityRows(st, 5);
    recent.replaceChildren(...(rows.length ? rows : [h('div', { class: 'empty' }, st.sync.walletHeight == null || (st.node.height ?? 0) - (st.sync.walletHeight ?? 0) > 2
      ? 'Your activity appears here once the wallet has scanned the chain.'
      : 'No activity yet. Share your address to receive HGN.')]));
  };
  fill(S);
  const syncBtn = h('button', { class: 'act', onclick: () => { engine('syncNow'); toast('Syncing'); } }, svg('sync'), 'Sync');
  const el = h('div', { class: 'screen' },
    banners, bal,
    h('div', { class: 'actions' },
      h('button', { class: 'act', onclick: () => go('send') }, svg('send'), 'Send'),
      h('button', { class: 'act', onclick: () => go('receive') }, svg('recv'), 'Receive'),
      syncBtn),
    pendingBox,
    h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline' }, h('h2', {}, 'Recent activity'), h('button', { class: 'btn link', onclick: () => go('activity') }, 'See all')),
    recent);
  return { el, update: fill };
};

// ---------------------------------------------------------------- receive
SCREENS.receive = () => {
  const a = S.address ?? '';
  const qrBox = h('div');
  const showQr = () => {
    const qr = qrcode(0, 'L');
    qr.addData(a.toUpperCase(), 'Alphanumeric');
    qr.make();
    qrBox.replaceChildren(h('div', { class: 'qr' }, h('img', { src: qr.createDataURL(2, 8), alt: 'QR code of your address' })),
      h('p', { class: 'muted', style: 'font-size:12px' }, 'Dense QR (Hegemon addresses carry a post-quantum key). Works with scanners that read version 40 codes.'));
  };
  const download = () => {
    const blob = new Blob([a + '\n'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    h('a', { href: url, download: 'my-hegemon-address.txt' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  return h('div', { class: 'screen' },
    h('button', { class: 'back', onclick: () => go('home') }, svg('back'), 'Wallet'),
    h('h1', {}, 'Receive HGN'),
    h('p', { class: 'muted' }, 'Share this address. Payments to it are shielded: nobody else can see them or link them to you.'),
    h('div', { class: 'addrhead' }, h('em', {}, a.slice(0, 14)), '…', a.slice(-10)),
    h('div', { class: 'addrbox', style: 'margin-top:8px', tabindex: 0, 'aria-label': 'Your full address' }, a),
    h('div', { class: 'stack', style: 'grid-template-columns:1fr 1fr' },
      h('button', { class: 'btn primary', onclick: () => copy(a, 'Address copied') }, svg('copy'), 'Copy address'),
      h('button', { class: 'btn', onclick: download }, 'Save as file')),
    h('button', { class: 'btn link', style: 'margin-top:10px', onclick: showQr }, 'Show QR code'),
    qrBox,
    h('div', { class: 'banner' }, h('i', { class: 'dot ok' }), h('div', {}, `This is your one receiving address (${a.length.toLocaleString()} characters). Always copy the whole address; never retype it. Mining rewards to it become spendable after ${NETWORK.coinbaseMaturity} blocks.`)),
  );
};

// ---------------------------------------------------------------- send
function spendableInfo() {
  const notes = (S.wallet?.notes ?? []).filter((n) => !n.spent && n.asset === 0 && n.kind === 'ordinary').map((n) => BigInt(n.value)).sort((a, b) => (a < b ? 1 : -1));
  const twoMax = (notes[0] ?? 0n) + (notes[1] ?? 0n);
  return { notes, twoMax, count: notes.length };
}

SCREENS.send = (params = {}) => {
  const to = h('textarea', { class: 'in', id: 'to', rows: 3, spellcheck: 'false', placeholder: 'shca1…', value: params.to ?? '' });
  const toHint = h('div', { class: 'hint' });
  const amount = h('input', { class: 'in num', id: 'amount', inputmode: 'decimal', placeholder: '0.00', value: params.amount ?? '' });
  const amtHint = h('div', { class: 'hint' });
  const memo = h('input', { class: 'in', id: 'memo', maxlength: 80, placeholder: 'Only stored on this device', value: params.memo ?? '' });
  let feeKey = params.fee ?? S.settings.feePreset ?? 'normal';
  const feeSeg = h('div', { class: 'seg', role: 'radiogroup' });
  const drawFee = () => feeSeg.replaceChildren(...Object.entries(FEES).map(([k, v]) =>
    h('button', { class: feeKey === k ? 'on' : '', role: 'radio', 'aria-checked': feeKey === k, onclick: () => { feeKey = k; drawFee(); checkAmt(); } },
      k[0].toUpperCase() + k.slice(1), h('small', {}, `${formatHgn(v, { minDecimals: 0 })} HGN`))));
  drawFee();
  let toValid = false;
  let t = null;
  to.oninput = () => {
    if (/^SHCA1/.test(to.value.trim())) to.value = to.value.trim().toLowerCase();
    toValid = false;
    clearTimeout(t);
    const v = to.value.trim();
    if (!v) { toHint.textContent = ''; return; }
    if (!v.startsWith('shca1')) { toHint.className = 'hint err'; toHint.textContent = 'Hegemon addresses start with shca1.'; return; }
    toHint.className = 'hint'; toHint.textContent = 'Checking…';
    t = setTimeout(async () => {
      try {
        const r = await engine('validateAddress', { address: v });
        toValid = r.valid;
        toHint.className = `hint ${r.valid ? 'ok' : 'err'}`;
        toHint.textContent = r.valid ? (v === S.address ? 'Valid — this is your own address.' : 'Valid Hegemon address.') : r.reason;
      } catch (e) { toHint.className = 'hint err'; toHint.textContent = e.message; }
    }, 250);
  };
  const info = spendableInfo();
  const checkAmt = () => {
    amount.classList.remove('err');
    if (!amount.value) { amtHint.className = 'hint'; amtHint.textContent = `Up to ${amt(info.twoMax > FEES[feeKey] ? info.twoMax - FEES[feeKey] : 0n)} HGN in one send`; return null; }
    try {
      const v = parseHgn(amount.value);
      const need = v + FEES[feeKey];
      const avail = BigInt(S.wallet?.balance?.available?.atoms ?? 0);
      if (v <= 0n) throw new Error('Enter an amount above zero.');
      if (need > avail) throw new Error(`Not enough available HGN (you have ${formatHgn(avail)}).`);
      if (need > info.twoMax) throw new Error('A single send can use at most two notes. Merge notes first (Settings → Wallet), or send less.');
      amtHint.className = 'hint'; amtHint.textContent = `Total with fee: ${formatHgn(need)} HGN`;
      return v;
    } catch (e) { amount.classList.add('err'); amtHint.className = 'hint err'; amtHint.textContent = e.message; return null; }
  };
  amount.oninput = checkAmt;
  checkAmt();
  if (params.to) to.oninput();
  const max = h('button', { class: 'btn small', onclick: () => { const m = info.twoMax - FEES[feeKey]; amount.value = m > 0n ? formatHgn(m, { minDecimals: 0 }).replace(/,/g, '') : '0'; checkAmt(); } }, 'Max');
  const paste = h('button', { class: 'btn link', onclick: async () => { to.value = (await navigator.clipboard.readText()).trim(); to.oninput(); } }, 'Paste');
  const review = h('button', { class: 'btn primary' }, 'Review');
  review.onclick = () => {
    const v = checkAmt();
    if (!toValid) { toast('Check the recipient address', true); to.focus(); return; }
    if (v == null) { amount.focus(); return; }
    reviewSheet({ to: to.value.trim(), amount: v, fee: FEES[feeKey], memo: memo.value, back: { to: to.value, amount: amount.value, fee: feeKey, memo: memo.value } });
  };
  const readOnly = !S.settings.nodes.some((n) => n.canSubmit);
  return h('div', { class: 'screen' },
    h('button', { class: 'back', onclick: () => go('home') }, svg('back'), 'Wallet'),
    h('h1', {}, 'Send HGN'),
    readOnly && h('div', { class: 'banner warn' }, h('i', { class: 'dot warn' }), h('div', {}, 'None of your nodes accepts sends yet. ', h('button', { class: 'btn link', onclick: () => go('nodes', { back: 'send' }) }, 'Set up a node'))),
    h('label', { class: 'f', for: 'to' }, h('span', {}, 'To', paste), to), toHint,
    h('label', { class: 'f', for: 'amount' }, h('span', {}, 'Amount', h('span', { class: 'num' }, `Available ${amt(S.wallet?.balance?.available?.atoms ?? 0)}`)), h('div', { class: 'inwrap' }, amount, h('div', { class: 'suffix' }, 'HGN', max))), amtHint,
    h('label', { class: 'f' }, h('span', {}, 'Network fee'), feeSeg),
    h('label', { class: 'f', for: 'memo' }, h('span', {}, 'Private label (optional)'), memo),
    h('div', { class: 'stack' }, review),
  );
};

function reviewSheet({ to, amount, fee, memo, back }) {
  const tor = S.settings.tor.enabled;
  const dand = S.settings.dandelion.enabled;
  sheet((close) => {
    const pw = h('input', { class: 'in', type: 'password', id: 'sendpw', autocomplete: 'current-password' });
    const hint = h('div', { class: 'hint' });
    const btn = h('button', { class: 'btn primary' }, `Send ${formatHgn(amount)} HGN`);
    btn.onclick = busyButton(btn, async () => {
      try {
        const id = await engine('send', { recipient: to, amount: amount.toString(), fee: fee.toString(), note: memo, password: pw.value });
        close();
        go('progress', { id });
      } catch (e) { hint.className = 'hint err'; hint.textContent = e.message; throw e; }
    });
    return [
      h('h2', {}, 'Confirm send'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'To'), h('dd', { class: 'mono' }, `${to.slice(0, 14)}…${to.slice(-8)}`),
        h('dt', {}, 'Amount'), h('dd', { class: 'num' }, `${formatHgn(amount)} HGN`),
        h('dt', {}, 'Network fee'), h('dd', { class: 'num' }, `${formatHgn(fee)} HGN`),
        h('dt', {}, 'Total'), h('dd', { class: 'num' }, h('b', {}, `${formatHgn(amount + fee)} HGN`)),
        h('dt', {}, 'Proof'), h('dd', {}, 'Built on this device'),
        h('dt', {}, 'Route'), h('dd', {}, `${dand ? 'Dandelion stem node' : 'Your node'}${tor ? ' over Tor' : ''}`)),
      !tor && h('p', { class: 'muted', style: 'font-size:12px;margin-top:10px' }, 'The node sees your IP address when you send. Turn on Tor in Settings to hide it.'),
      h('p', { class: 'muted', style: 'font-size:12px' }, `Building the proof can take several minutes. You can close this popup; keep Chrome open. The send must reach a block within ${NETWORK.referenceWindow} blocks.`),
      h('label', { class: 'f', for: 'sendpw' }, h('span', {}, 'Password'), pw), hint,
      h('div', { class: 'stack' }, btn, h('button', { class: 'btn', onclick: () => { close(); go('send', back); } }, 'Edit')),
    ];
  });
}

// ---------------------------------------------------------------- send progress
SCREENS.progress = ({ id }) => {
  const box = h('div');
  let timer = null;
  const fill = (st) => {
    const s = (st.sends ?? []).find((x) => x.localId === id);
    if (!s) { box.replaceChildren(h('p', { class: 'muted' }, 'This send is no longer in the list.')); return; }
    const order = ['syncing', 'proving', 'waiting', 'submitting', 'submitted', 'confirmed'];
    const idx = order.indexOf(s.phase);
    const bad = ['failed', 'expired'].includes(s.phase);
    const t = st.wallet?.tip?.height ?? 0;
    const conf = s.minedHeight ? t - s.minedHeight + 1 : 0;
    const target = st.settings.confirmationsTarget;
    const stepLi = (i, title, sub) => {
      const cls = bad && i === Math.max(idx, 1) ? 'bad' : idx > i || s.phase === 'confirmed' ? 'done' : idx === i ? 'now' : '';
      return h('li', { class: cls }, h('i', { class: 's' }), h('div', {}, title, sub && h('small', {}, sub)));
    };
    const proveSecs = s.provingSecs ?? (s.provingStartedAt ? (Date.now() - s.provingStartedAt) / 1000 : 0);
    const steps = h('ol', { class: 'steps' },
      stepLi(0, 'Catch up with the chain', s.referenceHeight ? `Proof references block ${s.referenceHeight.toLocaleString()}` : null),
      stepLi(1, 'Build the zero-knowledge proof', s.phase === 'proving' ? h('span', { class: 'timer', id: 'ptimer' }, duration(proveSecs)) : s.provingSecs != null ? `Took ${duration(s.provingSecs)}${s.actionBytes ? `, ${Math.round(s.actionBytes / 1024)} KB` : ''}` : 'Runs on your computer'),
      stepLi(2, st.settings.dandelion.enabled ? 'Dandelion stem' : 'Choose node', s.node ? `Via ${s.node}${st.settings.tor.enabled ? ' over Tor' : ''}` : st.settings.dandelion.enabled ? 'Random node after a random delay' : null),
      stepLi(3, 'Submit to the network', s.ack ? h('span', { class: 'mono' }, shortHash(s.ack, 12)) : null),
      stepLi(4, 'Waiting for a block', s.referenceHeight && !s.minedHeight ? `Must be included by block ${(s.referenceHeight + NETWORK.referenceWindow + 1).toLocaleString()}` : null),
      stepLi(5, 'Confirmed', s.minedHeight ? `Block ${s.minedHeight.toLocaleString()}, ${conf} of ${target} confirmations` : null));
    const msgs = [];
    if (s.error) msgs.push(h('div', { class: `banner ${bad ? 'bad' : 'warn'}` }, h('i', { class: `dot ${bad ? 'bad' : 'warn'}` }), h('div', {}, s.error)));
    const btns = [];
    if (s.phase === 'uncertain' && s.attempt) btns.push(h('button', { class: 'btn primary', onclick: () => engine('rebroadcast', { localId: s.localId }).then(() => toast('Sending the same proof again')).catch((e) => toast(e.message, true)) }, 'Send again'));
    if (s.phase === 'failed') btns.push(h('button', { class: 'btn', onclick: () => engine('cancelSend', { localId: s.localId }).then(() => go('home')).catch((e) => toast(e.message, true)) }, s.attempt ? 'Cancel and free funds' : 'Dismiss'));
    if (s.phase === 'expired') btns.push(h('button', { class: 'btn primary', onclick: () => go('settings', { section: 'wallet' }) }, 'Release held funds'));
    if (['confirmed', 'expired'].includes(s.phase)) btns.push(h('button', { class: 'btn', onclick: () => engine('dismissSend', { localId: s.localId }).then(() => go('activity')) }, 'Remove from list'));
    btns.push(h('button', { class: 'btn', onclick: () => go('home') }, 'Back to wallet'));
    box.replaceChildren(
      h('h1', {}, s.kind === 'merge' ? `Merging ${amt(s.amount)} HGN` : `Sending ${amt(s.amount)} HGN`),
      h('p', { class: 'muted mono', style: 'font-size:12px' }, s.kind === 'merge' ? 'To your own address' : `To ${s.recipient.slice(0, 14)}…${s.recipient.slice(-8)}`),
      s.note && h('p', { class: 'muted' }, `“${s.note}”`),
      steps, ...msgs,
      h('details', {}, h('summary', { class: 'muted', style: 'cursor:pointer;font-size:13px' }, 'Log'),
        h('div', { style: 'font-size:12px;margin-top:6px' }, s.log.map((l) => h('div', { class: 'muted' }, `${new Date(l.t).toLocaleTimeString()}  ${l.text}`)))),
      h('div', { class: 'stack' }, btns),
    );
    clearInterval(timer);
    if (s.phase === 'proving') {
      timer = setInterval(() => {
        const el = document.getElementById('ptimer');
        if (!el) return clearInterval(timer);
        el.textContent = duration((Date.now() - s.provingStartedAt) / 1000);
      }, 1000);
    }
  };
  fill(S);
  return { el: h('div', { class: 'screen' }, box), update: fill };
};

// ---------------------------------------------------------------- activity
SCREENS.activity = () => {
  const list = h('div', { class: 'list' });
  const chips = h('div', { class: 'chips', role: 'tablist' });
  const fill = (st) => {
    chips.replaceChildren(...[['all', 'All'], ['in', 'Received'], ['out', 'Sent']].map(([k, l]) =>
      h('button', { class: `chip ${activityFilter === k ? 'on' : ''}`, role: 'tab', 'aria-selected': activityFilter === k, onclick: () => { activityFilter = k; fill(S); } }, l)));
    const rows = activityRows(st);
    list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'empty' }, 'Nothing here yet.')]));
  };
  fill(S);
  return { el: h('div', { class: 'screen' }, h('h1', {}, 'Activity'), chips, list), update: fill };
};

// ---------------------------------------------------------------- network
SCREENS.network = () => {
  const box = h('div');
  const fill = (st) => {
    const n = st.node ?? {};
    const behind = n.height != null && st.sync.walletHeight != null ? n.height - st.sync.walletHeight : null;
    const blocks = (st.recentBlocks ?? []).slice(0, 12);
    box.replaceChildren(
      h('div', { class: 'card' },
        h('div', { style: 'display:flex;gap:10px;align-items:center;margin-bottom:10px' }, h('i', { class: `dot ${nodeDot()}` }), h('b', {}, n.label ?? 'Node'), h('span', { class: 'muted mono', style: 'margin-left:auto' }, n.url ?? '')),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Status'), h('dd', {}, n.online ? (n.nodeSyncing ? 'Online, catching up' : 'Online') : 'Offline'),
          h('dt', {}, 'Height'), h('dd', { class: 'num' }, n.height?.toLocaleString() ?? '—'),
          h('dt', {}, 'Best block'), h('dd', { class: 'mono' }, shortHash(n.hash, 10) || '—'),
          h('dt', {}, 'Last block'), h('dd', {}, n.timestamp ? timeAgo(n.timestamp) : '—'),
          h('dt', {}, 'Peers'), h('dd', { class: 'num' }, n.peers ?? '—'),
          h('dt', {}, 'Latency'), h('dd', { class: 'num' }, n.latencyMs != null ? `${n.latencyMs} ms` : '—'),
          h('dt', {}, 'Software'), h('dd', {}, n.version || '—'),
          h('dt', {}, 'RPC policy'), h('dd', {}, n.rpcPolicy ?? '—'),
          h('dt', {}, 'Accepts sends'), h('dd', {}, n.canSubmit ? 'Yes' : 'No'),
          h('dt', {}, 'Checked'), h('dd', {}, n.checkedAt ? timeAgo(n.checkedAt) : '—')),
        h('div', { class: 'stack', style: 'grid-template-columns:1fr 1fr' },
          h('button', { class: 'btn small', onclick: () => engine('checkNode').then(() => toast('Node checked')).catch((e) => toast(e.message, true)) }, 'Check again'),
          h('button', { class: 'btn small', onclick: () => go('nodes', { back: 'network' }) }, 'Manage nodes'))),
      (n.checks ?? []).length > 0 && h('div', { class: 'card checks' }, n.checks.map((c) => h('div', {}, h('i', { class: `dot ${c.ok ? 'ok' : c.id === 'submit' || c.id === 'version' || c.id === 'sync' ? 'warn' : 'bad'}` }), h('span', {}, c.text)))),
      h('h2', {}, 'Wallet sync'),
      h('div', { class: 'card' }, h('dl', { class: 'kv' },
        h('dt', {}, 'Wallet height'), h('dd', { class: 'num' }, st.sync.walletHeight?.toLocaleString() ?? '—'),
        h('dt', {}, 'Behind'), h('dd', { class: 'num' }, behind != null ? `${Math.max(0, behind).toLocaleString()} blocks` : '—'),
        h('dt', {}, 'Speed'), h('dd', { class: 'num' }, st.sync.blocksPerSec ? `${st.sync.blocksPerSec.toFixed(1)} blocks/s` : '—'),
        h('dt', {}, 'Time left'), h('dd', { class: 'num' }, st.sync.etaSecs && behind > 1 ? duration(st.sync.etaSecs) : '—'),
        h('dt', {}, 'Activity'), h('dd', {}, st.sync.error ? st.sync.error : st.sync.phase ?? '—'),
        h('dt', {}, 'Last sync'), h('dd', {}, st.sync.lastSyncAt ? timeAgo(st.sync.lastSyncAt) : '—'))),
      h('h2', {}, 'Privacy route'),
      h('div', { class: 'card checks' },
        h('div', {}, h('i', { class: `dot ${st.settings.tor.enabled ? (st.tor?.verified && st.tor?.applied ? 'ok' : st.tor?.verified === false || !st.tor?.applied ? 'bad' : 'warn') : ''}` }), h('span', {}, st.settings.tor.enabled ? (st.tor?.verified ? `Tor verified (exit ${st.tor.ip})` : !st.tor?.applied ? `Tor on but not active: ${st.tor?.reason ?? 'proxy not applied'}` : st.tor?.verified === false ? 'Tor on but not reachable' : 'Tor on, not tested yet') : 'Tor off: the node sees your IP')),
        h('div', {}, h('i', { class: `dot ${st.settings.dandelion.enabled ? 'ok' : ''}` }), h('span', {}, st.settings.dandelion.enabled ? `Dandelion on: sends leave through a random node after ${st.settings.dandelion.minDelay}–${st.settings.dandelion.maxDelay}s` : 'Dandelion off: sends go straight to your node'))),
      h('h2', {}, 'Latest blocks'),
      h('div', { class: 'card explorer' }, blocks.length ? blocks.map((b) => h('div', { class: 'blk' },
        h('span', { class: 'num' }, `#${b.height.toLocaleString()}`),
        h('span', { class: 'mono muted' }, b.hash ? shortHash(b.hash, 8) : ''),
        h('span', { class: 'muted num' }, `${b.txCount != null ? `${b.txCount} tx, ` : ''}${b.time ? timeAgo(b.time) : ''}`))) : h('div', { class: 'muted' }, 'No blocks loaded yet.')),
    );
  };
  fill(S);
  return { el: h('div', { class: 'screen' }, h('h1', {}, 'Network'), box), update: fill };
};

// ---------------------------------------------------------------- nodes
SCREENS.nodes = ({ back = 'settings' } = {}) => {
  const list = h('div');
  const result = h('div');
  const url = h('input', { class: 'in mono', id: 'nurl', placeholder: 'http://127.0.0.1:9944' });
  const label = h('input', { class: 'in', id: 'nlabel', placeholder: 'Name, e.g. Home server' });
  const origin = `chrome-extension://${chrome.runtime.id}`;
  const cmd = `python3 start.py --public-submit-rpc --rpc-external --rpc-cors ${origin}`;
  const drawList = () => {
    list.replaceChildren(...S.settings.nodes.map((n, i) => h('div', { class: 'row', style: 'grid-template-columns:22px 1fr auto;cursor:default' },
      h('input', { type: 'radio', name: 'active', checked: i === S.settings.activeNode, 'aria-label': `Use ${n.label}`, onchange: () => engine('setSettings', { patch: { activeNode: i } }).then(drawList) }),
      h('div', {}, h('div', { class: 't1' }, n.label), h('div', { class: 't2 mono' }, n.url), h('div', { class: 't2' }, n.canSubmit ? 'Syncs and sends' : n.canSubmit === false ? 'Sync only' : 'Not checked yet')),
      S.settings.nodes.length > 1 && h('button', { class: 'iconbtn', 'aria-label': `Remove ${n.label}`, onclick: () => {
        const nodes = S.settings.nodes.filter((_, k) => k !== i);
        const activeNode = Math.min(S.settings.activeNode >= i && S.settings.activeNode > 0 ? S.settings.activeNode - (S.settings.activeNode > i ? 1 : 0) : S.settings.activeNode, nodes.length - 1);
        engine('setSettings', { patch: { nodes, activeNode } }).then(drawList);
      } }, svg('x')))));
  };
  drawList();
  const add = h('button', { class: 'btn primary' }, 'Test and add');
  add.onclick = busyButton(add, async () => {
    let u;
    try { u = new URL(url.value.trim()); } catch { throw new Error('Enter a full URL like http://192.168.1.20:9944'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('Use http:// or https://');
    const base = `${u.protocol}//${u.host}`;
    const granted = await chrome.permissions.request({ origins: [`${base}/*`] });
    if (!granted) throw new Error('Chrome permission is needed to contact this node.');
    const node = { url: `${base}${u.pathname.replace(/\/$/, '')}`, label: label.value.trim() || u.hostname };
    const out = await engine('checkNode', { node });
    result.replaceChildren(h('div', { class: 'card checks' }, out.checks.map((c) => h('div', {}, h('i', { class: `dot ${c.ok ? 'ok' : c.id === 'reach' || c.id === 'network' ? 'bad' : 'warn'}` }), h('span', {}, c.text)))));
    if (!out.online || !out.networkOk) throw new Error('Not added — fix the problems above.');
    node.canSubmit = out.canSubmit;
    const nodes = [...S.settings.nodes.filter((n) => n.url !== node.url), node];
    await engine('setSettings', { patch: { nodes, activeNode: nodes.length - 1 } });
    url.value = ''; label.value = '';
    drawList();
    toast('Node added');
  });
  return h('div', { class: 'screen' },
    h('button', { class: 'back', onclick: () => go(back) }, svg('back'), 'Back'),
    h('h1', {}, 'Nodes'),
    h('p', { class: 'muted' }, 'The wallet reads public chain data from a Hegemon node. Your own node is the most private and the fastest to sync.'),
    list,
    h('h2', {}, 'Add a node'),
    h('label', { class: 'f', for: 'nurl' }, h('span', {}, 'RPC address'), url),
    h('label', { class: 'f', for: 'nlabel' }, h('span', {}, 'Name'), label),
    h('div', { class: 'stack' }, add), result,
    h('h2', {}, 'Run a node that accepts sends'),
    h('p', { class: 'muted', style: 'font-size:13px' }, 'On the same Mac, start the v0.11.4 node with ', h('span', { class: 'mono' }, '--wallet-rpc'), '. For a node on another machine, start it with public submission and allow this extension:'),
    h('div', { class: 'addrbox', style: 'max-height:none' }, cmd),
    h('div', { class: 'stack', style: 'grid-template-columns:1fr 1fr' },
      h('button', { class: 'btn small', onclick: () => copy(cmd, 'Command copied') }, 'Copy command'),
      h('button', { class: 'btn small', onclick: () => copy(origin, 'Extension origin copied') }, 'Copy origin')),
    h('p', { class: 'muted', style: 'font-size:12px;margin-top:10px' }, 'Public nodes allow about 60 requests a minute, so a first sync over a public node is slow. Keys and proofs never leave this browser either way.'),
  );
};

// ---------------------------------------------------------------- settings
SCREENS.settings = ({ section } = {}) => {
  const s = S.settings;
  const set = (patch) => engine('setSettings', { patch });
  const toggle = (title, sub, checked, onchange) => h('div', { class: 'toggle' },
    h('div', {}, h('b', {}, title), sub && h('span', {}, sub)),
    h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked), 'aria-label': title }), h('i')));

  const torHost = h('input', { class: 'in mono', value: s.tor.host, 'aria-label': 'Tor host' });
  const torPort = h('input', { class: 'in mono', value: s.tor.port, inputmode: 'numeric', 'aria-label': 'Tor port' });
  const torState = h('div', { class: 'hint' });
  const testTor = h('button', { class: 'btn small' }, 'Test Tor');
  testTor.onclick = busyButton(testTor, async () => {
    await set({ tor: { ...S.settings.tor, host: torHost.value.trim(), port: Number(torPort.value) || 9050 } });
    const r = await engine('testTor');
    torState.className = `hint ${r.verified ? 'ok' : 'err'}`;
    torState.textContent = r.verified ? `Connected through Tor (exit ${r.ip})` : r.error ?? 'Traffic is not going through Tor';
  });

  const dMin = h('input', { class: 'in num', value: s.dandelion.minDelay, inputmode: 'numeric', 'aria-label': 'Minimum delay seconds' });
  const dMax = h('input', { class: 'in num', value: s.dandelion.maxDelay, inputmode: 'numeric', 'aria-label': 'Maximum delay seconds' });
  const saveD = () => set({ dandelion: { ...S.settings.dandelion, minDelay: Math.max(0, Number(dMin.value) || 0), maxDelay: Math.max(Number(dMin.value) || 0, Number(dMax.value) || 0) } });
  dMin.onchange = dMax.onchange = saveD;

  const lockSeg = h('div', { class: 'seg' }, [5, 15, 30, 60].map((m) => h('button', { class: s.autoLockMinutes === m ? 'on' : '', onclick: () => set({ autoLockMinutes: m }).then(() => go('settings', { section: 'security' })) }, `${m} min`)));
  const confSeg = h('div', { class: 'seg' }, [1, 3, 6, 12].map((c) => h('button', { class: s.confirmationsTarget === c ? 'on' : '', onclick: () => set({ confirmationsTarget: c }).then(() => go('settings')) }, `${c}`)));

  const notes = (S.wallet?.notes ?? []).filter((n) => !n.spent && n.asset === 0 && n.kind === 'ordinary').sort((a, b) => Number(BigInt(a.value) - BigInt(b.value)));
  const mergeBtn = h('button', { class: 'btn small', disabled: notes.length < 3 }, 'Merge two smallest notes');
  mergeBtn.onclick = () => passwordSheet('Merge notes', `Combines your two smallest notes (${notes.slice(0, 2).map((n) => formatHgn(n.value)).join(' + ')} HGN) into one, paying the network fee. Useful when sends need more than two notes.`, 'Merge', async (pw) => {
    const id = await engine('merge', { password: pw, positions: notes.slice(0, 2).map((n) => n.position) });
    go('progress', { id });
  });

  const el = h('div', { class: 'screen' },
    h('h1', {}, 'Settings'),

    h('h2', { id: 'sec-nodes' }, 'Node'),
    h('div', { class: 'toggle', style: 'cursor:pointer', onclick: () => go('nodes') },
      h('div', {}, h('b', {}, s.nodes[s.activeNode]?.label), h('span', { class: 'mono' }, s.nodes[s.activeNode]?.url)), h('span', { class: 'muted' }, 'Manage')),

    h('h2', { id: 'sec-privacy' }, 'Privacy'),
    toggle('Route node traffic through Tor', 'Needs Tor running on this Mac (Tor Browser uses port 9150, the tor service 9050).', s.tor.enabled, (v) => set({ tor: { ...S.settings.tor, enabled: v } }).then(() => v && testTor.click())),
    h('div', { style: 'display:grid;grid-template-columns:2fr 1fr auto;gap:6px;margin-top:8px;align-items:center' }, torHost, torPort, testTor), torState,
    toggle('Dandelion-style sending', 'Sends leave through a randomly picked node after a random delay, never through the node you sync from (when you have two or more).', s.dandelion.enabled, (v) => set({ dandelion: { ...S.settings.dandelion, enabled: v } })),
    h('div', { style: 'display:grid;grid-template-columns:auto 1fr auto 1fr auto;gap:6px;align-items:center;margin-top:8px;font-size:13px' }, h('span', { class: 'muted' }, 'Delay'), dMin, h('span', { class: 'muted' }, 'to'), dMax, h('span', { class: 'muted' }, 'seconds')),
    toggle('Hide amounts', 'Balances and amounts show as ◈◈◈◈◈ until you tap the eye.', s.hideAmounts, (v) => set({ hideAmounts: v })),

    h('h2', {}, 'Notifications'),
    toggle('HGN received', null, s.notifications.received, (v) => set({ notifications: { ...S.settings.notifications, received: v } })),
    toggle('Send confirmed', null, s.notifications.confirmed, (v) => set({ notifications: { ...S.settings.notifications, confirmed: v } })),
    toggle('Send failed or expired', null, s.notifications.failed, (v) => set({ notifications: { ...S.settings.notifications, failed: v } })),
    toggle('Node offline or reorg', null, s.notifications.node, (v) => set({ notifications: { ...S.settings.notifications, node: v } })),
    h('label', { class: 'f' }, h('span', {}, 'Confirmations before a send counts as final'), confSeg),

    h('h2', { id: 'sec-security' }, 'Security'),
    h('label', { class: 'f' }, h('span', {}, 'Lock after inactivity'), lockSeg),
    h('div', { class: 'stack' },
      h('button', { class: 'btn', onclick: () => passwordSheet('Show recovery phrase', 'Make sure nobody can see your screen.', 'Show', async (pw) => {
        const phrase = await engine('revealPhrase', { password: pw });
        sheet((close) => [h('h2', {}, 'Your 24 words'), h('div', { class: 'words' }, phrase.split(' ').map((w) => h('span', {}, w))), h('div', { class: 'stack' }, h('button', { class: 'btn', onclick: close }, 'Hide'))]);
      }) }, 'Show recovery phrase'),
      h('button', { class: 'btn', onclick: changePasswordSheet }, 'Change password'),
      h('button', { class: 'btn', onclick: () => engine('lock').catch((e) => toast(e.message, true)) }, 'Lock now')),

    h('h2', { id: 'sec-wallet' }, 'Wallet'),
    h('div', { class: 'stack' },
      mergeBtn,
      h('button', { class: 'btn', onclick: async () => {
        const r = await engine('exportBackup');
        const url = URL.createObjectURL(new Blob([new Uint8Array(r.bytes)], { type: 'application/octet-stream' }));
        h('a', { href: url, download: r.name }).click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        toast('Encrypted backup saved');
      } }, 'Download encrypted wallet file'),
      h('button', { class: 'btn', onclick: () => passwordSheet('Release held funds', 'Rebuilds the wallet from your keys and rescans the chain. Funds held by sends that expired without confirmation become available again. Confirmed history is kept on chain.', 'Rescan wallet', async (pw) => { await engine('releaseHeld', { password: pw }); toast('Rescanning from block 0'); }) }, 'Release held funds (rescan)'),
      h('button', { class: 'btn danger', onclick: () => passwordSheet('Remove wallet', 'Erases the wallet from this browser. You can only get it back with your 24 words.', 'Remove wallet', async (pw) => { await engine('wipe', { password: pw }); }) }, 'Remove wallet from this browser')),

    h('h2', {}, 'About'),
    h('dl', { class: 'kv card' },
      h('dt', {}, 'Extension'), h('dd', {}, chrome.runtime.getManifest().version),
      h('dt', {}, 'Wallet core'), h('dd', {}, S.core?.core ?? S.core?.error ?? '—'),
      h('dt', {}, 'Proof relation'), h('dd', { class: 'mono' }, S.core?.relation_digest ? shortHash(S.core.relation_digest, 10) : '—'),
      h('dt', {}, 'Network'), h('dd', {}, NETWORK.name),
      h('dt', {}, 'Genesis'), h('dd', { class: 'mono' }, shortHash(NETWORK.genesis, 10)),
      h('dt', {}, 'Manifest SHA-256'), h('dd', { class: 'mono' }, shortHash(NETWORK.manifestSha256, 10)),
      h('dt', {}, 'Extension origin'), h('dd', { class: 'mono' }, `chrome-extension://${chrome.runtime.id.slice(0, 8)}…`)),
  );
  if (section) setTimeout(() => document.getElementById(`sec-${section}`)?.scrollIntoView({ block: 'start' }), 30);
  return el;
};

function passwordSheet(title, text, action, fn) {
  sheet((close) => {
    const pw = h('input', { class: 'in', type: 'password', id: 'cpw', autocomplete: 'current-password' });
    const hint = h('div', { class: 'hint' });
    const b = h('button', { class: `btn ${/remove/i.test(action) ? 'danger' : 'primary'}` }, action);
    b.onclick = busyButton(b, async () => {
      try { await fn(pw.value); close(); } catch (e) { hint.className = 'hint err'; hint.textContent = e.message; throw e; }
    });
    pw.onkeydown = (e) => e.key === 'Enter' && b.click();
    return [h('h2', {}, title), h('p', { class: 'muted' }, text), h('label', { class: 'f', for: 'cpw' }, h('span', {}, 'Password'), pw), hint, h('div', { class: 'stack' }, b, h('button', { class: 'btn', onclick: close }, 'Cancel'))];
  });
}

function changePasswordSheet() {
  sheet((close) => {
    const old = h('input', { class: 'in', type: 'password', id: 'oldpw', autocomplete: 'current-password' });
    const pf = passwordFields();
    const hint = h('div', { class: 'hint' });
    const b = h('button', { class: 'btn primary' }, 'Change password');
    b.onclick = busyButton(b, async () => {
      try {
        await engine('changePassword', { password: old.value, newPassword: pf.value() });
        close();
        toast('Password changed — rescanning the chain');
      } catch (e) { hint.className = 'hint err'; hint.textContent = e.message; throw e; }
    });
    return [h('h2', {}, 'Change password'),
      h('p', { class: 'muted', style: 'font-size:13px' }, 'The wallet file is re-encrypted and rescanned from block 0. Finish pending sends first.'),
      h('label', { class: 'f', for: 'oldpw' }, h('span', {}, 'Current password'), old), ...pf.el, hint,
      h('div', { class: 'stack' }, b, h('button', { class: 'btn', onclick: close }, 'Cancel'))];
  });
}

// ================================================================ boot
render();
engine('getState').then(onState).catch((e) => {
  $app.replaceChildren(h('div', { class: 'screen center' }, h('h1', {}, 'Wallet engine failed to start'), h('p', { class: 'muted' }, e.message)));
});
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && engine('touch').catch(() => {}));

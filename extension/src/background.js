// Service worker: keeps the engine (offscreen document) alive, schedules sync,
// and owns the APIs the engine cannot call: badge, notifications, Tor proxy.
import { PRIVATE_HOST } from './lib/net.js';

const OFFSCREEN = 'offscreen.html';
let creating = null;

async function ensureEngine() {
  const url = chrome.runtime.getURL(OFFSCREEN);
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (existing.length) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN,
      reasons: ['WORKERS'],
      justification: 'Runs the Hegemon wallet core (WebAssembly) for syncing and private proofs',
    })
    .finally(() => (creating = null));
  await creating;
}

async function toEngine(cmd, args) {
  await ensureEngine();
  for (let i = 0; i < 20; i++) {
    try {
      const r = await chrome.runtime.sendMessage({ to: 'engine', cmd, args });
      if (r) return r;
    } catch { /* engine still booting */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { ok: false, error: 'engine not responding' };
}

function setupAlarm() {
  chrome.alarms.create('tick', { periodInMinutes: 1, delayInMinutes: 0.1 });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  setupAlarm();
  await ensureEngine();
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab=1') });
});
chrome.runtime.onStartup.addListener(async () => {
  setupAlarm();
  await ensureEngine();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'tick') toEngine('tick');
});

// ---------------------------------------------------------------- Tor proxy
function pacFor(settings) {
  const host = String(settings.tor.host ?? '').trim();
  const port = Number(settings.tor.port);
  // The values are written into a PAC script: accept only a plain host and port.
  if (!/^[a-z0-9.-]{1,253}$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Tor proxy address is not valid');
  }
  const hosts = new Set(['check.torproject.org']);
  for (const n of settings.nodes) {
    try {
      const h = new URL(n.url).hostname;
      if (!PRIVATE_HOST.test(h)) hosts.add(h.toLowerCase());
    } catch { /* ignore */ }
  }
  const list = JSON.stringify([...hosts]);
  // Only node traffic (and .onion) goes through Tor; normal browsing stays untouched.
  // No DIRECT fallback: if Tor is down, node requests fail instead of leaking your IP.
  return `function FindProxyForURL(url, host) {
    var hosts = ${list};
    host = host.toLowerCase();
    if (dnsDomainIs(host, '.onion')) return 'SOCKS5 ${host}:${port}';
    for (var i = 0; i < hosts.length; i++) if (host === hosts[i]) return 'SOCKS5 ${host}:${port}';
    return 'DIRECT';
  }`;
}

/** Returns { applied, reason? }. The engine blocks node traffic unless applied is true. */
async function applyProxy(settings) {
  if (!chrome.proxy) return { applied: false, reason: 'Proxy control is not available in this browser' };
  const ctl = await chrome.proxy.settings.get({});
  if (!settings?.tor?.enabled) {
    if (ctl.levelOfControl === 'controlled_by_this_extension') await chrome.proxy.settings.clear({ scope: 'regular' });
    return { applied: false };
  }
  if (ctl.levelOfControl !== 'controllable_by_this_extension' && ctl.levelOfControl !== 'controlled_by_this_extension') {
    return {
      applied: false,
      reason: ctl.levelOfControl === 'controlled_by_other_extensions'
        ? 'Another extension controls Chrome\'s proxy settings'
        : 'Chrome does not allow this extension to set the proxy',
    };
  }
  let pac;
  try { pac = pacFor(settings); } catch (e) { return { applied: false, reason: e.message }; }
  await chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: { data: pac, mandatory: true } }, scope: 'regular' });
  const after = await chrome.proxy.settings.get({});
  const ok = after.levelOfControl === 'controlled_by_this_extension' && after.value?.mode === 'pac_script';
  return ok ? { applied: true } : { applied: false, reason: 'Chrome did not accept the proxy settings' };
}

// ---------------------------------------------------------------- UI helpers
function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon-128.png',
    title,
    message,
    priority: 1,
  });
}

chrome.notifications.onClicked.addListener(() => {
  chrome.action.openPopup?.().catch(() => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab=1') }));
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Only this extension's own pages may command the service worker.
  if (sender.id !== chrome.runtime.id || msg?.to !== 'sw') return false;
  (async () => {
    switch (msg.cmd) {
      case 'ensureEngine':
        await ensureEngine();
        return true;
      case 'notify':
        notify(msg.title, msg.message);
        return true;
      case 'badge':
        await chrome.action.setBadgeText({ text: msg.text ?? '' });
        await chrome.action.setBadgeBackgroundColor({ color: msg.color ?? '#0E1C36' });
        if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
        await chrome.action.setTitle({ title: msg.title ?? 'Joker Hegemon Wallet' });
        return true;
      case 'apply-proxy':
        return applyProxy(msg.settings);
      default:
        return false;
    }
  })()
    .then((r) => reply({ ok: true, result: r }))
    .catch((e) => reply({ ok: false, error: e.message }));
  return true;
});

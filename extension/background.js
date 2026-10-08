import { t } from './lib/i18n.js';
import { STATE_KEYS, badgeFor, buildProxyConfig, isConnectionFailure, isProxiedHost, sanitizeState } from './lib/rules.js';

async function readState() {
  return sanitizeState(await chrome.storage.local.get([...STATE_KEYS]));
}

// Proxy and badge updates run one at a time, each reading the latest stored state,
// so a slower update can never overwrite a newer one.
let queue = Promise.resolve();

function enqueue(task) {
  queue = queue.then(task).catch((error) => console.error(error));
}

async function applyProxy(state) {
  const value = buildProxyConfig(state);
  await chrome.proxy.settings.set({ value, scope: 'regular' });
}

// On: WebRTC may only use proxied connections (SOCKS5 has no UDP, so it falls back to proxied TCP
// or fails). Off: clear our setting so Chrome's default applies.
async function applyWebRtc(state) {
  const setting = chrome.privacy.network.webRTCIPHandlingPolicy;
  if (state.blockWebRtc) await setting.set({ value: 'disable_non_proxied_udp' });
  else await setting.clear({});
}

function pageKey(tabId) {
  return `page:${tabId}`;
}

async function setBadge(badge, tabId) {
  const target = tabId === undefined ? {} : { tabId };
  await chrome.action.setBadgeText({ ...target, text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ ...target, color: badge.color });
  await chrome.action.setTitle({ ...target, title: badge.title });
}

async function setTabBadge(state, tabId, hosts) {
  try {
    await setBadge(badgeFor(state, hosts, t), tabId);
  } catch {
    // The tab was closed meanwhile.
  }
}

// Browser-wide badge plus an explicit badge for every open tab.
async function updateBadge(state) {
  await setBadge(badgeFor(state, null, t));
  const [tabs, pages] = await Promise.all([chrome.tabs.query({}), chrome.storage.session.get(null)]);
  for (const tab of tabs) await setTabBadge(state, tab.id, pages[pageKey(tab.id)] ?? {});
}

// Coalesces bursts of page-host writes into one badge update per tab.
const pendingTabBadges = new Set();

function refreshTabBadge(tabId) {
  if (pendingTabBadges.has(tabId)) return;
  pendingTabBadges.add(tabId);
  enqueue(async () => {
    pendingTabBadges.delete(tabId);
    const key = pageKey(tabId);
    const hosts = (await chrome.storage.session.get(key))[key] ?? {};
    await setTabBadge(await readState(), tabId, hosts);
  });
}

function sync() {
  enqueue(async () => {
    const state = await readState();
    await applyProxy(state);
    await applyWebRtc(state);
    await updateBadge(state);
  });
}

function refreshBadge() {
  enqueue(async () => updateBadge(await readState()));
}

function recordProxyError() {
  return chrome.storage.local.set({ lastProxyError: Date.now() });
}

function clearProxyError() {
  return chrome.storage.local.set({ lastProxyError: null });
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  sync();
});

chrome.runtime.onStartup.addListener(() => {
  sync();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (['mode', 'domains', 'proxy', 'blockWebRtc'].some((key) => key in changes)) {
    sync();
  } else if ('lastProxyError' in changes) {
    refreshBadge();
  }
});

chrome.proxy.onProxyError.addListener(() => {
  recordProxyError();
});

const PROXY_ERROR_RE = /^net::ERR_(PROXY_|SOCKS_|TUNNEL_CONNECTION_FAILED)/;

// Per-tab page hosts live in storage.session (key page:<tabId>, value {host: {proxied, failed}})
// so they survive service worker restarts and the popup can read them.
// Writes for a tab are chained to keep read-modify-write consistent.
const pageWrites = new Map();

function updatePage(tabId, mutate) {
  const prev = pageWrites.get(tabId) ?? Promise.resolve();
  const next = prev.then(async () => {
    const key = pageKey(tabId);
    const hosts = (await chrome.storage.session.get(key))[key] ?? {};
    if (!mutate(hosts)) return;
    await chrome.storage.session.set({ [key]: hosts });
    refreshTabBadge(tabId);
  });
  pageWrites.set(tabId, next.catch(() => {}));
  return next;
}

function recordPageHost(tabId, host, proxied, failed) {
  if (tabId < 0) return;
  updatePage(tabId, (hosts) => {
    const entry = hosts[host];
    const merged = { proxied: Boolean(entry?.proxied || proxied), failed: Boolean(entry?.failed || failed) };
    if (entry?.proxied === merged.proxied && entry?.failed === merged.failed) return false;
    hosts[host] = merged;
    return true;
  });
}

// A server redirect fires onBeforeRequest again with the same requestId; only a new
// main-frame request starts a new page, so hosts along a redirect chain (e.g. login hops) are kept.
const mainFrameRequest = new Map();

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0 || mainFrameRequest.get(details.tabId) === details.requestId) return;
    mainFrameRequest.set(details.tabId, details.requestId);
    const prev = pageWrites.get(details.tabId) ?? Promise.resolve();
    pageWrites.set(
      details.tabId,
      prev
        .then(() => chrome.storage.session.remove(pageKey(details.tabId)))
        .then(() => refreshTabBadge(details.tabId))
        .catch(() => {}),
    );
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
);

// Chrome drops a tab's own badge when it loads a new document, so re-apply it on load progress.
// Pages without web requests (chrome://, file://, extension pages) start with no page hosts.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === undefined) return;
  if (changeInfo.status === 'loading' && !/^https?:/.test(tab.url ?? '')) {
    mainFrameRequest.delete(tabId);
    updatePage(tabId, (hosts) => {
      if (Object.keys(hosts).length === 0) return false;
      for (const host of Object.keys(hosts)) delete hosts[host];
      return true;
    });
  }
  refreshTabBadge(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pageWrites.delete(tabId);
  pendingTabBadges.delete(tabId);
  mainFrameRequest.delete(tabId);
  chrome.storage.session.remove(pageKey(tabId));
});

chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    readState().then((state) => {
      const host = hostOf(details.url);
      if (host !== null) recordPageHost(details.tabId, host, isProxiedHost(state.mode, state.domains, host), false);
    });
  },
  { urls: ['<all_urls>'] },
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    // Every requested host is listed; only network failures mark it failed (not e.g. ERR_ABORTED,
    // ERR_BLOCKED_BY_CLIENT or ERR_BLOCKED_BY_ORB).
    readState().then((state) => {
      const host = hostOf(details.url);
      if (host === null) return;
      const proxied = isProxiedHost(state.mode, state.domains, host);
      recordPageHost(details.tabId, host, proxied, isConnectionFailure(details.error));
      if (proxied && PROXY_ERROR_RE.test(details.error)) recordProxyError();
    });
  },
  { urls: ['<all_urls>'] },
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    readState().then((state) => {
      const host = hostOf(details.url);
      if (host === null) return;
      const proxied = isProxiedHost(state.mode, state.domains, host);
      recordPageHost(details.tabId, host, proxied, false);
      if (proxied && !details.fromCache && state.lastProxyError !== null) clearProxyError();
    });
  },
  { urls: ['<all_urls>'] },
);

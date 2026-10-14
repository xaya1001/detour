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
    const results = await Promise.allSettled([applyProxy(state), applyWebRtc(state)]);
    for (const result of results) if (result.status === 'rejected') console.error(result.reason);
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
  enqueue(recordProxyError);
});

const PROXY_ERROR_RE = /^net::ERR_(PROXY_|SOCKS_|TUNNEL_CONNECTION_FAILED)/;

// Request contexts retain the page generation they started on. Late completions from
// a previous document cannot repopulate the new page or a closed tab.
const pages = new Map();
const requests = new Map();

function pageFor(tabId) {
  if (!pages.has(tabId)) pages.set(tabId, { generation: 0, mainRequest: null, active: true });
  return pages.get(tabId);
}

function contextFor(details) {
  const known = requests.get(details.requestId);
  if (known) return known;
  if (details.tabId < 0) return null;
  const page = pageFor(details.tabId);
  return { page, generation: page.generation };
}

function isCurrent(context) {
  return context?.page.active && context.generation === context.page.generation;
}

async function recordPageHost(details, context, proxied, failed) {
  if (details.tabId < 0 || !isCurrent(context)) return;
  const host = hostOf(details.url);
  if (host === null) return;
  const key = pageKey(details.tabId);
  const hosts = (await chrome.storage.session.get(key))[key] ?? {};
  if (!isCurrent(context)) return;
  const entry = hosts[host];
  const merged = { proxied: Boolean(entry?.proxied || proxied), failed: Boolean(entry?.failed || failed) };
  if (entry?.proxied === merged.proxied && entry?.failed === merged.failed) return;
  hosts[host] = merged;
  await chrome.storage.session.set({ [key]: hosts });
  refreshTabBadge(details.tabId);
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const page = pageFor(details.tabId);
    // Redirect hops reuse the main-frame request ID.
    if (details.type === 'main_frame' && page.mainRequest !== details.requestId) {
      page.mainRequest = details.requestId;
      page.generation++;
      enqueue(() => chrome.storage.session.remove(pageKey(details.tabId)));
    }
    const context = { page, generation: page.generation };
    requests.set(details.requestId, context);
    enqueue(async () => {
      const state = await readState();
      context.proxied = isProxiedHost(state.mode, state.domains, hostOf(details.url));
      await recordPageHost(details, context, context.proxied, false);
    });
  },
  { urls: ['<all_urls>'] },
);

// Chrome drops a tab's badge on document loads. Non-web documents have no hosts.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === undefined) return;
  if (changeInfo.status === 'loading' && !/^https?:/.test(tab.url ?? '')) {
    const page = pageFor(tabId);
    page.generation++;
    page.mainRequest = null;
    enqueue(() => chrome.storage.session.remove(pageKey(tabId)));
  }
  refreshTabBadge(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const page = pages.get(tabId);
  if (page) page.active = false;
  pages.delete(tabId);
  pendingTabBadges.delete(tabId);
  // Run removal after any write already in progress.
  enqueue(() => chrome.storage.session.remove(pageKey(tabId)));
});

function recordRequest(details, outcome) {
  const context = contextFor(details);
  if (outcome !== 'redirect') requests.delete(details.requestId);
  enqueue(async () => {
    const state = await readState();
    const host = hostOf(details.url);
    if (host === null) return;
    const proxied = context?.proxied ?? isProxiedHost(state.mode, state.domains, host);
    await recordPageHost(details, context, proxied, outcome === 'error' && isConnectionFailure(details.error));
    if (outcome === 'error' && proxied && PROXY_ERROR_RE.test(details.error)) await recordProxyError();
    // Error writes and successes share the same queue, preserving event order.
    if (outcome === 'complete' && proxied && !details.fromCache && state.lastProxyError !== null) await clearProxyError();
  });
}

chrome.webRequest.onBeforeRedirect.addListener((details) => recordRequest(details, 'redirect'), { urls: ['<all_urls>'] });
chrome.webRequest.onErrorOccurred.addListener((details) => recordRequest(details, 'error'), { urls: ['<all_urls>'] });
chrome.webRequest.onCompleted.addListener((details) => recordRequest(details, 'complete'), { urls: ['<all_urls>'] });

// Pure proxy rule logic shared by the service worker, the popup and the tests.
// No Chrome APIs here.

import { PSL_RULES } from './psl-data.js';

const PUBLIC_SUFFIX_RULES = new Set(PSL_RULES.split('\n'));

export const PROXY_SCHEMES = Object.freeze(['socks5', 'http']);
export const DEFAULT_PROXY = Object.freeze({ scheme: 'socks5', host: '127.0.0.1', port: 12345 });
export const MODES = Object.freeze(['auto', 'global', 'direct']);
export const DEFAULT_STATE = Object.freeze({
  mode: 'auto',
  domains: [],
  proxy: DEFAULT_PROXY,
  lastProxyError: null,
  blockWebRtc: false,
});
export const STATE_KEYS = Object.freeze(Object.keys(DEFAULT_STATE));

// Hosts that stay direct in global mode (Chrome bypassList syntax).
export const GLOBAL_BYPASS_LIST = Object.freeze([
  'localhost',
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '*.local',
  '<local>',
]);

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function isIPv4(host) {
  const m = IPV4_RE.exec(host);
  return m !== null && m.slice(1).every((part) => Number(part) <= 255);
}

export function isIPv6(host) {
  return host.startsWith('[') && host.endsWith(']');
}

/**
 * Normalize user or tab input into a bare lowercase hostname.
 * Accepts full URLs, "host:port", trailing dots and leading "*.".
 * Returns null when the result is not a valid hostname or IP.
 */
export function normalizeDomain(input) {
  if (typeof input !== 'string') return null;
  let host = input.trim().toLowerCase();
  if (host === '') return null;
  if (host.includes('://')) {
    try {
      const url = new URL(host);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      host = url.hostname;
    } catch {
      return null;
    }
  } else {
    host = host.split('/')[0];
    if (!host.startsWith('[')) host = host.split(':')[0];
  }
  host = host.replace(/^\*\./, '').replace(/\.+$/, '');
  if (host === '') return null;
  if (isIPv4(host) || isIPv6(host)) return host;
  const labels = host.split('.');
  if (!labels.every((label) => LABEL_RE.test(label))) return null;
  return host;
}

/**
 * Main domain = registrable domain per the Public Suffix List (public suffix plus one label),
 * e.g. mail.google.com -> google.com, www.google.com.hk -> google.com.hk.
 * A host that is itself a public suffix, and IP addresses, are returned as-is.
 */
export function mainDomain(host) {
  const normalized = normalizeDomain(host);
  if (normalized === null) return null;
  if (isIPv4(normalized) || isIPv6(normalized)) return normalized;
  const labels = normalized.split('.');
  // Index of the first public-suffix label; the default rule "*" makes the last label a suffix.
  let suffixStart = labels.length - 1;
  for (let i = 0; i < labels.length; i++) {
    const name = labels.slice(i).join('.');
    if (PUBLIC_SUFFIX_RULES.has('!' + name)) {
      suffixStart = i + 1;
      break;
    }
    const wildcard = i + 1 < labels.length && PUBLIC_SUFFIX_RULES.has('*.' + labels.slice(i + 1).join('.'));
    if (PUBLIC_SUFFIX_RULES.has(name) || wildcard) {
      suffixStart = i;
      break;
    }
  }
  return labels.slice(Math.max(suffixStart - 1, 0)).join('.');
}

/** List entries that equal host or are a parent of it, i.e. the entries that make host proxied in auto mode. */
export function coveringEntries(domains, host) {
  const h = String(host).toLowerCase();
  return domains.filter((d) => h === d || h.endsWith('.' + d));
}

/** True when host equals a listed domain or is one of its subdomains. */
export function matchesList(host, domains) {
  return coveringEntries(domains, host).length > 0;
}

/** Add a domain to the list without duplicates; returns the new list (or the same list). */
export function addDomain(domains, input) {
  const domain = normalizeDomain(input);
  if (domain === null) return { domains, domain: null, added: false };
  if (domains.includes(domain)) return { domains, domain, added: false };
  return { domains: [...domains, domain], domain, added: true };
}

/**
 * Merge domains from text (one per line) into the list.
 * Blank lines and lines starting with # are ignored.
 */
export function importDomains(domains, text) {
  let next = domains;
  let added = 0;
  let existing = 0;
  let invalid = 0;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  for (const line of lines) {
    const result = addDomain(next, line);
    if (result.domain === null) invalid++;
    else if (result.added) added++;
    else existing++;
    next = result.domains;
  }
  return { domains: next, added, existing, invalid };
}

/** Export format: one domain per line, alphabetical. */
export function exportDomains(domains) {
  return [...domains].sort((a, b) => a.localeCompare(b)).join('\n') + '\n';
}

export function removeDomain(domains, domain) {
  return domains.filter((d) => d !== domain);
}

/** Global-mode bypass check mirroring GLOBAL_BYPASS_LIST for request hosts. */
export function isGlobalBypass(host) {
  const h = String(host).toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || !h.includes('.')) return true;
  if (isIPv6(h)) return h === '[::1]';
  if (!isIPv4(h)) return false;
  const [a, b] = h.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Whether current rules route this host through the proxy. */
export function isProxiedHost(mode, domains, host) {
  if (mode === 'auto') return matchesList(host, domains);
  if (mode === 'global') return !isGlobalBypass(host);
  return false;
}

/**
 * Validate proxy settings from the manage form or storage.
 * Host: domain name, IPv4 or IPv6 (stored in brackets). Port: integer 1-65535.
 * Returns { proxy } or { error: 'scheme' | 'host' | 'port' }.
 */
export function parseProxy(input) {
  if (!PROXY_SCHEMES.includes(input?.scheme)) return { error: 'scheme' };
  let host = String(input.host ?? '').trim().toLowerCase();
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  if (isIPv6(host)) {
    try {
      host = new URL(`http://${host}/`).hostname;
    } catch {
      return { error: 'host' };
    }
  } else if (!isIPv4(host) && !host.split('.').every((label) => LABEL_RE.test(label))) {
    return { error: 'host' };
  }
  const port = String(input.port ?? '').trim();
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return { error: 'port' };
  return { proxy: { scheme: input.scheme, host, port: Number(port) } };
}

/** Proxy as shown to the user, e.g. "SOCKS5 127.0.0.1:12345". */
export function formatProxy(proxy) {
  return `${proxy.scheme.toUpperCase()} ${proxy.host}:${proxy.port}`;
}

/** PAC result for the proxy: "SOCKS5 host:port" or "PROXY host:port" (no DIRECT fallback). */
export function pacToken(proxy) {
  return `${proxy.scheme === 'http' ? 'PROXY' : 'SOCKS5'} ${proxy.host}:${proxy.port}`;
}

/** PAC script for auto mode. Listed domains and subdomains -> the proxy, everything else -> DIRECT. */
export function buildPacScript(domains, proxy) {
  const list = JSON.stringify([...domains]);
  return [
    `var DOMAINS = ${list};`,
    'function FindProxyForURL(url, host) {',
    '  host = host.toLowerCase();',
    '  for (var i = 0; i < DOMAINS.length; i++) {',
    '    var d = DOMAINS[i];',
    '    if (host === d || host.length > d.length && host.substring(host.length - d.length - 1) === "." + d) {',
    `      return ${JSON.stringify(pacToken(proxy))};`,
    '    }',
    '  }',
    '  return "DIRECT";',
    '}',
  ].join('\n');
}

/** chrome.proxy.settings value for the given state (mode, list and proxy). */
export function buildProxyConfig({ mode, domains, proxy }) {
  switch (mode) {
    case 'auto':
      return { mode: 'pac_script', pacScript: { data: buildPacScript(domains, proxy), mandatory: true } };
    case 'global':
      return {
        mode: 'fixed_servers',
        rules: { singleProxy: { ...proxy }, bypassList: [...GLOBAL_BYPASS_LIST] },
      };
    case 'direct':
      return { mode: 'direct' };
    default:
      throw new Error(`unknown mode: ${mode}`);
  }
}

/** Validate persisted state; unknown or corrupt values fall back to defaults. */
export function sanitizeState(raw) {
  const state = { ...DEFAULT_STATE };
  if (raw && MODES.includes(raw.mode)) state.mode = raw.mode;
  if (raw && Array.isArray(raw.domains)) {
    state.domains = [...new Set(raw.domains.map(normalizeDomain).filter((d) => d !== null))];
  }
  if (raw && raw.proxy) state.proxy = parseProxy(raw.proxy).proxy ?? DEFAULT_PROXY;
  if (raw && Number.isFinite(raw.lastProxyError)) state.lastProxyError = raw.lastProxyError;
  if (raw && typeof raw.blockWebRtc === 'boolean') state.blockWebRtc = raw.blockWebRtc;
  return state;
}

// Network errors that mean the site could not be reached (blocked, reset, timed out, poisoned DNS/TLS),
// as opposed to cancellations such as net::ERR_ABORTED or net::ERR_BLOCKED_BY_CLIENT.
const CONNECTION_FAILURE_RE =
  /^net::ERR_(CONNECTION_\w+|NAME_\w+|SSL_\w+|CERT_\w+|TIMED_OUT|EMPTY_RESPONSE|ADDRESS_UNREACHABLE|QUIC_PROTOCOL_ERROR|HTTP2_PROTOCOL_ERROR|PROXY_\w+|SOCKS_\w+|TUNNEL_CONNECTION_FAILED)$/;

export function isConnectionFailure(error) {
  return CONNECTION_FAILURE_RE.test(error);
}

/**
 * Group a tab's recorded hosts ({host: {proxied, failed}}) by main domain.
 * A group is proxied/direct when any of its hosts went through the proxy/directly,
 * and failed when any of its hosts failed. Failed groups come first, then alphabetical.
 */
export function summarizePageHosts(hosts) {
  const groups = new Map();
  for (const [host, { proxied, failed }] of Object.entries(hosts)) {
    const domain = mainDomain(host);
    if (domain === null) continue;
    const g = groups.get(domain) ?? { domain, proxied: false, direct: false, failed: false };
    g.proxied ||= proxied;
    g.direct ||= !proxied;
    g.failed ||= failed;
    groups.set(domain, g);
  }
  return [...groups.values()].sort((a, b) => Number(b.failed) - Number(a.failed) || a.domain.localeCompare(b.domain));
}

/**
 * Main domains on a page that the current auto-mode list would not proxy, ignoring local and LAN hosts.
 * failed: whether any of those domains had a network failure.
 */
export function uncoveredDomains(hosts, domains) {
  const uncovered = new Set();
  let failed = false;
  for (const [host, entry] of Object.entries(hosts)) {
    if (matchesList(host, domains) || isGlobalBypass(host)) continue;
    const domain = mainDomain(host);
    if (domain === null) continue;
    uncovered.add(domain);
    failed ||= entry.failed;
  }
  return { count: uncovered.size, failed };
}

const BADGE_COLORS = Object.freeze({ auto: '#1a73e8', global: '#e8710a', direct: '#5f6368', error: '#d93025', uncovered: '#5f6368' });

/**
 * Toolbar badge for the given state; hosts are the tab's page hosts (null for the browser-wide badge).
 * Priority: proxy failure, then uncovered count in auto mode, then the mode mark.
 * msg(key, substitutions) resolves the tooltip text (chrome.i18n.getMessage in the extension).
 */
export function badgeFor(state, hosts, msg) {
  if (state.lastProxyError !== null) return { text: '!', color: BADGE_COLORS.error, title: msg('badgeProxyFailed') };
  if (state.mode === 'global') return { text: 'G', color: BADGE_COLORS.global, title: msg('badgeGlobal') };
  if (state.mode === 'direct') return { text: '', color: BADGE_COLORS.direct, title: msg('badgeDirect') };
  const { count, failed } = hosts === null ? { count: 0, failed: false } : uncoveredDomains(hosts, state.domains);
  if (count === 0) return { text: 'A', color: BADGE_COLORS.auto, title: msg('badgeAuto') };
  return {
    text: String(count),
    color: failed ? BADGE_COLORS.error : BADGE_COLORS.uncovered,
    title: msg(failed ? 'badgeUncoveredFailed' : 'badgeUncovered', [String(count)]),
  };
}

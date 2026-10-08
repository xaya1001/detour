import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import {
  DEFAULT_PROXY,
  addDomain,
  badgeFor,
  coveringEntries,
  buildPacScript,
  buildProxyConfig,
  exportDomains,
  importDomains,
  isConnectionFailure,
  isProxiedHost,
  mainDomain,
  matchesList,
  normalizeDomain,
  parseProxy,
  sanitizeState,
  summarizePageHosts,
} from '../extension/lib/rules.js';

test('normalizeDomain and mainDomain: registrable domain per public suffix list, IP as-is, invalid rejected', () => {
  assert.equal(normalizeDomain(' Mail.Google.COM. '), 'mail.google.com');
  assert.equal(normalizeDomain('https://Example.com:8443/path?q=1'), 'example.com');
  assert.equal(normalizeDomain('*.example.com'), 'example.com');
  assert.equal(normalizeDomain('not a domain'), null);
  assert.equal(normalizeDomain(''), null);

  assert.equal(mainDomain('mail.google.com'), 'google.com');
  assert.equal(mainDomain('www.google.com.hk'), 'google.com.hk');
  assert.equal(mainDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(mainDomain('svc-123.us-central1.run.app'), 'svc-123.us-central1.run.app');
  assert.equal(mainDomain('user.github.io'), 'user.github.io');
  assert.equal(mainDomain('www.ck'), 'www.ck');
  assert.equal(mainDomain('a.b.c.ck'), 'b.c.ck');
  assert.equal(mainDomain('com.hk'), 'com.hk');
  assert.equal(mainDomain('localhost'), 'localhost');
  assert.equal(mainDomain('a.b.corp.internal'), 'corp.internal');
  assert.equal(mainDomain('https://a.b.c.example.org/'), 'example.org');
  assert.equal(mainDomain('192.168.1.10'), '192.168.1.10');
  assert.equal(mainDomain('[::1]'), '[::1]');
  assert.equal(mainDomain('chrome://extensions'), null);
});

test('matchesList: exact and subdomain match, no partial-label match', () => {
  const domains = ['google.com'];
  assert.equal(matchesList('google.com', domains), true);
  assert.equal(matchesList('www.google.com', domains), true);
  assert.equal(matchesList('WWW.GOOGLE.COM', domains), true);
  assert.equal(matchesList('notgoogle.com', domains), false);
  assert.equal(matchesList('google.com.evil.net', domains), false);
});

test('coveringEntries: list entries that make a domain proxied, including a parent public suffix entry', () => {
  const domains = ['githubusercontent.com', 'mail.google.com', 'example.org'];
  assert.equal(mainDomain('avatars.githubusercontent.com'), 'avatars.githubusercontent.com');
  assert.deepEqual(coveringEntries(domains, 'avatars.githubusercontent.com'), ['githubusercontent.com']);
  assert.deepEqual(coveringEntries(domains, 'example.org'), ['example.org']);
  assert.deepEqual(coveringEntries(domains, 'google.com'), []);
});

test('addDomain: normalizes, deduplicates, rejects invalid input', () => {
  assert.deepEqual(addDomain([], 'Mail.Google.com'), { domains: ['mail.google.com'], domain: 'mail.google.com', added: true });
  const same = ['google.com'];
  assert.deepEqual(addDomain(same, 'google.com'), { domains: same, domain: 'google.com', added: false });
  assert.deepEqual(addDomain(same, '???'), { domains: same, domain: null, added: false });
});

test('PAC script routes listed domains to the proxy and everything else DIRECT', () => {
  const pac = buildPacScript(['google.com', '10.0.0.5'], DEFAULT_PROXY);
  const context = vm.createContext({});
  vm.runInContext(pac, context);
  const find = (host) => vm.runInContext(`FindProxyForURL(${JSON.stringify('https://' + host + '/')}, ${JSON.stringify(host)})`, context);

  assert.equal(find('google.com'), 'SOCKS5 127.0.0.1:12345');
  assert.equal(find('www.google.com'), 'SOCKS5 127.0.0.1:12345');
  assert.equal(find('WWW.GOOGLE.COM'), 'SOCKS5 127.0.0.1:12345');
  assert.equal(find('10.0.0.5'), 'SOCKS5 127.0.0.1:12345');
  assert.equal(find('notgoogle.com'), 'DIRECT');
  assert.equal(find('example.org'), 'DIRECT');
  assert.equal(pac.includes('SOCKS5 127.0.0.1:12345; DIRECT'), false);

  const http = vm.createContext({});
  vm.runInContext(buildPacScript(['google.com'], { scheme: 'http', host: '192.168.1.2', port: 7890 }), http);
  assert.equal(vm.runInContext('FindProxyForURL("https://www.google.com/", "www.google.com")', http), 'PROXY 192.168.1.2:7890');
});

test('parseProxy: SOCKS5 or HTTP, domain or IP host, port 1-65535; invalid stored proxy falls back to the default', () => {
  assert.deepEqual(parseProxy({ scheme: 'http', host: ' LocalHost ', port: '8080' }), {
    proxy: { scheme: 'http', host: 'localhost', port: 8080 },
  });
  assert.deepEqual(parseProxy({ scheme: 'socks5', host: '::1', port: 1080 }).proxy, { scheme: 'socks5', host: '[::1]', port: 1080 });
  assert.equal(parseProxy({ scheme: 'socks5', host: '10.0.0.2', port: '65535' }).proxy.port, 65535);
  assert.deepEqual(parseProxy({ scheme: 'socks5', host: '', port: '1080' }), { error: 'host' });
  assert.deepEqual(parseProxy({ scheme: 'socks5', host: '127.0.0.1:1080', port: '1080' }), { error: 'host' });
  assert.deepEqual(parseProxy({ scheme: 'socks5', host: '127.0.0.1', port: '0' }), { error: 'port' });
  assert.deepEqual(parseProxy({ scheme: 'socks5', host: '127.0.0.1', port: '65536' }), { error: 'port' });
  assert.deepEqual(parseProxy({ scheme: 'socks5', host: '127.0.0.1', port: '8.5' }), { error: 'port' });
  assert.deepEqual(parseProxy({ scheme: 'https', host: '127.0.0.1', port: '443' }), { error: 'scheme' });

  assert.deepEqual(sanitizeState({}).proxy, DEFAULT_PROXY);
  assert.deepEqual(sanitizeState({ proxy: { scheme: 'socks5', host: 'bad host', port: 1 } }).proxy, DEFAULT_PROXY);
  assert.deepEqual(sanitizeState({ proxy: { scheme: 'http', host: 'proxy.lan', port: 3128 } }).proxy, {
    scheme: 'http',
    host: 'proxy.lan',
    port: 3128,
  });
});

test('PAC script never triggers DNS: evaluates with no PAC helper functions defined', () => {
  const pac = buildPacScript(['google.com'], DEFAULT_PROXY);
  for (const fn of ['dnsResolve', 'isResolvable', 'isInNet', 'myIpAddress', 'dnsDomainIs', 'shExpMatch']) {
    assert.equal(pac.includes(fn), false, `PAC must not reference ${fn}`);
  }
  // Context deliberately has none of the PAC helpers; any call to them would throw.
  const context = vm.createContext(Object.create(null));
  vm.runInContext(pac, context);
  assert.equal(vm.runInContext('FindProxyForURL("https://mail.google.com/", "mail.google.com")', context), 'SOCKS5 127.0.0.1:12345');
  assert.equal(vm.runInContext('FindProxyForURL("http://1.2.3.4/", "1.2.3.4")', context), 'DIRECT');
});

test('proxy config per mode and isProxiedHost agree on global bypass', () => {
  const state = { mode: 'auto', domains: ['google.com'], proxy: { scheme: 'http', host: '127.0.0.1', port: 8080 } };
  const auto = buildProxyConfig(state);
  assert.equal(auto.mode, 'pac_script');
  assert.equal(auto.pacScript.mandatory, true);

  assert.ok(auto.pacScript.data.includes('"PROXY 127.0.0.1:8080"'));

  const global = buildProxyConfig({ ...state, mode: 'global' });
  assert.deepEqual(global.rules.singleProxy, { scheme: 'http', host: '127.0.0.1', port: 8080 });
  assert.ok(global.rules.bypassList.includes('192.168.0.0/16'));
  assert.ok(global.rules.bypassList.includes('<local>'));

  assert.deepEqual(buildProxyConfig({ ...state, mode: 'direct' }), { mode: 'direct' });

  assert.equal(isProxiedHost('global', [], 'example.com'), true);
  assert.equal(isProxiedHost('global', [], 'localhost'), false);
  assert.equal(isProxiedHost('global', [], '127.0.0.1'), false);
  assert.equal(isProxiedHost('global', [], '172.20.1.1'), false);
  assert.equal(isProxiedHost('global', [], '172.32.1.1'), true);
  assert.equal(isProxiedHost('global', [], 'printer.local'), false);
  assert.equal(isProxiedHost('auto', ['google.com'], 'docs.google.com'), true);
  assert.equal(isProxiedHost('auto', ['google.com'], 'example.com'), false);
  assert.equal(isProxiedHost('direct', ['google.com'], 'google.com'), false);
});

test('page hosts: connection failures recognized, grouped by main domain with failed domains first', () => {
  assert.equal(isConnectionFailure('net::ERR_CONNECTION_RESET'), true);
  assert.equal(isConnectionFailure('net::ERR_CONNECTION_TIMED_OUT'), true);
  assert.equal(isConnectionFailure('net::ERR_SOCKS_CONNECTION_FAILED'), true);
  assert.equal(isConnectionFailure('net::ERR_ABORTED'), false);
  assert.equal(isConnectionFailure('net::ERR_BLOCKED_BY_CLIENT'), false);

  assert.deepEqual(
    summarizePageHosts({
      'www.youtube.com': { proxied: true, failed: false },
      'i.ytimg.com': { proxied: false, failed: true },
      'rr1.googlevideo.com': { proxied: true, failed: true },
      'www.gstatic.com': { proxied: false, failed: false },
      'fonts.gstatic.com': { proxied: false, failed: false },
    }),
    [
      { domain: 'googlevideo.com', proxied: true, direct: false, failed: true },
      { domain: 'ytimg.com', proxied: false, direct: true, failed: true },
      { domain: 'gstatic.com', proxied: false, direct: true, failed: false },
      { domain: 'youtube.com', proxied: true, direct: false, failed: false },
    ],
  );
});

test('import merges into the list and round-trips the export format', () => {
  const result = importDomains(['google.com'], '# list\r\nGoogle.com\nhttps://www.youtube.com/watch\n\nbad domain!\n  ytimg.com  \n???\n');
  assert.deepEqual(result, { domains: ['google.com', 'www.youtube.com', 'ytimg.com'], added: 2, existing: 1, invalid: 2 });

  const text = exportDomains(['ytimg.com', 'google.com']);
  assert.equal(text, 'google.com\nytimg.com\n');
  assert.deepEqual(importDomains([], text).domains, ['google.com', 'ytimg.com']);
});

test('badge: proxy failure first, then uncovered page domains in auto mode, then the mode mark', () => {
  const hosts = {
    'www.youtube.com': { proxied: true, failed: false },
    'i.ytimg.com': { proxied: false, failed: false },
    's.ytimg.com': { proxied: false, failed: false },
    'cdn.blocked.example': { proxied: false, failed: true },
    'localhost': { proxied: false, failed: true },
    '192.168.1.1': { proxied: false, failed: false },
  };
  const auto = { mode: 'auto', domains: ['youtube.com'], lastProxyError: null };
  const msg = (key, subs = []) => [key, ...subs].join(':');
  const badge = (state, h) => badgeFor(state, h, msg);
  assert.deepEqual(badge(auto, hosts), { text: '2', color: '#d93025', title: 'badgeUncoveredFailed:2' });
  assert.equal(badge({ ...auto, domains: ['youtube.com', 'blocked.example'] }, hosts).text, '1');
  assert.equal(badge({ ...auto, domains: ['youtube.com', 'blocked.example'] }, hosts).color, '#5f6368');
  assert.equal(badge({ ...auto, domains: ['youtube.com', 'blocked.example', 'ytimg.com'] }, hosts).text, 'A');
  assert.equal(badge(auto, null).text, 'A');
  assert.equal(badge({ ...auto, mode: 'global' }, hosts).text, 'G');
  assert.equal(badge({ ...auto, mode: 'direct' }, hosts).text, '');
  assert.equal(badge({ ...auto, lastProxyError: 1 }, hosts).text, '!');
});

test('locales: English and Simplified Chinese define the same messages', () => {
  const read = (locale) => JSON.parse(fs.readFileSync(new URL(`../extension/_locales/${locale}/messages.json`, import.meta.url)));
  const en = read('en');
  const zh = read('zh_CN');
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const [key, { message }] of Object.entries(en)) {
    const placeholders = (text) => (text.match(/\$\d/g) ?? []).sort();
    assert.deepEqual(placeholders(zh[key].message), placeholders(message), key);
  }
});

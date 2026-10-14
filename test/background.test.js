import test from 'node:test';
import assert from 'node:assert/strict';

function event() {
  const listeners = [];
  return {
    addListener(fn, filter) { listeners.push({ fn, filter }); },
    fire(...args) {
      for (const { fn, filter } of listeners) {
        if (!filter?.types || filter.types.includes(args[0].type)) fn(...args);
      }
    },
  };
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };

async function setup() {
  const changed = event();
  function storage(initial = {}) {
    const data = structuredClone(initial);
    return {
      data,
      async get(keys) {
        return structuredClone(keys === null ? data : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in data).map((k) => [k, data[k]])));
      },
      async set(values) { Object.assign(data, structuredClone(values)); },
      async remove(key) { delete data[key]; },
    };
  }
  const chrome = {
    storage: { local: storage({ mode: 'auto', domains: ['proxied.test'] }), session: storage(), onChanged: changed },
    runtime: { onInstalled: event(), onStartup: event() },
    proxy: { settings: { set: async () => {} }, onProxyError: event() },
    privacy: { network: { webRTCIPHandlingPolicy: { set: async () => {}, clear: async () => {} } } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    tabs: { query: async () => [{ id: 1 }], onUpdated: event(), onRemoved: event() },
    webRequest: Object.fromEntries(['onBeforeRequest', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred'].map((name) => [name, event()])),
    i18n: { getMessage: (key) => key },
  };
  globalThis.chrome = chrome;
  await import(`../extension/background.js?test=${Math.random()}`);
  const request = (id, host, type = 'main_frame') => ({ requestId: id, tabId: 1, type, url: `http://${host}/`, fromCache: false });
  return { chrome, request, hosts: () => chrome.storage.session.data['page:1'] ?? {} };
}

test('pending requests appear immediately and late requests cannot pollute a new page', async () => {
  const { chrome: c, request, hosts } = await setup();
  const old = request('old', 'old.direct.test');
  c.webRequest.onBeforeRequest.fire(old);
  await flush();
  assert.ok(hosts()['old.direct.test'], 'pending navigation must be visible');
  const asset = request('asset', 'slow.direct.test', 'image');
  c.webRequest.onBeforeRequest.fire(asset);
  const next = request('new', 'new.direct.test');
  c.webRequest.onBeforeRequest.fire(next);
  c.webRequest.onCompleted.fire(next);
  c.webRequest.onErrorOccurred.fire({ ...asset, error: 'net::ERR_CONNECTION_RESET' });
  await flush();
  assert.deepEqual(Object.keys(hosts()), ['new.direct.test']);
});

test('tab close removes page data after outstanding writes finish', async () => {
  const { chrome: c, request } = await setup();
  const r = request('request', 'proxied.test');
  const set = c.storage.session.set;
  let release;
  c.storage.session.set = async (values) => {
    await new Promise((resolve) => { release = resolve; });
    await set(values);
  };
  c.webRequest.onBeforeRequest.fire(r);
  await flush();
  c.webRequest.onCompleted.fire(r);
  c.tabs.onRemoved.fire(1);
  release();
  await flush();
  assert.equal(c.storage.session.data['page:1'], undefined);
});

test('a later proxy error cannot be erased by an earlier success waiting on storage', async () => {
  const { chrome: c, request } = await setup();
  c.storage.local.data.lastProxyError = 1;
  const get = c.storage.local.get;
  let release;
  c.storage.local.get = async (keys) => {
    const value = await get(keys);
    await new Promise((resolve) => { release = resolve; });
    return value;
  };
  c.webRequest.onCompleted.fire(request('success', 'proxied.test'));
  await new Promise(setImmediate);
  c.storage.local.get = get;
  c.proxy.onProxyError.fire({});
  release();
  await flush();
  assert.ok(c.storage.local.data.lastProxyError > 1);
});

test('proxy control failure does not prevent WebRTC policy or mode badge updates', async () => {
  const { chrome: c } = await setup();
  c.storage.local.data.blockWebRtc = true;
  let policyApplied = false;
  let badge;
  c.proxy.settings.set = async () => { throw new Error('controlled by another extension'); };
  c.privacy.network.webRTCIPHandlingPolicy.set = async () => { policyApplied = true; };
  c.action.setBadgeText = async ({ text }) => { badge = text; };
  const originalError = console.error;
  console.error = () => {};
  try {
    c.runtime.onStartup.fire();
    await flush();
    assert.equal(policyApplied, true);
    assert.equal(badge, 'A');
  } finally {
    console.error = originalError;
  }
});


test('redirect hops remain together and resumed workers can record existing-page requests', async () => {
  const { chrome: c, request, hosts } = await setup();
  c.storage.session.data['page:1'] = { 'existing.direct.test': { proxied: false, failed: false } };
  c.webRequest.onCompleted.fire(request('resumed', 'asset.direct.test', 'image'));
  await flush();
  assert.deepEqual(Object.keys(hosts()).sort(), ['asset.direct.test', 'existing.direct.test']);
  const first = request('redirect', 'first.direct.test');
  c.webRequest.onBeforeRequest.fire(first);
  c.webRequest.onBeforeRedirect.fire(first);
  const landing = { ...first, url: 'http://landing.direct.test/' };
  c.webRequest.onBeforeRequest.fire(landing);
  c.webRequest.onCompleted.fire(landing);
  await flush();
  assert.deepEqual(Object.keys(hosts()).sort(), ['first.direct.test', 'landing.direct.test']);
});

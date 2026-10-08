// Loads the unpacked extension into Playwright's Chromium (English UI) and checks its runtime behaviour offline:
// a local HTTP server plays every site, a SOCKS5 stub on the default proxy 127.0.0.1:12345 and an HTTP proxy
// stub record which hostnames went through a proxy, and host-resolver rules point direct hostnames at the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const EXTENSION = path.resolve(import.meta.dirname, '../extension');
const SOCKS_PORT = 12345;

function startSite() {
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: `http://landing.direct.test:${port}/` });
      return res.end();
    }
    if (req.url === '/assets') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<img src="http://cdn.direct.test:${port}/a.png"><img src="http://cdn.fail.test/a.png">`);
    }
    // nosniff HTML: Chrome's opaque response blocking rejects it when loaded as an image,
    // so the cdn.direct.test image request ends in net::ERR_BLOCKED_BY_ORB, not a network failure.
    res.writeHead(200, { 'content-type': 'text/html', 'x-content-type-options': 'nosniff' });
    res.end('<title>ok</title>');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Minimal SOCKS5 (no auth, CONNECT by domain name) that sends every connection to the local site.
function startSocks(sitePort, seen) {
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('error', () => {});
    client.once('data', () => {
      client.write(Buffer.from([5, 0]));
      client.once('data', (req) => {
        const len = req[4];
        seen.push(req.subarray(5, 5 + len).toString());
        const upstream = net.connect(sitePort, '127.0.0.1', () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          upstream.pipe(client);
          client.pipe(upstream);
        });
        sockets.add(upstream);
        upstream.on('error', () => client.destroy());
      });
    });
  });
  server.kill = () => {
    server.close();
    for (const s of sockets) s.destroy();
  };
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(SOCKS_PORT, '127.0.0.1', () => resolve(server));
  });
}

// Minimal forwarding HTTP proxy (absolute-URI requests for http:// sites) to the local site.
function startHttpProxy(sitePort, seen) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url);
    seen.push(url.hostname);
    const upstream = http.request(
      { host: '127.0.0.1', port: sitePort, path: url.pathname + url.search, method: req.method, headers: req.headers },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, message) {
  for (let i = 0; i < 50; i++) {
    const value = await check();
    if (value) return value;
    await pause(100);
  }
  assert.fail(message);
}

test('extension runtime in Chromium', async (t) => {
  const site = await startSite();
  const port = site.address().port;
  const seen = [];
  let socks = await startSocks(port, seen);
  const httpSeen = [];
  const httpProxy = await startHttpProxy(port, httpSeen);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-e2e-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      '--host-resolver-rules=MAP *.direct.test 127.0.0.1, MAP direct.test 127.0.0.1',
      '--lang=en-US',
    ],
  });
  t.after(async () => {
    await context.close();
    socks.kill();
    httpProxy.closeAllConnections();
    httpProxy.close();
    site.close();
    fs.rmSync(profile, { recursive: true, force: true });
  });

  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const ev = (fn, arg) => worker.evaluate(fn, arg);
  const setState = async (state) => {
    await ev((s) => chrome.storage.local.set(s), state);
    await pause(300);
  };
  const badge = () => ev(() => chrome.action.getBadgeText({}));
  const page = await context.newPage();
  const visit = (host, pathname = '/') => page.goto(`http://${host}:${port}${pathname}`).catch(() => null);
  const pageTabId = async () => (await ev(() => chrome.tabs.query({}))).find((x) => x.url?.startsWith('http://') && x.active).id;
  const pageHosts = async () => {
    const key = `page:${await pageTabId()}`;
    return (await ev((k) => chrome.storage.session.get(k), key))[key] ?? {};
  };
  const tabBadge = async () => {
    const tabId = await pageTabId();
    const [text, color] = await ev(
      (id) => Promise.all([chrome.action.getBadgeText({ tabId: id }), chrome.action.getBadgeBackgroundColor({ tabId: id })]),
      tabId,
    );
    return `${text} ${color.join(',')}`;
  };

  await t.test('auto mode proxies listed domains and subdomains only', async () => {
    await setState({ mode: 'auto', domains: ['proxied.test'] });
    seen.length = 0;
    assert.equal((await visit('www.proxied.test'))?.status(), 200);
    await visit('cdn.direct.test');
    assert.deepEqual([...new Set(seen)], ['www.proxied.test']);
    assert.equal(await badge(), 'A');
  });

  await t.test('page domains record proxied, direct, blocked and failed hosts', async () => {
    await visit('www.proxied.test', '/assets');
    const hosts = await waitFor(async () => {
      const h = await pageHosts();
      return h['cdn.fail.test'] && h['cdn.direct.test'] ? h : null;
    }, 'page hosts not recorded');
    assert.deepEqual(hosts['www.proxied.test'], { proxied: true, failed: false });
    assert.deepEqual(hosts['cdn.direct.test'], { proxied: false, failed: false });
    assert.deepEqual(hosts['cdn.fail.test'], { proxied: false, failed: true });
  });

  await t.test('auto mode badge counts page domains the list does not cover, red when one failed', async () => {
    await waitFor(async () => (await tabBadge()) === '2 217,48,37,255', 'uncovered count badge not shown');
    await setState({ domains: ['proxied.test', 'fail.test'] });
    await waitFor(async () => (await tabBadge()) === '1 95,99,104,255', 'count did not drop after adding a domain');
    await setState({ mode: 'global' });
    await waitFor(async () => (await tabBadge()).startsWith('G '), 'global mode should show G');
    await setState({ mode: 'auto', domains: ['proxied.test'] });
    await waitFor(async () => (await tabBadge()).startsWith('2 '), 'count not restored');
  });

  await t.test('redirect hops stay in page domains until the next navigation', async () => {
    await visit('start.direct.test', '/redirect');
    const hosts = await waitFor(async () => {
      const h = await pageHosts();
      return h['landing.direct.test'] ? h : null;
    }, 'redirect landing not recorded');
    assert.ok('start.direct.test' in hosts);
    await visit('other.direct.test');
    await waitFor(async () => !('start.direct.test' in (await pageHosts())), 'page hosts not reset on navigation');
    await waitFor(async () => (await tabBadge()) === '1 95,99,104,255', 'badge not recounted for the new page');
  });

  await t.test('a non-web page clears the previous page count', async () => {
    const tabId = await pageTabId();
    await page.goto('about:blank');
    await waitFor(async () => (await ev((id) => chrome.action.getBadgeText({ tabId: id }), tabId)) === 'A', 'stale count kept');
    const key = `page:${tabId}`;
    assert.deepEqual((await ev((k) => chrome.storage.session.get(k), key))[key] ?? {}, {});
  });

  await t.test('global mode proxies everything except local addresses', async () => {
    await setState({ mode: 'global' });
    seen.length = 0;
    await visit('cdn.direct.test');
    await visit('127.0.0.1');
    assert.deepEqual([...new Set(seen)], ['cdn.direct.test']);
    assert.equal(await badge(), 'G');
  });

  await t.test('direct mode proxies nothing', async () => {
    await setState({ mode: 'direct' });
    seen.length = 0;
    await visit('www.proxied.test');
    assert.deepEqual(seen, []);
    assert.equal(await badge(), '');
  });

  await t.test('proxy failure shows the error badge and a proxied success clears it', async () => {
    await setState({ mode: 'auto' });
    socks.kill();
    assert.equal(await visit('www.proxied.test', '/?down'), null);
    await waitFor(async () => (await badge()) === '!', 'error badge not shown');
    socks = await startSocks(port, seen);
    await visit('www.proxied.test', '/?up');
    await waitFor(async () => (await badge()) === 'A', 'error badge not cleared');
  });

  // Every data-i18n element resolved to a message (an unknown key renders as an empty string).
  const untranslated = (p) => p.evaluate(() => [...document.querySelectorAll('[data-i18n]')].filter((n) => n.textContent === '').map((n) => n.dataset.i18n));

  await t.test('manage page: single tab, add, undo delete, import and export', async () => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    assert.deepEqual(await untranslated(popup), []);
    assert.equal(await popup.textContent('#open-manage'), 'Manage proxy list');
    await popup.evaluate(() => {
      window.close = () => {};
      document.getElementById('open-manage').click();
    });
    const manage = await context.waitForEvent('page', (p) => p.url().endsWith('manage.html'));
    await popup.evaluate(() => document.getElementById('open-manage').click());
    await pause(500);
    assert.equal(context.pages().filter((p) => p.url().endsWith('manage.html')).length, 1);
    await manage.waitForSelector('#domain-list li');
    assert.deepEqual(await untranslated(manage), []);

    const domains = async () => (await ev(() => chrome.storage.local.get('domains'))).domains;
    await manage.fill('#add-input', 'https://Docs.Example.org/x');
    await manage.press('#add-input', 'Enter');
    assert.equal(await manage.textContent('#feedback'), 'Added docs.example.org');
    await manage.fill('#add-input', 'bad domain');
    await manage.press('#add-input', 'Enter');
    assert.equal(await manage.textContent('#feedback'), 'Invalid domain');

    await manage.hover('#domain-list li:has-text("docs.example.org")');
    await manage.click('#domain-list li:has-text("docs.example.org") button.remove');
    await waitFor(async () => !(await domains()).includes('docs.example.org'), 'domain not deleted');
    await manage.click('#toast-undo');
    await waitFor(async () => (await domains()).includes('docs.example.org'), 'undo did not restore');

    const [download] = await Promise.all([manage.waitForEvent('download'), manage.click('#export')]);
    assert.equal(fs.readFileSync(await download.path(), 'utf8'), 'docs.example.org\nproxied.test\n');

    const importFile = path.join(profile, 'import.txt');
    fs.writeFileSync(importFile, '# backup\r\nproxied.test\r\nnew.example.com\r\n???\r\n');
    await manage.setInputFiles('#import-file', importFile);
    await waitFor(async () => (await domains()).includes('new.example.com'), 'import not merged');
    assert.equal(await manage.textContent('#feedback'), 'Import done: 1 added, 1 already listed, 1 invalid');
  });

  await t.test('proxy settings: invalid input is rejected, an HTTP proxy routes auto and global traffic', async () => {
    const manage = context.pages().find((p) => p.url().endsWith('manage.html'));
    const stored = async () => (await ev(() => chrome.storage.local.get('proxy'))).proxy;
    assert.equal(await manage.inputValue('#proxy-port'), '12345');
    await manage.fill('#proxy-port', '0');
    await manage.click('#proxy-form button[type="submit"]');
    assert.match(await manage.textContent('#proxy-feedback'), /^Invalid port/);
    assert.equal(await stored(), undefined);

    const httpPort = httpProxy.address().port;
    await manage.selectOption('#proxy-scheme', 'http');
    await manage.fill('#proxy-port', String(httpPort));
    await manage.click('#proxy-form button[type="submit"]');
    assert.equal(await manage.textContent('#proxy-feedback'), `Saved: HTTP 127.0.0.1:${httpPort}`);
    assert.deepEqual(await stored(), { scheme: 'http', host: '127.0.0.1', port: httpPort });
    await pause(300);

    seen.length = 0;
    assert.equal((await visit('www.proxied.test', '/?http'))?.status(), 200);
    await visit('cdn.direct.test', '/?http');
    assert.deepEqual([...new Set(httpSeen)], ['www.proxied.test']);
    await setState({ mode: 'global' });
    await visit('cdn.direct.test', '/?http-global');
    assert.ok(httpSeen.includes('cdn.direct.test'));
    assert.deepEqual(seen, []);

    await ev(() => chrome.storage.local.remove('proxy'));
    await setState({ mode: 'auto' });
  });

  await t.test('WebRTC toggle restricts WebRTC to proxied connections', async () => {
    const candidates = () =>
      page.evaluate(async () => {
        const pc = new RTCPeerConnection();
        pc.createDataChannel('probe');
        const found = [];
        pc.onicecandidate = (e) => e.candidate && found.push(e.candidate.type);
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise((resolve) => setTimeout(resolve, 1000));
        pc.close();
        return found;
      });
    const policy = () => ev(() => chrome.privacy.network.webRTCIPHandlingPolicy.get({}));
    await visit('cdn.direct.test');
    assert.ok((await candidates()).length > 0);

    await setState({ blockWebRtc: true });
    assert.equal((await policy()).value, 'disable_non_proxied_udp');
    assert.deepEqual(await candidates(), []);

    await setState({ blockWebRtc: false });
    assert.equal((await policy()).value, 'default');
  });
});

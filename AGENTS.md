# Detour Agent Guide

Chrome MV3 extension that routes a domain list through the user's SOCKS5 or HTTP proxy (default SOCKS5 `127.0.0.1:12345`); open source under MIT. Requirements: `docs/requirements.md`. Install and usage: `README.md` (Chinese: `README.zh-CN.md`). In the maintainer's workspace, `/home/ubuntu/AGENTS.md` also applies.

## Commands

The extension has no runtime dependencies and no build step; the only dev dependency is Playwright (end-to-end tests).

| Command | Purpose | Heavy |
| --- | --- | --- |
| `npm ci` | Bootstrap: install Playwright from the lockfile (no browsers) | No |
| `npx playwright install chromium` | Install the Chromium build matching the locked Playwright (needed once for e2e) | No |
| `npm test` | Unit tests in `test/` (seconds) | No |
| `npm run test:e2e` | `e2e/`: loads the extension in Playwright Chromium with an English UI (about 15 s) | Yes |
| `npm run check` | `npm test` + `npm run test:e2e`, the full gate | Yes |
| `npm run package` | Build `dist/detour-<manifest version>.zip` (`extension/` contents and `LICENSE` at the zip root) | No |
| `npm run update-psl` | Regenerate `extension/lib/psl-data.js` from publicsuffix.org (network); run `npm test` afterwards | No |

Node 22+ (Node 24 locally and in CI). E2E uses `channel: 'chromium'` (new headless supports extensions) with the Chromium build that matches the locked Playwright version.

## Code map

```text
extension/
  manifest.json      MV3 manifest; permissions proxy, privacy, storage, webRequest; host_permissions <all_urls>; default_locale en
  _locales/          en and zh_CN messages.json (same keys and placeholders, checked by a unit test)
  lib/psl-data.js    Generated Public Suffix List rules (written only by scripts/update-psl.js)
  lib/rules.js       Pure logic, no Chrome APIs: normalization, registrable domain, list matching, proxy validation, PAC, per-mode proxy config, global bypass, state sanitizing, badge
  lib/i18n.js        chrome.i18n wrapper: t(), formatTime(), localizePage() fills data-i18n* attributes
  background.js      Service worker: storage -> chrome.proxy.settings.set; badges; passive onProxyError / webRequest listeners for the failure mark and page domains
  popup.html/js      Popup: mode switch, current site and add/remove, page domains, open the list page, failure and "controlled by another extension" banners
  manage.html/js     Proxy list page (options_ui, opens in a tab): sorted list, search, add, remove with undo, import/export, proxy server, WebRTC switch
  ui.css             Shared styles
  icons/             16/48/128 PNG
scripts/package.js   Dependency-free zip writer (deflate)
scripts/update-psl.js Downloads and converts the Public Suffix List
test/rules.test.js   Contract tests for lib/rules.js and the locale files
e2e/                 Offline e2e: local HTTP site + SOCKS5 stub on 127.0.0.1:12345 + HTTP proxy stub + host-resolver-rules
.github/workflows/ci.yml  push/PR: npm run check; v* tag: check the tag matches the manifest version, package, publish the GitHub Release
docs/images/         README screenshots
```

Dependencies point one way: `background.js`, `popup.js`, `manage.js` → `lib/i18n.js`, `lib/rules.js` → `lib/psl-data.js`. UI text lives only in `_locales`; pages and scripts hard-code no text in any language, and `badgeFor` receives an injected `msg` function.

Fact owners: mode, domain list, proxy and latest failure time live in `chrome.storage.local` (keys in `STATE_KEYS` of `rules.js`: `mode`, `domains`, `proxy`, `lastProxyError`, `blockWebRtc`; `proxy` is `{scheme: 'socks5'|'http', host, port}` and falls back to `DEFAULT_PROXY` when missing or invalid). The popup and list page only write storage; the service worker listens to `storage.onChanged`, reapplies the proxy and refreshes badges, so changes apply immediately without the pages staying open. Page domains are written by the service worker to `chrome.storage.session` (key `page:<tabId>`, value `{host: {proxied, failed}}`, every host), cleared on a new main-frame request (not on redirects of the same request; hops are recorded via `onBeforeRedirect`) and removed when the tab closes.

"Covered by the list" means `coveringEntries(domains, host)` is non-empty: the host equals an entry or is a subdomain of one. The popup uses it for the current-site button (remove deletes every covering entry) and to hide "Add" on page domains; a registrable domain can sit under a listed public suffix (`avatars.githubusercontent.com` under `githubusercontent.com`), so exact-entry checks are wrong.

Badges come from `badgeFor` in `rules.js`: the browser-wide badge shows the mode; tabs with page data get their own badge (the uncovered count in Auto mode). Chrome clears a tab's badge when it loads a new document, so `tabs.onUpdated` status changes reapply it; loading a non-http(s) page clears that tab's page data.

Proxy, WebRTC policy (`disable_non_proxied_udp` when `blockWebRtc` is true, otherwise `clear` to restore the default) and badge updates run through one serial queue in the service worker, each reading fresh storage with no cached state, so an older state never overwrites a newer one under concurrent events.

## Test gates

- `npm test` covers: normalize/registrable-domain contract, subdomain matching (`notgoogle.com` does not match), covering entries under a listed public suffix, de-duplicated add, proxy validation (type, host, port) and fallback for invalid stored values, PAC in `node:vm` returning `SOCKS5 host:port` / `PROXY host:port` / `DIRECT`, PAC referencing no DNS helpers, per-mode proxy config and global bypass, connection-failure detection and page-domain grouping, import merge and export format, badge priority and uncovered count, en/zh_CN locale parity.
- `npm run test:e2e` covers: routing in all three modes, page domains (proxied, direct, blocked, failed, redirect hops), uncovered-count badge (colors, drop after adding, mode switch, new page, non-web page reset), proxy failure badge and recovery, list page (single tab, add, undo remove, import/export), no missing UI text in popup and list page, proxy form (invalid port rejected, HTTP proxy used in Auto and Global), WebRTC switch.
- After changing `rules.js` run `npm test`; after changing `background.js`, pages or the manifest run `npm run test:e2e`; before delivery run `npm run check` once and `npm run package`, and check the zip file list.
- Add tests only for requirements or invariants, preferably by extending `test/rules.test.js`.

## Project risks

- **E2E uses a fixed port**: the default proxy is `127.0.0.1:12345`, so `test:e2e` starts its SOCKS5 stub there; if the port is taken the tests fail, and two runs cannot overlap.
- **No direct fallback**: PAC returns only `SOCKS5 host:port` or `PROXY host:port`, never with `; DIRECT`; Global mode uses `fixed_servers` + `singleProxy`. This is a requirement (visible failures), not a bug.
- **No DNS in PAC**: PAC does string operations on `host` only; no `dnsResolve`, `isResolvable`, `isInNet`, `myIpAddress` and the like. Proxied hostnames are resolved by the proxy.
- **Navigation never waits on the service worker**: Chrome persists the proxy settings. Do not add blocking `webRequest` listeners or `chrome.proxy.onRequest`; the service worker only listens passively and reapplies settings on install, startup and state changes.
- **Proxy control**: Chrome lets one extension control the proxy. With `levelOfControl` `controlled_by_other_extensions` our settings have no effect and the popup says so.
- **Public Suffix List**: registrable domains come from `extension/lib/psl-data.js` (generated by `npm run update-psl`, ICANN and PRIVATE sections, punycoded). Never fall back to "last two labels": `google.com.hk` would become `com.hk`, and adding it would proxy the whole suffix. Only the script writes the generated file.
- **Failure mark**: set by `chrome.proxy.onProxyError` and by `net::ERR_PROXY_*` / `ERR_SOCKS_*` / `ERR_TUNNEL_CONNECTION_FAILED` in `webRequest.onErrorOccurred`; cleared by a non-cached `onCompleted` of a request the current rules proxy. An unreachable HTTP proxy also reports `ERR_PROXY_CONNECTION_FAILED`.
- **Releases**: the version lives in `extension/manifest.json` and `package.json` and must match; a release is a version-bump commit followed by pushing the `v<version>` tag, and CI publishes the Release (no manual zip uploads). The repository is public; commits use the GitHub noreply address (repository-local git config).

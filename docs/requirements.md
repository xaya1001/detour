# Detour Requirements

## Users and problem

Users run a proxy program on their machine or LAN (GOST, Clash, v2rayN, …) that offers a SOCKS5 or HTTP proxy port. They want Chrome to send only chosen domains through that proxy and connect to everything else directly, and to switch modes and edit the domain list from the browser at any time. Existing proxy-switching extensions do far more than that; these users need only this one thing. Detour is open source; users download the zip from GitHub Releases and install it themselves.

## Core scenarios

1. Auto mode: with "Auto" selected, listed domains and all their subdomains go through the proxy and everything else connects directly. Success: listed sites open, unlisted sites do not use the proxy.
2. Current site: the popup shows whether the current site is "Proxied" or "Direct". "Add to proxy list" adds the site's registrable domain (`mail.google.com` adds `google.com`) and takes effect immediately. When the site is already covered by the list (its domain or a parent of it is listed), the button becomes "Remove from proxy list" and removes the covering entries.
3. Domains on this page: the popup lists every domain the current page requested, each marked Proxied, Direct or Failed. Domains not covered by the list have an "Add" button that adds the registrable domain; it takes effect after reloading the page. When images or videos fail to load, the failed domains are listed first.
4. Managing the list: from the popup, or "Options" in the extension icon's context menu, the user opens the proxy list page (a new tab), sees all domains sorted alphabetically, filters by keyword, adds a domain by typing it, or removes one. Changes take effect immediately.
5. Global mode: with "Global" selected, every address goes through the proxy; `localhost`, `127.0.0.0/8`, private LAN addresses and `.local` still connect directly.
6. Direct mode: with "Direct" selected, nothing is proxied.
7. Visible proxy failure: when the proxy cannot be reached, proxied pages fail to load and never fall back to a direct connection. The icon shows a red error mark and the popup shows "Proxy connection failed" with the time of the latest failure. The mark clears once a proxied request succeeds again.
8. Block direct WebRTC: with "Block direct WebRTC" switched on in the proxy list page, pages cannot learn the user's real IP through direct WebRTC connections; switching it off restores Chrome's default. Off by default.
9. Uncovered domains: in Auto mode, the icon shows how many registrable domains on the current tab the list does not cover (excluding local and LAN addresses). The number is red when one of them failed and gray otherwise; at zero the icon shows the Auto mark. Adding a domain lowers the number immediately; a new page is counted afresh.
10. Proxy settings: on the proxy list page the user chooses the proxy type (SOCKS5 or HTTP) and enters the host and port; saving takes effect immediately. An invalid host or port is not saved and the reason is shown. Without a saved setting the proxy is SOCKS5 `127.0.0.1:12345`.
11. UI language: the UI is in Simplified Chinese when the browser language is Simplified Chinese and in English otherwise.

## Scope

- Three modes, Auto, Global and Direct, switched in the popup; the current mode is recognizable in the popup and on the icon.
- Badge priority: the proxy failure mark first; then, in Auto mode, the current tab's uncovered domain count; Global and Direct modes show no count.
- Proxy: one proxy server, type SOCKS5 or HTTP, host a domain name, IPv4 or IPv6 address, port 1–65535, set on the proxy list page; SOCKS5 `127.0.0.1:12345` when not set. Proxied hostnames are resolved by the proxy, with no local DNS lookup. The proxy failure message shows the current proxy address.
- Popup: mode switch, whether the current site is proxied, add or remove the current site, domains on this page, open the proxy list page.
- Domains on this page: grouped by registrable domain; every domain the current tab requested since it was last opened, with its state (Proxied, Direct, Failed), including domains passed through on redirects (such as login hops); failed ones first; domains not covered by the list can be added in one click. Failed means the request ended in a network error; pending requests are not shown as failed. Cleared when the page is reloaded or navigates to a new page; not kept after the tab closes or the browser restarts.
- Proxy list page: opens in a new tab; alphabetical list with filtering, manual add and remove with undo; opening it again switches to the existing tab.
- WebRTC: a "Block direct WebRTC" switch on the proxy list page, off by default; when on, WebRTC may use only proxied connections, for all sites, which may affect calls on directly connected sites; shows a notice when another extension controls the setting.
- Import and export: the list exports as a text file with one domain per line; importing such a file merges it into the current list without removing anything and reports how many were added, already listed and invalid.
- Domain list: registrable domains come from the bundled Public Suffix List, i.e. the public suffix plus one label (`mail.google.com` → `google.com`, `www.google.com.hk` → `google.com.hk`, `svc-1.us-central1.run.app` → itself); IP addresses are added as they are; an entry matches itself and all its subdomains; duplicates are not added.
- The list, mode and proxy are stored in the local Chrome profile and survive browser restarts.
- UI language: English and Simplified Chinese, chosen from the browser language; anything other than Simplified Chinese shows English.
- Distribution: open source on GitHub under the MIT license; pushing a version tag tests, packages and publishes a GitHub Release with `detour-<version>.zip`; English and Chinese READMEs explain installing it in Chrome with "Load unpacked". The bundled Public Suffix List keeps its MPL 2.0 notice.

## Out of scope

- Multiple proxies, per-domain proxies or proxy authentication.
- Syncing the list across devices.
- Matching by URL path, wildcard or regular expression.
- Keyboard shortcuts.
- Falling back to direct connections when the proxy fails.
- Publishing to the Chrome Web Store; browsers other than Chrome.
- UI languages other than English and Simplified Chinese, or an in-app language switch.

## Acceptance criteria

- In Auto mode, listed domains and their subdomains go through the proxy and unlisted addresses connect directly.
- In Global mode, public addresses go through the proxy and local and LAN addresses connect directly.
- In Direct mode, no address goes through the proxy.
- On `mail.google.com`, "Add to proxy list" adds `google.com`; `www.google.com` then goes through the proxy, the popup shows "Proxied" and the button becomes "Remove from proxy list"; removing it restores direct connections.
- On `www.google.com.hk`, "Add to proxy list" adds `google.com.hk`, not `com.hk`; in domains on this page, the Cloud Run service `svc-1.us-central1.run.app` is grouped under its full service domain, not `run.app`.
- With only `google.com` listed in Auto mode, opening Google shows both the proxied `google.com` and directly connected domains such as `gstatic.com`, the latter with an "Add" button; in Global mode, proxied domains not covered by the list also have an "Add" button.
- With `githubusercontent.com` listed, `avatars.githubusercontent.com` (its own registrable domain, because `githubusercontent.com` is a public suffix) shows as Proxied without an "Add" button, and on such a site the popup button reads "Remove from proxy list".
- On a page that references a domain failing to connect directly, that domain shows as Failed and is listed first; after "Add" and a reload it is proxied.
- The proxy list page sorts alphabetically, a keyword shows only matching entries, removal can be undone, changes on the page show up in the popup, and opening it again does not create a second tab.
- With GOST stopped, a proxied address fails to load, the icon shows the error mark and the popup shows the failure time; after GOST is back and a proxied page loads, the mark clears.
- In Auto mode, a page that references one unlisted direct domain and one failing direct domain shows a red 2; adding one of them drops it to 1 immediately; switching to Global shows the Global mark.
- A page reached through a cross-domain redirect (such as a login hop) lists both the domains along the redirect and the final page's domains.
- With "Block direct WebRTC" on, Chrome's WebRTC IP handling policy is proxied-only; off restores the default; the switch survives a browser restart.
- An exported file imported into a fresh install restores the same list; importing keeps existing domains and skips and counts invalid lines.
- After changing the proxy to HTTP `127.0.0.1:8080` on the proxy list page, listed domains in Auto mode and all public addresses in Global mode go through that HTTP proxy; port `0` or an empty host is not saved and the reason is shown; a fresh install uses SOCKS5 `127.0.0.1:12345`.
- With an English browser the popup and the proxy list page are entirely in English; with a Simplified Chinese browser, entirely in Chinese.
- After a version tag is pushed, the GitHub Release has that version's zip, which installs with "Load unpacked" after unzipping.
- Switching modes, changing the proxy and editing the list take effect without restarting the browser; mode, proxy and list survive a restart.

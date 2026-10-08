import { formatTime, localizePage, t } from './lib/i18n.js';
import { STATE_KEYS, addDomain, formatProxy, isProxiedHost, mainDomain, normalizeDomain, removeDomain, sanitizeState, summarizePageHosts } from './lib/rules.js';

const el = {
  errorBanner: document.getElementById('error-banner'),
  errorDetail: document.getElementById('error-detail'),
  controlBanner: document.getElementById('control-banner'),
  modeInputs: [...document.querySelectorAll('input[name="mode"]')],
  currentDomain: document.getElementById('current-domain'),
  currentStatus: document.getElementById('current-status'),
  toggleCurrent: document.getElementById('toggle-current'),
  pageList: document.getElementById('page-list'),
  pageCount: document.getElementById('page-count'),
  pageEmpty: document.getElementById('page-empty'),
  openManage: document.getElementById('open-manage'),
};

let state = sanitizeState(null);
let currentHost = null;
let pageKey = null;
let pageHosts = {};

async function loadState() {
  state = sanitizeState(await chrome.storage.local.get([...STATE_KEYS]));
}

async function loadTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? '';
  currentHost = /^https?:\/\//i.test(url) ? normalizeDomain(url) : null;
  pageKey = tab ? `page:${tab.id}` : null;
}

async function loadPage() {
  pageHosts = pageKey === null ? {} : ((await chrome.storage.session.get(pageKey))[pageKey] ?? {});
}

async function checkControl() {
  const { levelOfControl } = await chrome.proxy.settings.get({});
  el.controlBanner.hidden = levelOfControl !== 'controlled_by_other_extensions';
}

function tag(text, kind) {
  const span = document.createElement('span');
  span.className = `tag tag-${kind}`;
  span.textContent = text;
  return span;
}

function renderCurrent() {
  const domain = currentHost === null ? null : mainDomain(currentHost);
  el.currentDomain.textContent = domain ?? '—';
  el.currentStatus.hidden = currentHost === null;
  if (currentHost !== null) {
    const proxied = isProxiedHost(state.mode, state.domains, currentHost);
    el.currentStatus.textContent = t(proxied ? 'statusProxied' : 'statusDirect');
    el.currentStatus.className = `tag tag-${proxied ? 'proxy' : 'direct'}`;
  }
  const listed = domain !== null && state.domains.includes(domain);
  el.toggleCurrent.disabled = domain === null;
  el.toggleCurrent.textContent = t(listed ? 'removeFromList' : 'addToList');
  el.toggleCurrent.classList.toggle('secondary', listed);
}

function renderPage() {
  const groups = summarizePageHosts(pageHosts);
  el.pageList.replaceChildren(
    ...groups.map((g) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = g.domain;
      const tags = document.createElement('span');
      tags.className = 'tags';
      if (g.failed) tags.append(tag(t('statusFailed'), 'error'));
      if (g.proxied) tags.append(tag(t('statusProxied'), 'proxy'));
      if (g.direct) tags.append(tag(t('statusDirect'), 'direct'));
      li.append(name, tags);
      if (!state.domains.includes(g.domain)) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'small';
        add.textContent = t('addShort');
        add.addEventListener('click', () => saveDomains(addDomain(state.domains, g.domain).domains));
        li.append(add);
      }
      return li;
    }),
  );
  el.pageCount.textContent = groups.length > 0 ? t('pageCount', groups.length) : '';
  el.pageEmpty.hidden = groups.length > 0;
}

function render() {
  el.errorBanner.hidden = state.lastProxyError === null;
  if (state.lastProxyError !== null) {
    el.errorDetail.textContent = t('proxyFailedDetail', formatProxy(state.proxy), formatTime(state.lastProxyError));
  }
  for (const input of el.modeInputs) input.checked = input.value === state.mode;
  renderCurrent();
  renderPage();
}

async function saveDomains(domains) {
  state = { ...state, domains };
  render();
  await chrome.storage.local.set({ domains });
}

for (const input of el.modeInputs) {
  input.addEventListener('change', async () => {
    state = { ...state, mode: input.value };
    render();
    await chrome.storage.local.set({ mode: input.value });
  });
}

el.toggleCurrent.addEventListener('click', () => {
  const domain = mainDomain(currentHost);
  if (domain === null) return;
  saveDomains(state.domains.includes(domain) ? removeDomain(state.domains, domain) : addDomain(state.domains, domain).domains);
});

el.openManage.addEventListener('click', async () => {
  await chrome.runtime.openOptionsPage();
  window.close();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local') await loadState();
  else if (area === 'session' && pageKey in changes) await loadPage();
  else return;
  render();
});

localizePage();
await Promise.all([loadState(), loadTab().then(loadPage), checkControl()]);
render();

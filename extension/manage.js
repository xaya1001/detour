import { localizePage, t } from './lib/i18n.js';
import { addDomain, exportDomains, formatProxy, importDomains, parseProxy, removeDomain, sanitizeState } from './lib/rules.js';

const UNDO_MS = 6000;

const el = {
  addForm: document.getElementById('add-form'),
  addInput: document.getElementById('add-input'),
  feedback: document.getElementById('feedback'),
  filter: document.getElementById('filter'),
  domainList: document.getElementById('domain-list'),
  listCount: document.getElementById('list-count'),
  listEmpty: document.getElementById('list-empty'),
  toast: document.getElementById('toast'),
  toastText: document.getElementById('toast-text'),
  toastUndo: document.getElementById('toast-undo'),
  importButton: document.getElementById('import'),
  importFile: document.getElementById('import-file'),
  exportButton: document.getElementById('export'),
  proxyForm: document.getElementById('proxy-form'),
  proxyScheme: document.getElementById('proxy-scheme'),
  proxyHost: document.getElementById('proxy-host'),
  proxyPort: document.getElementById('proxy-port'),
  proxyFeedback: document.getElementById('proxy-feedback'),
  blockWebRtc: document.getElementById('block-webrtc'),
  webRtcControl: document.getElementById('webrtc-control'),
};

let domains = [];
let highlight = null;
let undoDomain = null;
let toastTimer = null;

async function load() {
  const state = sanitizeState(await chrome.storage.local.get(['domains', 'proxy', 'blockWebRtc']));
  domains = state.domains;
  el.blockWebRtc.checked = state.blockWebRtc;
  showProxy(state.proxy);
}

function showProxy(proxy) {
  el.proxyScheme.value = proxy.scheme;
  el.proxyHost.value = proxy.host;
  el.proxyPort.value = String(proxy.port);
}

async function checkWebRtcControl() {
  const { levelOfControl } = await chrome.privacy.network.webRTCIPHandlingPolicy.get({});
  el.webRtcControl.hidden = levelOfControl !== 'controlled_by_other_extensions';
}

function showFeedback(text, kind, target = el.feedback) {
  target.textContent = text;
  target.className = `feedback ${kind}`;
}

// Domain name with the matched keyword wrapped in <mark>.
function domainLabel(domain, keyword) {
  const span = document.createElement('span');
  span.className = 'name';
  span.title = domain;
  const i = keyword ? domain.indexOf(keyword) : -1;
  if (i < 0) {
    span.textContent = domain;
  } else {
    const mark = document.createElement('mark');
    mark.textContent = domain.slice(i, i + keyword.length);
    span.append(domain.slice(0, i), mark, domain.slice(i + keyword.length));
  }
  return span;
}

function render() {
  const keyword = el.filter.value.trim().toLowerCase();
  const shown = domains.filter((d) => d.includes(keyword)).sort((a, b) => a.localeCompare(b));
  el.domainList.replaceChildren(
    ...shown.map((domain) => {
      const li = document.createElement('li');
      if (domain === highlight) li.className = 'added';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'remove';
      del.title = t('removeDomain', domain);
      del.setAttribute('aria-label', t('removeDomain', domain));
      del.textContent = '×';
      del.addEventListener('click', () => remove(domain));
      li.append(domainLabel(domain, keyword), del);
      return li;
    }),
  );
  el.listCount.textContent = keyword ? t('listCountFiltered', shown.length, domains.length) : t('listCount', domains.length);
  el.listEmpty.hidden = shown.length > 0;
  el.listEmpty.textContent = domains.length === 0 ? t('listEmpty') : t('noMatch', keyword);
  el.domainList.querySelector('.added')?.scrollIntoView({ block: 'nearest' });
  highlight = null;
}

async function save(next) {
  domains = next;
  render();
  await chrome.storage.local.set({ domains });
}

function remove(domain) {
  undoDomain = domain;
  el.toastText.textContent = t('domainRemoved', domain);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, UNDO_MS);
  save(removeDomain(domains, domain));
}

function hideToast() {
  el.toast.hidden = true;
  undoDomain = null;
}

el.toastUndo.addEventListener('click', () => {
  if (undoDomain === null) return;
  highlight = undoDomain;
  save(addDomain(domains, undoDomain).domains);
  clearTimeout(toastTimer);
  hideToast();
});

el.addForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (el.addInput.value.trim() === '') return;
  const result = addDomain(domains, el.addInput.value);
  if (result.domain === null) {
    showFeedback(t('domainInvalid'), 'error');
    return;
  }
  el.addInput.value = '';
  highlight = result.domain;
  showFeedback(t(result.added ? 'domainAdded' : 'domainListed', result.domain), result.added ? 'ok' : 'muted');
  if (result.added) save(result.domains);
  else render();
});

el.addInput.addEventListener('input', () => showFeedback('', ''));

el.exportButton.addEventListener('click', () => {
  const blob = new Blob([exportDomains(domains)], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `detour-${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showFeedback(t('exported', domains.length), 'ok');
});

el.importButton.addEventListener('click', () => el.importFile.click());

el.importFile.addEventListener('change', async () => {
  const [file] = el.importFile.files;
  el.importFile.value = '';
  if (!file) return;
  const result = importDomains(domains, await file.text());
  showFeedback(
    t('imported', result.added, result.existing, result.invalid),
    result.added > 0 ? 'ok' : 'muted',
  );
  if (result.added > 0) save(result.domains);
});

el.proxyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const { proxy, error } = parseProxy({
    scheme: el.proxyScheme.value,
    host: el.proxyHost.value,
    port: el.proxyPort.value,
  });
  if (error !== undefined) {
    showFeedback(t(error === 'port' ? 'proxyInvalidPort' : 'proxyInvalidHost'), 'error', el.proxyFeedback);
    return;
  }
  showProxy(proxy);
  await chrome.storage.local.set({ proxy });
  showFeedback(t('proxySaved', formatProxy(proxy)), 'ok', el.proxyFeedback);
});

el.blockWebRtc.addEventListener('change', () => {
  chrome.storage.local.set({ blockWebRtc: el.blockWebRtc.checked });
});

el.filter.addEventListener('input', render);
el.filter.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  el.filter.value = '';
  render();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('blockWebRtc' in changes) el.blockWebRtc.checked = changes.blockWebRtc.newValue === true;
  if ('proxy' in changes) showProxy(sanitizeState({ proxy: changes.proxy.newValue }).proxy);
  if (!('domains' in changes)) return;
  const next = sanitizeState({ domains: changes.domains.newValue }).domains;
  if (JSON.stringify(next) === JSON.stringify(domains)) return;
  domains = next;
  render();
});

localizePage();
await Promise.all([load(), checkWebRtcControl()]);
render();
el.addInput.focus();

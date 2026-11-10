import { localizePage, t } from './lib/i18n.js';

localizePage();

const auto = document.getElementById('open-auto');
const direct = document.getElementById('open-direct');
const back = document.getElementById('go-back');
const error = document.getElementById('confirm-error');

function showError() {
  error.textContent = t('confirmUnavailable');
  error.hidden = false;
}

try {
  // The raw fragment keeps the original query string and fragment intact.
  const target = new URL(location.hash.slice(1));
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Invalid destination');
  document.getElementById('target-host').textContent = target.hostname;
  document.getElementById('target-url').textContent = target.href;
  auto.disabled = direct.disabled = false;
} catch {
  showError();
}

async function open(action) {
  auto.disabled = direct.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'confirm-direct', action });
    if (!result?.ok) showError();
  } catch {
    showError();
  }
}

auto.addEventListener('click', () => open('auto'));
direct.addEventListener('click', () => open('direct'));
back.hidden = history.length <= 1;
back.addEventListener('click', () => history.back());

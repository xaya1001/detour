// UI strings from _locales via chrome.i18n (English, or Simplified Chinese when the browser uses it).
export function t(key, ...substitutions) {
  return chrome.i18n.getMessage(key, substitutions.map(String));
}

export function formatTime(ts) {
  return new Date(ts).toLocaleString(chrome.i18n.getUILanguage(), { hour12: false });
}

/** Fill elements marked data-i18n (text), data-i18n-placeholder and data-i18n-aria-label. */
export function localizePage() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
  for (const node of document.querySelectorAll('[data-i18n-aria-label]')) node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel));
}

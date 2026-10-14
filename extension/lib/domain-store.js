import { sanitizeState } from './rules.js';

// All extension pages share this lock. Read the latest list inside the lock so
// an import, popup click, or undo cannot overwrite another page's edits.
export function updateDomains(change) {
  return navigator.locks.request('detour-domains', async () => {
    const { domains } = sanitizeState(await chrome.storage.local.get('domains'));
    const result = change(domains);
    if (JSON.stringify(result.domains) !== JSON.stringify(domains)) {
      await chrome.storage.local.set({ domains: result.domains });
    }
    return result;
  });
}

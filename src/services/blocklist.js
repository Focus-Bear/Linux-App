// Helpers for the synced block list (`kArrBlockedUrls` in the account's device
// settings). Sites and keywords live in the same list, as they do in the Mac
// and Windows apps: an entry with a dot is a site ("facebook.com",
// "*.reddit.com"); an entry without one is a keyword and matches anywhere in a
// URL ("celebrity"). Keeping one list means keywords sync between devices.
//
// Pure functions only (no React, no Electron) so they can be unit tested.

/** True when a block-list entry is a keyword rather than a site. */
export function isKeywordEntry(entry) {
  return typeof entry === 'string' && entry.trim().length > 0 && !entry.includes('.');
}

export function sitesOf(list = []) {
  return list.filter((entry) => typeof entry === 'string' && entry.trim() && !isKeywordEntry(entry));
}

export function keywordsOf(list = []) {
  return list.filter(isKeywordEntry);
}

/** Lower-cased, trimmed keyword, or '' when there is nothing left. */
export function normaliseKeyword(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** Why a keyword can't be added, or null when it is fine. */
export function keywordError(value, list = []) {
  const keyword = normaliseKeyword(value);
  if (!keyword) return 'Type a keyword first.';
  if (keyword.includes('.')) return 'That looks like a website. Add it under Super Distracting Sites.';
  if (/\s/.test(keyword)) return 'Use a single word. Web addresses have no spaces.';
  if (keyword.length < 3) return 'Use at least 3 letters, or too many pages will be blocked.';
  if (list.some((entry) => normaliseKeyword(entry) === keyword)) return 'That keyword is already on your list.';
  return null;
}

/** Why a site can't be added, or null when it is fine. */
export function siteError(value, list = []) {
  const site = String(value ?? '').trim();
  if (!site) return 'Type a website first.';
  if (/\s/.test(site)) return 'Web addresses have no spaces.';
  if (!site.includes('.')) return 'Add the full address, like facebook.com. Single words go under Keyword Blocking.';
  if (list.includes(site)) return 'That site is already on your list.';
  return null;
}

/** The list with `entry` appended, unless it is empty or already there. */
export function addEntry(list = [], entry) {
  const value = String(entry ?? '').trim();
  if (!value || list.includes(value)) return list;
  return [...list, value];
}

/**
 * The list without the chosen entries. `view` is what the page shows (the
 * sites or the keywords) and `indices` are positions in that view, so removing
 * from one page never touches the other page's entries.
 */
export function removeFromView(list = [], view = [], indices = new Set()) {
  const doomed = new Set(view.filter((_, index) => indices.has(index)));
  if (doomed.size === 0) return list;
  return list.filter((entry) => !doomed.has(entry));
}

// --- mapping to the account's device settings ------------------------------
// The server stores one JSON object per platform; like the Windows app, Linux
// reads and writes the `MacOS` object so settings follow the user everywhere.

/** Parses the `MacOS` value of GET /user-local-device-settings (object or JSON string). */
export function parseDeviceSettings(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? { ...raw } : {};
}

/** Device settings → the app's synced states (only keys the server has). */
export function fromDeviceSettings(device = {}) {
  const mapped = {};
  if (Array.isArray(device.kArrBlockedUrls)) {
    mapped.urlList = device.kArrBlockedUrls.filter((entry) => typeof entry === 'string');
  }
  if (typeof device.kCuddlyModeEnabled === 'boolean') {
    mapped.selectedBearMode = device.kCuddlyModeEnabled ? 'cuddly' : 'grizzly';
  }
  if (typeof device.kImmediatelyBlockDistractingSites === 'boolean') {
    mapped.immediatelyBlock = device.kImmediatelyBlockDistractingSites;
  }
  return mapped;
}

/** Copy of the device settings with the app's synced states written in; other keys are kept. */
export function toDeviceSettings(device = {}, settings = {}) {
  const next = { ...device };
  if (Array.isArray(settings.urlList)) next.kArrBlockedUrls = settings.urlList;
  if (settings.selectedBearMode) next.kCuddlyModeEnabled = settings.selectedBearMode === 'cuddly';
  if (typeof settings.immediatelyBlock === 'boolean') {
    next.kImmediatelyBlockDistractingSites = settings.immediatelyBlock;
  }
  return next;
}

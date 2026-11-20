/**
 * Chrome MV3 service worker - native messaging + declarativeNetRequest blocking
 */

let port = null;
let blocklist = [];
let whitelist = []; // { pattern, type: 'domain'|'exact', expiresAt }
let isConnected = false;
let isConnectedToApp = false;
// "Immediately block super distracting sites": no temporary unblocks while on.
let immediatelyBlock = false;

const WHITELIST_DURATION_MS = 30 * 60 * 1000;
const NATIVE_HOST = 'com.focusbear.native_host';

// Detect which Chromium-based browser we're in so Electron knows which process to kill.
// UA strings are useless here — Chromium's UA is identical to Chrome's.
// userAgentData.brands is the reliable signal: Chrome has "Google Chrome", Chromium does not.
const BROWSER_ID = (() => {
  if (typeof navigator.brave !== 'undefined') return 'brave';
  if (/OPR\/|Opera/.test(navigator.userAgent)) return 'opera';
  const brands = navigator.userAgentData?.brands?.map(b => b.brand) ?? [];
  if (brands.includes('Google Chrome')) return 'chrome';
  if (brands.includes('Chromium')) return 'chromium';
  return 'chrome';
})();

function log(message) {
  console.log('[Focus Bear Extension]', message);
}

function escapeRegex(str) {
  return str.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
}

function stripProtocol(u) {
  return u.replace(/^https?:\/\//, '');
}

// Allow list in force (a focus session or blocking schedule that uses an
// allow list): null, or the only sites that may be opened. Sent by the app in
// BLOCK_SETTINGS_UPDATE. The rule matches src/electron/blockingModel.js
// (matchesEntry): lower case, without scheme and "www.", the entry anywhere in
// the URL, "*" as a wildcard.
let allowOnly = null;
// The app renews the allow list every minute while it is in force. If the app
// stops without saying so (crash, power cut), the allow list lapses at this
// time instead of blocking the whole web until the app is next opened.
let allowOnlyUntil = 0;

// Never blocked by an allow list: Focus Bear's own pages and sign-in.
const ALWAYS_ALLOWED_HOSTS = ['focusbear.io', 'auth0.com', 'localhost', '127.0.0.1'];

function readAllowOnly(value, until) {
  allowOnlyUntil = Number(until) || 0;
  if (!Array.isArray(value) || Date.now() > allowOnlyUntil) return null;
  return value.filter(e => typeof e === 'string' && e.trim());
}

function allowListInForce() {
  return Boolean(allowOnly) && Date.now() <= allowOnlyUntil;
}

function normaliseEntry(entry) {
  return String(entry).trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}

function matchesEntry(url, entry) {
  const target = url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  const pattern = normaliseEntry(entry);
  if (!pattern) return false;
  if (!pattern.includes('*')) return target.includes(pattern);
  const source = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  try { return new RegExp(source).test(target); } catch { return false; }
}

// True when an allow list is in force and this page is not on it.
function isOutsideAllowList(url) {
  if (!allowListInForce() || !/^https?:\/\//i.test(url)) return false;
  try {
    const hostname = new URL(url).hostname;
    if (ALWAYS_ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h))) return false;
  } catch {
    return false;
  }
  return !allowOnly.some(entry => matchesEntry(url, entry));
}

// ── DNR ──────────────────────────────────────────────────────────────────────

async function updateDNRRules() {
  const blockedPageBase = chrome.runtime.getURL('blocked.html');
  const rules = [];
  let id = 1;

  // Priorities: temporary unblocks (4) beat the block list (3), which beats an
  // allow list's sites (2), which beat its block-everything-else rule (1).
  const activeWhitelist = immediatelyBlock ? [] : whitelist.filter(e => e.expiresAt > Date.now());
  for (const entry of activeWhitelist) {
    let regexFilter;
    if (entry.type === 'domain') {
      regexFilter = `^https?://(.*\\.)?${escapeRegex(entry.pattern)}(/.*)?$`;
    } else {
      regexFilter = `^${escapeRegex(stripProtocol(entry.pattern))}$`;
    }
    rules.push({
      id: id++,
      priority: 4,
      action: { type: 'allow' },
      condition: { regexFilter, resourceTypes: ['main_frame', 'sub_frame'] }
    });
  }

  // All rules use regexFilter so \0 in regexSubstitution = full matched URL
  const MAX_RULES = 1000 - activeWhitelist.length;
  for (const pattern of blocklist.slice(0, MAX_RULES)) {
    const isRegex = pattern.includes('.*') || pattern.includes('\\');
    const core = isRegex ? pattern : escapeRegex(pattern);
    const reason = isRegex ? 'regex' : 'domain';
    rules.push({
      id: id++,
      priority: 3,
      action: {
        type: 'redirect',
        redirect: {
          // URL goes into hash — avoids query-string encoding issues with & in URLs
          regexSubstitution: `${blockedPageBase}#\\0`
        }
      },
      condition: {
        regexFilter: `.*${core}.*`,
        resourceTypes: ['main_frame']
      }
    });
    void reason;
  }

  // An allow list is in force: its sites and Focus Bear's own pages open, every
  // other page goes to the block page.
  if (allowListInForce()) {
    const allowed = [
      ...ALWAYS_ALLOWED_HOSTS.map(host => `^https?://([^/]*\\.)?${escapeRegex(host)}(:[0-9]+)?(/.*)?$`),
      ...allowOnly.slice(0, 500).map(normaliseEntry).filter(Boolean)
        .map(entry => `.*${entry.split('*').map(escapeRegex).join('.*')}.*`),
    ];
    for (const regexFilter of allowed) {
      rules.push({
        id: id++,
        priority: 2,
        action: { type: 'allow' },
        condition: { regexFilter, isUrlFilterCaseSensitive: false, resourceTypes: ['main_frame'] }
      });
    }
    rules.push({
      id: id++,
      priority: 1,
      action: {
        type: 'redirect',
        redirect: { regexSubstitution: `${blockedPageBase}?reason=allow_list#\\0` }
      },
      condition: { regexFilter: '^https?://.*', resourceTypes: ['main_frame'] }
    });
  }

  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map(r => r.id),
      addRules: rules
    });
    log(`DNR updated: ${rules.length} rules (${activeWhitelist.length} allow, ${rules.length - activeWhitelist.length} block)`);
  } catch (err) {
    log('DNR update failed: ' + err.message);
  }
}

// ── Whitelist ─────────────────────────────────────────────────────────────────

function pruneWhitelist() {
  const before = whitelist.length;
  whitelist = whitelist.filter(e => e.expiresAt > Date.now());
  if (whitelist.length !== before) {
    chrome.storage.local.set({ whitelist });
  }
  return whitelist;
}

function isWhitelistedUrl(url) {
  if (immediatelyBlock) return false;
  const active = whitelist.filter(e => e.expiresAt > Date.now());
  for (const entry of active) {
    try {
      if (entry.type === 'exact' && url.replace(/^https?:\/\//, '') === entry.pattern.replace(/^https?:\/\//, '')) return true;
      if (entry.type === 'domain') {
        const hostname = new URL(url).hostname;
        if (hostname === entry.pattern || hostname.endsWith('.' + entry.pattern)) return true;
      }
    } catch {}
  }
  return false;
}

async function maybeBlockTab(tabId, url) {
  if (!url || !url.startsWith('http')) return;
  if (isWhitelistedUrl(url)) return;
  const listed = isBlockedByList(url);
  if (!listed && !isOutsideAllowList(url)) return;
  const page = chrome.runtime.getURL('blocked.html') + (listed ? '' : '?reason=allow_list');
  await chrome.tabs.update(tabId, { url: page + '#' + url }).catch(() => {});
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) await maybeBlockTab(tabId, tab.url);
  } catch {}
});

function notifyWhitelistUpdate() {
  if (port && isConnected) {
    try {
      port.postMessage({ type: 'WHITELIST_UPDATE', data: whitelist });
    } catch (e) {
      log('Failed to notify host of whitelist update: ' + e.message);
    }
  }
}

// ── Native messaging ──────────────────────────────────────────────────────────

function connectToNativeHost() {
  log('Connecting to native host...');
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);

    port.onMessage.addListener((message) => {
      log('Received: ' + message.type);
      switch (message.type) {
        case 'BLOCKLIST_RESPONSE':
        case 'BLOCKLIST_UPDATE':
          blocklist = message.data || [];
          chrome.storage.local.set({ blocklist, lastUpdate: message.timestamp });
          updateDNRRules();
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.url) maybeBlockTab(tabs[0].id, tabs[0].url).catch(() => {});
          });
          break;

        case 'BLOCK_SETTINGS_UPDATE':
          immediatelyBlock = message.data?.immediatelyBlock === true;
          allowOnly = readAllowOnly(message.data?.allowOnly, message.data?.allowOnlyUntil);
          chrome.storage.local.set({ immediatelyBlock, allowOnly, allowOnlyUntil });
          updateDNRRules();
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.url) maybeBlockTab(tabs[0].id, tabs[0].url).catch(() => {});
          });
          break;

        case 'WHITELIST_RESPONSE':
        case 'WHITELIST_UPDATE':
          whitelist = (message.data || []).filter(e => e.expiresAt > Date.now());
          chrome.storage.local.set({ whitelist });
          updateDNRRules();
          break;

        case 'PONG':
          isConnected = true;
          isConnectedToApp = message.connectedToApp || false;
          log('Pong received, app connected: ' + isConnectedToApp);
          break;

        case 'ERROR':
          log('Error from host: ' + message.error);
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      isConnected = false;
      isConnectedToApp = false;
      port = null;
      if (chrome.runtime.lastError) {
        log('Disconnect error: ' + chrome.runtime.lastError.message);
      }
      // Do not retry here — SW suspension closes the port normally.
      // The 'ping' alarm wakes the SW every 60s and reconnects if port is gone.
    });

    port.postMessage({ type: 'PING', browser: BROWSER_ID });

  } catch (err) {
    log('Connect failed: ' + err.message);
    isConnected = false;
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function restoreState() {
  const result = await chrome.storage.local.get(['blocklist', 'whitelist', 'immediatelyBlock', 'allowOnly', 'allowOnlyUntil']);
  immediatelyBlock = result.immediatelyBlock === true;
  allowOnly = readAllowOnly(result.allowOnly, result.allowOnlyUntil);
  blocklist = result.blocklist || [];
  whitelist = (result.whitelist || []).filter(e => e.expiresAt > Date.now());
  await updateDNRRules();
}

chrome.runtime.onInstalled.addListener(async () => {
  await restoreState();
  connectToNativeHost();
  chrome.alarms.create('pruneWhitelist', { periodInMinutes: 1 });
  chrome.alarms.create('ping', { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(async () => {
  await restoreState();
  connectToNativeHost();
});

// SW wakes cold on every alarm — restore state and reconnect if port is gone.
// onInstalled/onStartup only fire once; this covers all subsequent wakes.
restoreState().then(() => {
  if (!port) connectToNativeHost();
  // Ensure ping alarm survives SW restarts (alarms persist but recreating is idempotent)
  chrome.alarms.get('ping', alarm => { if (!alarm) chrome.alarms.create('ping', { periodInMinutes: 1 }); });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'pruneWhitelist') {
    const before = whitelist.length;
    pruneWhitelist();
    if (whitelist.length !== before) {
      notifyWhitelistUpdate();
      await updateDNRRules();

      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.url) continue;
        const shouldReload = whitelist.length < before && isBlockedByList(tab.url);
        if (shouldReload) chrome.tabs.reload(tab.id).catch(() => {});
      }
    }
  }

  if (alarm.name === 'ping') {
    // The allow list was not renewed (the app stopped): lift it.
    if (allowOnly && !allowListInForce()) {
      allowOnly = null;
      chrome.storage.local.set({ allowOnly });
      await updateDNRRules();
    }
    if (!port || !isConnected) connectToNativeHost();
  }
});

function isBlockedByList(url) {
  return blocklist.some(pattern => {
    if (url.includes(pattern)) return true;
    try {
      const hostname = new URL(url).hostname;
      return hostname === pattern || hostname.endsWith('.' + pattern);
    } catch { return false; }
  });
}

// ── Message handler (popup / blocked page) ────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_STATUS') {
    sendResponse({ connected: isConnected, connectedToApp: isConnectedToApp, blocklistSize: blocklist.length, whitelistSize: pruneWhitelist().length });

  } else if (message.type === 'REFRESH_BLOCKLIST') {
    if (port && isConnected) {
      port.postMessage({ type: 'GET_BLOCKLIST' });
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'Not connected' });
    }

  } else if (message.type === 'GET_WHITELIST') {
    sendResponse({ whitelist: pruneWhitelist() });

  } else if (message.type === 'ADD_WHITELIST' && immediatelyBlock) {
    sendResponse({ success: false, error: 'Immediate blocking is on' });

  } else if (message.type === 'ADD_WHITELIST') {
    const durationMs = message.durationMs || WHITELIST_DURATION_MS;
    const entry = { pattern: message.pattern, type: message.patternType, expiresAt: Date.now() + durationMs };
    whitelist = pruneWhitelist().filter(e => e.pattern !== message.pattern);
    whitelist.push(entry);
    chrome.storage.local.set({ whitelist });
    notifyWhitelistUpdate();
    updateDNRRules();
    sendResponse({ success: true });

  } else if (message.type === 'REMOVE_WHITELIST') {
    whitelist = pruneWhitelist().filter(e => e.pattern !== message.pattern);
    chrome.storage.local.set({ whitelist });
    notifyWhitelistUpdate();
    updateDNRRules();
    sendResponse({ success: true });
  }

  return true;
});

log('Service worker loaded');

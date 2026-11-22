/**
 * Chrome MV3 service worker - native messaging + declarativeNetRequest blocking
 */
/* global importScripts */

let port = null;
let blocklist = [];
let whitelist = []; // { pattern, type: 'domain'|'exact', expiresAt }
let isConnected = false;
let isConnectedToApp = false;
// "Immediately block super distracting sites": no temporary unblocks while on.
let immediatelyBlock = false;

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

// The matching rules (matching.js) and the rule building (dnr.js) are in their
// own files, without chrome.* calls, so they can be tested.
importScripts('matching.js', 'dnr.js');

const M = self.FocusBearMatching;
const Dnr = self.FocusBearDnr;

// The block list as sent by the app, and the same list prepared for matching.
let compiledBlocklist = [];
function setBlocklist(list) {
  blocklist = Array.isArray(list) ? list.filter(entry => typeof entry === 'string') : [];
  compiledBlocklist = M.compileBlocklist(blocklist);
}

// Allow list in force (a focus session or blocking schedule that uses an
// allow list): null, or the only sites that may be opened. Sent by the app in
// BLOCK_SETTINGS_UPDATE. How an entry matches is in matching.js (matchesEntry):
// in the host, or in host + path when the entry has a "/". Never in the query.
let allowOnly = null;
// The app renews the allow list every minute while it is in force. If the app
// stops without saying so (crash, power cut), the allow list lapses at this
// time instead of blocking the whole web until the app is next opened. Never
// more than 3 minutes ahead, whatever was sent or stored (capAllowOnlyUntil).
let allowOnlyUntil = 0;

function setAllowOnly(value, until) {
  const read = M.readAllowOnly(value, until, Date.now());
  allowOnly = read.allowOnly;
  allowOnlyUntil = read.allowOnlyUntil;
}

function allowListInForce() {
  // Capped every time it is read: a clock set back must not stretch it.
  allowOnlyUntil = M.capAllowOnlyUntil(allowOnlyUntil, Date.now());
  return Boolean(allowOnly) && Date.now() <= allowOnlyUntil;
}

// True when an allow list is in force and this page is not on it.
function isOutsideAllowList(url) {
  return allowListInForce() && M.isOutsideAllowList(url, allowOnly);
}

// ── DNR ──────────────────────────────────────────────────────────────────────

const regexSupported = Dnr.createRegexChecker(options => chrome.declarativeNetRequest.isRegexSupported(options));
const dnrQueue = Dnr.createQueue();

// One update at a time: the app sends BLOCKLIST_UPDATE and
// BLOCK_SETTINGS_UPDATE back to back, and two updates at once collide.
function updateDNRRules() {
  return dnrQueue(async () => {
    try {
      const plan = await Dnr.buildRules(
        { blocklist, whitelist, allowOnly: allowListInForce() ? allowOnly : null, immediatelyBlock, now: Date.now() },
        { blockedPageBase: chrome.runtime.getURL('blocked.html'), supported: regexSupported }
      );
      const result = await Dnr.applyRules(chrome.declarativeNetRequest, plan, log);
      log(`DNR updated: ${plan.dynamic.length} block list rules${result.dynamicOk ? '' : ' (refused)'}, ` +
        `${plan.session.length} allow list rules${result.sessionOk ? '' : ' (refused)'}, ` +
        `${plan.skipped} entries Chrome does not support, ${plan.dropped} over the limit`);
    } catch (err) {
      log('DNR update failed: ' + err.message);
    }
  });
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
  return M.isWhitelisted(url, whitelist, Date.now());
}

async function maybeBlockTab(tabId, url) {
  if (!url || !url.startsWith('http')) return;
  if (isWhitelistedUrl(url)) return;
  const listed = isBlockedByList(url);
  if (!listed && !isOutsideAllowList(url)) return;
  const page = chrome.runtime.getURL('blocked.html') + (listed ? '' : '?reason=allow_list');
  await chrome.tabs.update(tabId, { url: page + '#' + url }).catch(() => {});
}

// Every tab, not only the one in front: a site open in another window (or
// playing in a background tab) must not stay usable after the rules change.
async function recheckAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.url) await maybeBlockTab(tab.id, tab.url);
    }
  } catch { /* no tabs to check */ }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) await maybeBlockTab(tabId, tab.url);
  } catch { /* the tab is gone */ }
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
          setBlocklist(message.data);
          chrome.storage.local.set({ blocklist, lastUpdate: message.timestamp });
          updateDNRRules();
          recheckAllTabs();
          break;

        case 'BLOCK_SETTINGS_UPDATE':
          immediatelyBlock = message.data?.immediatelyBlock === true;
          setAllowOnly(message.data?.allowOnly, message.data?.allowOnlyUntil);
          chrome.storage.local.set({ immediatelyBlock, allowOnly, allowOnlyUntil });
          updateDNRRules();
          recheckAllTabs();
          break;

        case 'WHITELIST_RESPONSE':
        case 'WHITELIST_UPDATE':
          whitelist = M.readWhitelist(message.data, Date.now());
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
  setAllowOnly(result.allowOnly, result.allowOnlyUntil);
  setBlocklist(result.blocklist);
  whitelist = M.readWhitelist(result.whitelist, Date.now());
  // Also removes allow-list rules an older version left in the dynamic rules.
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
  return Boolean(M.findBlocked(url, compiledBlocklist));
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
    // Never longer than the block page offers (90 minutes).
    const entry = { pattern: message.pattern, type: message.patternType, expiresAt: Date.now() + M.unblockDuration(message.durationMs) };
    whitelist = M.readWhitelist([...pruneWhitelist().filter(e => e.pattern !== message.pattern), entry], Date.now());
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

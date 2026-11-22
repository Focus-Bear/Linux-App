let port = null;
let blocklist = [];
let whitelist = []; // { pattern, type: 'domain'|'exact', expiresAt }
let isConnected = false;
let isConnectedToApp = false;
// "Immediately block super distracting sites": no temporary unblocks while on.
let immediatelyBlock = false;

// The matching rules are in matching.js (loaded before this file, see the
// manifest), without browser.* calls, so they can be tested.
const M = self.FocusBearMatching;

// The block list as sent by the app, and the same list prepared for matching
// (lower case, without scheme; "com", "www", "http" and "https" block nothing).
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

// Sent in every PING so Electron knows which browser to kill if extension goes missing.
const BROWSER_ID = (() => {
  if (typeof browser !== 'undefined' && browser.runtime?.getBrowserInfo) return 'firefox';
  if (navigator.userAgent.includes('Chrome')) return 'chrome';
  return 'unknown';
})();

browser.storage.local.get(['whitelist', 'blocklist', 'immediatelyBlock', 'allowOnly', 'allowOnlyUntil']).then(result => {
  immediatelyBlock = result.immediatelyBlock === true;
  setAllowOnly(result.allowOnly, result.allowOnlyUntil);
  whitelist = M.readWhitelist(result.whitelist, Date.now());
  browser.storage.local.set({ whitelist });
  setBlocklist(result.blocklist);
});

function pruneWhitelist() {
  const before = whitelist.length;
  whitelist = whitelist.filter(e => e.expiresAt > Date.now());
  if (whitelist.length !== before) {
    browser.storage.local.set({ whitelist });
  }
  return whitelist;
}

const stripProtocol = M.stripProtocol;

function isWhitelisted(url) {
  if (immediatelyBlock) return false;
  pruneWhitelist();
  return M.isWhitelisted(url, whitelist, Date.now());
}

function isBlockedUrl(url) {
  return Boolean(M.findBlocked(url, compiledBlocklist));
}

function maybeBlockTab(tabId, url) {
  if (!url || !url.startsWith('http')) return;
  if (url.startsWith(browser.runtime.getURL(''))) return;
  if (isWhitelisted(url)) return;
  const listed = isBlockedUrl(url);
  if (!listed && !isOutsideAllowList(url)) return;
  const blockPageUrl = browser.runtime.getURL('blocked.html') +
    `?url=${encodeURIComponent(url)}&reason=${listed ? 'tab_switch' : 'allow_list'}`;
  browser.tabs.update(tabId, { url: blockPageUrl }).catch(() => {});
}

// Every tab, not only the one in front: a site open in another window (or
// playing in a background tab) must not stay usable after the rules change,
// for example when "Immediately block" is switched on.
function recheckAllTabs() {
  browser.tabs.query({}).then(tabs => {
    for (const tab of tabs) {
      if (tab.url) maybeBlockTab(tab.id, tab.url);
    }
  }).catch(() => {});
}

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.url) maybeBlockTab(tabId, tab.url);
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

function log(message) {
  console.log('[Focus Bear Extension]', message);
}

function connectToNativeHost() {
  log('Attempting to connect to native host...');
  
  try {
    port = browser.runtime.connectNative('com.focusbear.native_host');
    
    port.onMessage.addListener((message) => {
      log('Received message from native host:', message);
      
      switch (message.type) {
        case 'BLOCKLIST_RESPONSE':
        case 'BLOCKLIST_UPDATE':
          setBlocklist(message.data);
          log(`Updated blocklist: ${blocklist.length} entries`);
          browser.storage.local.set({ blocklist, lastUpdate: message.timestamp });
          recheckAllTabs();
          break;

        case 'BLOCK_SETTINGS_UPDATE':
          immediatelyBlock = message.data?.immediatelyBlock === true;
          setAllowOnly(message.data?.allowOnly, message.data?.allowOnlyUntil);
          log(`Immediately block: ${immediatelyBlock}; allow list: ${allowOnly ? allowOnly.length + ' sites' : 'off'}`);
          browser.storage.local.set({ immediatelyBlock, allowOnly, allowOnlyUntil });
          recheckAllTabs();
          break;

        case 'WHITELIST_RESPONSE':
        case 'WHITELIST_UPDATE':
          // Incoming from Electron (authoritative source) — replace local state
          whitelist = M.readWhitelist(message.data, Date.now());
          log(`Received whitelist from app: ${whitelist.length} entries`);
          browser.storage.local.set({ whitelist });
          break;
          
        case 'PONG':
          log('Connection confirmed (pong received)');
          isConnected = true;
          isConnectedToApp = message.connectedToApp || false;
          log(`Native host connected to Electron app: ${isConnectedToApp}`);
          // Request authoritative whitelist from Electron (covers reinstall)
          port.postMessage({ type: 'GET_WHITELIST' });
          break;
          
        case 'ERROR':
          log('Error from native host:', message.error);
          break;
      }
    });
    
    port.onDisconnect.addListener(() => {
      log('Disconnected from native host');
      isConnected = false;
      isConnectedToApp = false;
      port = null;
      
      if (browser.runtime.lastError) {
        log('Disconnect error:', browser.runtime.lastError.message);
      }
      
      setTimeout(connectToNativeHost, 5000);
    });

    port.postMessage({ type: 'PING', browser: BROWSER_ID });
    setTimeout(() => port.postMessage({ type: 'GET_BLOCKLIST' }), 100);

  } catch (error) {
    log('Failed to connect to native host:', error);
    isConnected = false;
    setTimeout(connectToNativeHost, 5000);
  }
}

connectToNativeHost();

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_STATUS') {
    sendResponse({
      connected: isConnected,
      connectedToApp: isConnectedToApp,
      blocklistSize: blocklist.length,
      whitelistSize: pruneWhitelist().length
    });
  } else if (message.type === 'REFRESH_BLOCKLIST') {
    if (port && isConnected) {
      port.postMessage({ type: 'GET_BLOCKLIST' });
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'Not connected to native host' });
    }
  } else if (message.type === 'GET_WHITELIST') {
    sendResponse({ whitelist: pruneWhitelist() });
  } else if (message.type === 'ADD_WHITELIST' && immediatelyBlock) {
    sendResponse({ success: false, error: 'Immediate blocking is on' });
  } else if (message.type === 'ADD_WHITELIST') {
    // Never longer than the block page offers (90 minutes).
    const entry = {
      pattern: message.pattern,
      type: message.patternType,
      expiresAt: Date.now() + M.unblockDuration(message.durationMs)
    };
    whitelist = M.readWhitelist([...pruneWhitelist().filter(e => e.pattern !== message.pattern), entry], Date.now());
    browser.storage.local.set({ whitelist });
    notifyWhitelistUpdate();
    log(`Whitelist added: ${message.patternType}:${message.pattern}`);
    sendResponse({ success: true });
  } else if (message.type === 'REMOVE_WHITELIST') {
    whitelist = pruneWhitelist().filter(e => e.pattern !== message.pattern);
    browser.storage.local.set({ whitelist });
    notifyWhitelistUpdate();
    sendResponse({ success: true });
  }
  return true; // Keep channel open for async response
});

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    if (url.startsWith(browser.runtime.getURL(''))) return { cancel: false };
    if (isWhitelisted(url)) {
      log(`Whitelist pass: ${url}`);
      return { cancel: false };
    }

    const blockedBy = M.findBlocked(url, compiledBlocklist);
    if (blockedBy) {
      log(`Blocking: ${url} (matched: ${blockedBy.pattern})`);
      const blockPageUrl = browser.runtime.getURL('blocked.html') +
        `?url=${encodeURIComponent(url)}` +
        `&value=${encodeURIComponent(blockedBy.pattern)}` +
        `&reason=${blockedBy.kind}`;
      return { redirectUrl: blockPageUrl };
    }

    // An allow list is in force: only pages on it open. Checked for the page
    // itself, not for what an allowed page loads.
    if (details.type === 'main_frame' && isOutsideAllowList(url)) {
      log(`Blocking (not on the allow list): ${url}`);
      const blockPageUrl = browser.runtime.getURL('blocked.html') +
        `?url=${encodeURIComponent(url)}` +
        `&value=${encodeURIComponent('Not on your allow list')}` +
        `&reason=allow_list`;
      return { redirectUrl: blockPageUrl };
    }

    return { cancel: false };
  },
  { urls: ["<all_urls>"] },
  ["blocking"]
);

log('Background script loaded');

setInterval(() => {
  if (port && isConnected) {
    try {
      port.postMessage({ type: 'PING', browser: BROWSER_ID });
    } catch (error) {
      log(`Error sending periodic ping: ${error.message}`);
    }
  }
}, 10000);

// Prune whitelist, sync to Electron, reload active tab if it matched an expired entry
setInterval(() => {
  const expired = whitelist.filter(e => e.expiresAt <= Date.now());
  pruneWhitelist();
  if (expired.length === 0) return;

  log(`Pruned ${expired.length} expired whitelist entries`);
  notifyWhitelistUpdate();

  browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    const tab = tabs[0];
    if (!tab || !tab.url) return;
    const matched = expired.some(entry => {
      try {
        const hostname = new URL(tab.url).hostname;
        return entry.type === 'exact'
          ? stripProtocol(tab.url) === stripProtocol(entry.pattern)
          : hostname === entry.pattern || hostname.endsWith('.' + entry.pattern);
      } catch { return false; }
    });
    if (matched) {
      log(`Active tab ${tab.url} matched expired whitelist entry — reloading`);
      browser.tabs.reload(tab.id);
    }
  });
}, 60 * 1000);

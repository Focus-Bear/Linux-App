let port = null;
let blocklist = [];
let whitelist = []; // { pattern, type: 'domain'|'exact', expiresAt }
let isConnected = false;
let isConnectedToApp = false;
// "Immediately block super distracting sites": no temporary unblocks while on.
let immediatelyBlock = false;

const WHITELIST_DURATION_MS = 30 * 60 * 1000;

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

// Sent in every PING so Electron knows which browser to kill if extension goes missing.
const BROWSER_ID = (() => {
  if (typeof browser !== 'undefined' && browser.runtime?.getBrowserInfo) return 'firefox';
  if (navigator.userAgent.includes('Chrome')) return 'chrome';
  return 'unknown';
})();

browser.storage.local.get(['whitelist', 'blocklist', 'immediatelyBlock', 'allowOnly', 'allowOnlyUntil']).then(result => {
  immediatelyBlock = result.immediatelyBlock === true;
  allowOnly = readAllowOnly(result.allowOnly, result.allowOnlyUntil);
  whitelist = (result.whitelist || []).filter(e => e.expiresAt > Date.now());
  browser.storage.local.set({ whitelist });
  blocklist = result.blocklist || [];
});

function pruneWhitelist() {
  const before = whitelist.length;
  whitelist = whitelist.filter(e => e.expiresAt > Date.now());
  if (whitelist.length !== before) {
    browser.storage.local.set({ whitelist });
  }
  return whitelist;
}

const stripProtocol = u => u.replace(/^https?:\/\//, '');

function isWhitelisted(url) {
  if (immediatelyBlock) return false;
  pruneWhitelist();
  for (const entry of whitelist) {
    if (entry.type === 'exact' && stripProtocol(url) === stripProtocol(entry.pattern)) return true;
    if (entry.type === 'domain') {
      try {
        const hostname = new URL(url).hostname;
        if (hostname === entry.pattern || hostname.endsWith('.' + entry.pattern)) return true;
      } catch (e) {}
    }
  }
  return false;
}

function isBlockedUrl(url) {
  for (const pattern of blocklist) {
    try {
      if (url.includes(pattern)) return true;
      if (pattern.includes('.*') || pattern.includes('\\')) {
        try { if (new RegExp(pattern, 'i').test(url)) return true; } catch (e) {}
      }
      try {
        const hostname = new URL(url).hostname;
        if (hostname === pattern || hostname.endsWith('.' + pattern) ||
            (pattern.startsWith('.') && hostname.endsWith(pattern))) return true;
      } catch (e) {}
    } catch (e) {}
  }
  return false;
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

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.url) maybeBlockTab(tabId, tab.url);
  } catch (e) {}
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
          blocklist = message.data || [];
          log(`Updated blocklist: ${blocklist.length} entries`);
          browser.storage.local.set({ blocklist, lastUpdate: message.timestamp });
          browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
            if (tabs[0]?.url) maybeBlockTab(tabs[0].id, tabs[0].url);
          }).catch(() => {});
          break;

        case 'BLOCK_SETTINGS_UPDATE':
          immediatelyBlock = message.data?.immediatelyBlock === true;
          allowOnly = readAllowOnly(message.data?.allowOnly, message.data?.allowOnlyUntil);
          log(`Immediately block: ${immediatelyBlock}; allow list: ${allowOnly ? allowOnly.length + ' sites' : 'off'}`);
          browser.storage.local.set({ immediatelyBlock, allowOnly, allowOnlyUntil });
          browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
            if (tabs[0]?.url) maybeBlockTab(tabs[0].id, tabs[0].url);
          }).catch(() => {});
          break;

        case 'WHITELIST_RESPONSE':
        case 'WHITELIST_UPDATE':
          // Incoming from Electron (authoritative source) — replace local state
          whitelist = (message.data || []).filter(e => e.expiresAt > Date.now());
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
    const durationMs = message.durationMs || WHITELIST_DURATION_MS;
    const entry = {
      pattern: message.pattern,
      type: message.patternType,
      expiresAt: Date.now() + durationMs
    };
    whitelist = pruneWhitelist().filter(e => e.pattern !== message.pattern);
    whitelist.push(entry);
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

    for (const pattern of blocklist) {
      try {
        let matched = false;
        const matchedPattern = pattern;

        if (url.includes(pattern)) matched = true;

        if (!matched && (pattern.includes('.*') || pattern.includes('\\'))) {
          try { if (new RegExp(pattern, 'i').test(url)) matched = true; } catch (e) {}
        }

        if (!matched) {
          try {
            const hostname = new URL(url).hostname;
            if (hostname === pattern ||
                hostname.endsWith('.' + pattern) ||
                pattern.startsWith('.') && hostname.endsWith(pattern)) matched = true;
          } catch (e) {}
        }

        if (matched) {
          log(`Blocking: ${url} (matched: ${pattern})`);
          const blockType = (pattern.includes('.*') || pattern.includes('\\')) ? 'regex' : 'domain';
          const blockPageUrl = browser.runtime.getURL('blocked.html') +
            `?url=${encodeURIComponent(url)}` +
            `&value=${encodeURIComponent(matchedPattern)}` +
            `&reason=${blockType}`;
          return { redirectUrl: blockPageUrl };
        }
      } catch (error) {
        log(`Error checking pattern ${pattern}: ${error.message}`);
      }
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
      } catch (e) { return false; }
    });
    if (matched) {
      log(`Active tab ${tab.url} matched expired whitelist entry — reloading`);
      browser.tabs.reload(tab.id);
    }
  });
}, 60 * 1000);

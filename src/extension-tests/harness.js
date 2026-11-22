// Test helpers for the browser extensions (not shipped: the extension folders
// are packaged whole, so their tests live here instead).
//
// The extension scripts are plain scripts, not modules. They are run in a
// fresh `vm` context with fake chrome.* / browser.* objects.
import vm from 'node:vm';
import process from 'node:process';
import { setImmediate } from 'node:timers';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// FB_CHROME_EXT_DIR / FB_FIREFOX_EXT_DIR point the tests at another copy of an
// extension (used to check that a test fails against the code before a fix).
export const CHROME_DIR = process.env.FB_CHROME_EXT_DIR || join(here, '..', 'extension-chrome');
export const FIREFOX_DIR = process.env.FB_FIREFOX_EXT_DIR || join(here, '..', 'extension');

/** Values made inside the vm have other prototypes; compare plain copies. */
export const plain = (value) => JSON.parse(JSON.stringify(value));

/** Lets queued promises and immediates run. */
export async function settle(rounds = 60) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Runs extension scripts in one fresh context and returns its global object. */
export function loadScripts(dir, files, globals = {}) {
  const sandbox = { URL, console: { log() {}, error() {}, warn() {} }, ...globals };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const file of files) {
    vm.runInContext(readFileSync(join(dir, file), 'utf8'), sandbox, { filename: join(dir, file) });
  }
  return sandbox;
}

export const loadMatching = (dir = CHROME_DIR) => loadScripts(dir, ['matching.js']).FocusBearMatching;
export const loadDnr = () => loadScripts(CHROME_DIR, ['matching.js', 'dnr.js']).FocusBearDnr;

const isAscii = (text) => /^[\x20-\x7E]*$/.test(text);

/**
 * A stand-in for chrome.declarativeNetRequest that refuses what Chrome
 * refuses: a whole update fails when one rule has a non-ASCII or unsupported
 * regex, when a rule id is used twice, or when there are too many regex rules.
 * Reads and writes take a tick, like the real (asynchronous) calls.
 */
export function createFakeDnr({ maxRegexRules = 1000, unsupported = () => false, failUpdates = () => false } = {}) {
  const rules = { dynamic: [], session: [] };
  const calls = [];
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  const update = (kind) => async ({ removeRuleIds = [], addRules = [] } = {}) => {
    await tick();
    calls.push({ kind, removeRuleIds: [...removeRuleIds], addRules: addRules.map((rule) => rule.id) });
    if (failUpdates({ kind, removeRuleIds, addRules })) throw new Error('Internal error.');
    const next = [...rules[kind].filter((rule) => !removeRuleIds.includes(rule.id)), ...addRules];
    const ids = new Set();
    for (const rule of next) {
      if (ids.has(rule.id)) throw new Error(`Rule with id ${rule.id} does not have a unique ID.`);
      ids.add(rule.id);
    }
    for (const rule of addRules) {
      const regex = rule.condition && rule.condition.regexFilter;
      if (regex !== undefined && (!isAscii(regex) || regex.length > 2000 || unsupported(regex))) {
        throw new Error(`Rule with id ${rule.id} was refused: unsupported regexFilter.`);
      }
    }
    const all = [...rules.dynamic, ...rules.session].filter((rule) => !rules[kind].includes(rule)).length + next.length;
    if (all > maxRegexRules) throw new Error('Too many regex rules.');
    rules[kind] = next.map((rule) => JSON.parse(JSON.stringify(rule)));
  };

  return {
    rules,
    calls,
    async getDynamicRules() { await tick(); return [...rules.dynamic]; },
    async getSessionRules() { await tick(); return [...rules.session]; },
    updateDynamicRules: update('dynamic'),
    updateSessionRules: update('session'),
    async isRegexSupported({ regex }) {
      if (!isAscii(regex) || regex.length > 2000 || unsupported(regex)) return { isSupported: false, reason: 'syntaxError' };
      return { isSupported: true };
    },
  };
}

const event = () => {
  const listeners = [];
  return { listeners, addListener: (listener) => listeners.push(listener) };
};

function fakePort(sent) {
  const port = {
    onMessage: event(),
    onDisconnect: event(),
    postMessage: (message) => sent.push(JSON.parse(JSON.stringify(message))),
    /** A message from the native host. */
    deliver(message) {
      for (const listener of port.onMessage.listeners) listener(message);
    },
  };
  return port;
}

function fakeStorage(stored) {
  return {
    stored,
    async get(keys) {
      const out = {};
      for (const key of [].concat(keys)) if (key in stored) out[key] = stored[key];
      return out;
    },
    async set(values) {
      Object.assign(stored, JSON.parse(JSON.stringify(values)));
    },
  };
}

function fakeTabs(tabs) {
  const updates = [];
  const matching = (filter = {}) => tabs.filter((tab) =>
    (filter.active === undefined || tab.active === filter.active) &&
    (filter.currentWindow === undefined || (tab.windowId === 1) === filter.currentWindow));
  return {
    updates,
    onActivated: event(),
    query(filter, callback) {
      const found = matching(filter);
      if (typeof callback === 'function') { callback(found); return undefined; }
      return Promise.resolve(found);
    },
    async get(id) { return tabs.find((tab) => tab.id === id); },
    async update(id, change) {
      updates.push({ id, url: change.url });
      const tab = tabs.find((candidate) => candidate.id === id);
      if (tab) tab.url = change.url;
    },
    async reload() {},
  };
}

/**
 * Loads the Chrome service worker (background.js) with a fake chrome.*.
 * Returns { port, dnr, tabs, storage, sent, alarm(name), message(msg) }.
 * `clock.aheadMs` can be changed while it runs.
 */
export async function startChromeBackground({ stored = {}, tabs = [], dnr = createFakeDnr(), dir = CHROME_DIR, clock = { aheadMs: 0 } } = {}) {
  const sent = [];
  const ports = [];
  const fakeTabsApi = fakeTabs(tabs);
  const onAlarm = event();
  const onMessage = event();
  const chrome = {
    runtime: {
      getURL: (path) => 'chrome-extension://focusbear/' + path,
      connectNative: () => { const port = fakePort(sent); ports.push(port); return port; },
      onInstalled: event(),
      onStartup: event(),
      onMessage,
      lastError: null,
    },
    storage: { local: fakeStorage(stored) },
    tabs: fakeTabsApi,
    alarms: { create() {}, get: (name, callback) => callback(undefined), onAlarm },
    declarativeNetRequest: dnr,
  };
  const globals = {
    chrome,
    // `clock.aheadMs` moves the extension's clock forward (to let an allow list lapse).
    Date: class extends Date { static now() { return Date.now() + clock.aheadMs; } },
    navigator: { userAgent: 'test', userAgentData: { brands: [{ brand: 'Chromium' }] } },
    setTimeout,
    clearTimeout,
  };
  globals.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(readFileSync(join(dir, file), 'utf8'), sandbox, { filename: join(dir, file) });
    }
  };
  const sandbox = loadScripts(dir, [], globals);
  vm.runInContext(readFileSync(join(dir, 'background.js'), 'utf8'), sandbox, { filename: join(dir, 'background.js') });
  await settle();
  return {
    get port() { return ports[ports.length - 1]; },
    dnr,
    tabs: fakeTabsApi,
    storage: chrome.storage.local,
    sent,
    async alarm(name) {
      for (const listener of onAlarm.listeners) await listener({ name });
      await settle();
    },
    /** A message from the popup or the block page; resolves with the answer. */
    message(msg) {
      return new Promise((resolve) => {
        for (const listener of onMessage.listeners) listener(msg, {}, resolve);
      });
    },
  };
}

/**
 * Loads the Firefox background scripts listed in its manifest with a fake
 * browser.*. Returns { port, tabs, storage, sent, request(details), message(msg) }.
 */
export async function startFirefoxBackground({ stored = {}, tabs = [], dir = FIREFOX_DIR } = {}) {
  const sent = [];
  const ports = [];
  const fakeTabsApi = fakeTabs(tabs);
  const onBeforeRequest = event();
  const onMessage = event();
  const browser = {
    runtime: {
      getURL: (path) => 'moz-extension://focusbear/' + path,
      getBrowserInfo: async () => ({ name: 'Firefox' }),
      connectNative: () => { const port = fakePort(sent); ports.push(port); return port; },
      onMessage,
      lastError: null,
    },
    storage: { local: fakeStorage(stored) },
    tabs: fakeTabsApi,
    webRequest: { onBeforeRequest },
  };
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  // Timers are swallowed: the background sets intervals that would keep the test alive.
  loadScripts(dir, manifest.background.scripts, {
    browser,
    navigator: { userAgent: 'test' },
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout() {},
  });
  await settle();
  return {
    get port() { return ports[ports.length - 1]; },
    tabs: fakeTabsApi,
    storage: browser.storage.local,
    sent,
    /** What the webRequest listener answers for a request. */
    request(details) {
      return onBeforeRequest.listeners[0]({ type: 'main_frame', ...details });
    },
    message(msg) {
      return new Promise((resolve) => {
        for (const listener of onMessage.listeners) listener(msg, {}, resolve);
      });
    },
  };
}

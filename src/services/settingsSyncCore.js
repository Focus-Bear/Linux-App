// The synced settings (block list, strictness, breaks, ...) and how they reach
// the account: GET / PUT /user-local-device-settings.
//
// The document on the server is shared with the Mac and Windows apps (they all
// read and write its `MacOS` object), and the server replaces each platform
// object it is sent. So this module follows four rules:
//
//   1. A load that failed is not "nothing on the server". Until a load has
//      succeeded the app shows the copy saved on this computer (or the
//      built-in defaults) and says "Not synced".
//   2. Nothing is written from a copy the app made up or read long ago. Every
//      save GETs the document first and writes into that fresh copy.
//   3. Only the keys the person changed here are written. A list (the block
//      list) is merged: what was added here is added, what was removed here
//      is removed, and entries another device added meanwhile stay.
//   4. Only `MacOS` is sent, so the phone's and the web's objects are never
//      touched.
//
// No React, no Electron and no `fetch` here: everything is passed in, so the
// load / save paths can be tested with fakes (settingsSyncCore.test.js).
import { fromDeviceSettings, parseDeviceSettings, toDeviceSettings } from './blocklist.js';

/** What the sidebar and Settings > Account show. */
export const SYNC = {
  LOADING: 'loading', // first load in progress
  SYNCING: 'syncing', // a save or a refresh is in progress
  SYNCED: 'synced', // loaded from the account, nothing waiting
  PENDING: 'pending', // loaded, but a change made here isn't on the account yet
  OFFLINE: 'offline', // never loaded: showing the copy saved on this computer
};

const RETRY_DELAYS_MS = [5000, 15000, 60000, 5 * 60000];

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Three-way merge of a list: `base` is what this app started from, `mine` is
 * the list after the edits made here, `theirs` is what the server has now.
 */
export function mergeList(base, mine, theirs) {
  const from = Array.isArray(base) ? base : [];
  const local = Array.isArray(mine) ? mine : [];
  const remote = Array.isArray(theirs) ? theirs : [];
  const removed = new Set(from.filter((entry) => !local.includes(entry)));
  const added = local.filter((entry) => !from.includes(entry));
  const merged = remote.filter((entry) => !removed.has(entry));
  for (const entry of added) if (!merged.includes(entry)) merged.push(entry);
  return merged;
}

/**
 * @param {object} options
 * @param {object} options.defaults     key -> built-in default
 * @param {(method: 'GET'|'PUT', body?: object) => Promise<{status: number, data: any}>} options.request
 *        Throws when the request could not be made (offline, signed out).
 * @param {() => Promise<object|null>} options.loadLocal   the copy in settings.json
 * @param {(patch: object) => Promise<any>} options.saveLocal
 * @param {() => string} options.getUserId
 * @param {(key: string, value: any) => void} [options.onApply]  a value is now in force (tell the main process)
 */
export function createSettingsSync({
  defaults,
  request,
  loadLocal = async () => null,
  saveLocal = async () => {},
  getUserId = () => '',
  onApply = () => {},
  saveDelayMs = 1000,
  retryDelaysMs = RETRY_DELAYS_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  log = console,
}) {
  let cache = new Map();
  const subscribers = new Map(); // key -> Set<callback>
  const statusListeners = new Set();

  let loaded = false; // a GET has succeeded for this account
  let document = null; // the last document read from the server (null until then)
  // key -> the value this app started from before the first unsaved edit.
  let unsaved = new Map();
  let edits = new Map(); // key -> counter, to notice an edit made during a save
  let busy = 0; // requests in flight
  let initPromise = null;
  let saving = null;
  let saveTimer = null;
  let retryTimer = null;
  let retryCount = 0;
  let generation = 0; // bumped by reset(), so a late answer for the last account is dropped
  let lastStatus = null;

  const valueOf = (key) => (cache.has(key) ? cache.get(key) : defaults[key]);

  function status() {
    if (!initPromise) return SYNC.LOADING;
    if (busy > 0) return loaded || unsaved.size > 0 ? SYNC.SYNCING : SYNC.LOADING;
    if (!loaded) return SYNC.OFFLINE;
    return unsaved.size > 0 ? SYNC.PENDING : SYNC.SYNCED;
  }

  function statusChanged() {
    const next = status();
    if (next === lastStatus) return;
    lastStatus = next;
    statusListeners.forEach((listener) => listener(next));
  }

  async function tracked(work) {
    busy += 1;
    statusChanged();
    try {
      return await work();
    } finally {
      busy -= 1;
      statusChanged();
    }
  }

  function put(key, value, { apply = true } = {}) {
    const changed = !sameValue(valueOf(key), value) || !cache.has(key);
    cache.set(key, value);
    if (!changed) return;
    subscribers.get(key)?.forEach((callback) => callback(value));
    if (apply) onApply(key, value);
  }

  /** GET the document. Throws unless the server answered (404 = nothing saved yet). */
  async function fetchDocument() {
    const response = await request('GET');
    if (response.status === 404) return {};
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(`Settings could not be read (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return response.data && typeof response.data === 'object' && !Array.isArray(response.data) ? response.data : {};
  }

  /** Takes the server's values for every key that has no unsaved edit here. */
  function adopt(doc) {
    document = doc;
    loaded = true;
    const mapped = fromDeviceSettings(parseDeviceSettings(doc.MacOS));
    for (const key of Object.keys(defaults)) {
      if (unsaved.has(key)) continue;
      put(key, key in mapped ? mapped[key] : defaults[key]);
    }
  }

  function persistLocal() {
    const copy = {};
    // Only values that came from the account, the saved copy or the person:
    // a built-in default is never written down as if it were the account's.
    for (const key of Object.keys(defaults)) if (cache.has(key)) copy[key] = cache.get(key);
    copy.settingsOwner = getUserId() || '';
    // What still has to reach the account, with the value each edit started
    // from, so a change made offline survives a restart.
    copy.unsyncedSettings = Object.fromEntries(unsaved);
    return Promise.resolve()
      .then(() => saveLocal(copy))
      .catch((error) => log.error('[Sync] Could not save the local copy:', error?.message || error));
  }

  /** The copy saved on this computer, when it belongs to the signed-in account. */
  async function useLocalCopy() {
    let local = null;
    try {
      local = await loadLocal();
    } catch {
      local = null;
    }
    if (!local || typeof local !== 'object') return false;
    // Files written before the owner was recorded are taken as this account's.
    if (local.settingsOwner !== undefined && local.settingsOwner !== (getUserId() || '')) return false;
    let found = false;
    for (const key of Object.keys(defaults)) {
      if (local[key] === undefined || typeof local[key] !== typeof defaults[key]) continue;
      if (Array.isArray(defaults[key]) !== Array.isArray(local[key])) continue;
      found = true;
      put(key, local[key]);
    }
    const pending = local.unsyncedSettings;
    if (local.settingsOwner !== undefined && pending && typeof pending === 'object' && !Array.isArray(pending)) {
      for (const [key, base] of Object.entries(pending)) {
        if (key in defaults && !unsaved.has(key)) unsaved.set(key, base);
      }
    }
    return found;
  }

  function scheduleRetry() {
    if (retryTimer) return;
    const delay = retryDelaysMs[Math.min(retryCount, retryDelaysMs.length - 1)];
    retryCount += 1;
    retryTimer = setTimer(() => {
      retryTimer = null;
      api.retry();
    }, delay);
  }

  function stopRetry() {
    if (retryTimer) clearTimer(retryTimer);
    retryTimer = null;
    retryCount = 0;
  }

  /** One round: read the document, write the unsaved keys into it, send `MacOS`. */
  async function saveRound() {
    const mine = generation;
    const keys = [...unsaved.keys()];
    const seen = new Map(keys.map((key) => [key, edits.get(key) || 0]));
    const fresh = await fetchDocument();
    if (mine !== generation) return;
    const device = parseDeviceSettings(fresh.MacOS);
    const theirs = fromDeviceSettings(device);
    const changes = {};
    for (const key of keys) {
      const value = valueOf(key);
      changes[key] = Array.isArray(defaults[key])
        ? mergeList(unsaved.get(key), value, key in theirs ? theirs[key] : unsaved.get(key))
        : value;
    }
    const next = toDeviceSettings(device, changes);
    const response = await request('PUT', { MacOS: next });
    if (mine !== generation) return;
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(`Settings could not be saved (${response.status})`);
      error.status = response.status;
      throw error;
    }
    for (const key of keys) {
      if ((edits.get(key) || 0) !== seen.get(key)) {
        // Edited again while the save was on its way: the next round starts
        // from what the server now has.
        unsaved.set(key, changes[key]);
        continue;
      }
      unsaved.delete(key);
      put(key, changes[key]);
    }
    adopt({ ...fresh, MacOS: next });
  }

  function saveNow() {
    if (saving) return saving;
    const mine = generation;
    saving = tracked(async () => {
      try {
        let rounds = 0;
        while (unsaved.size > 0 && mine === generation && rounds < 5) {
          rounds += 1;
          await saveRound();
        }
        if (mine === generation) stopRetry();
      } catch (error) {
        if (mine === generation) {
          log.error('[Sync] Settings not saved to the account yet:', error?.message || error);
          scheduleRetry();
        }
        throw error;
      } finally {
        saving = null;
        if (mine === generation) await persistLocal();
      }
    });
    return saving;
  }

  const api = {
    /** Loads the account's settings once. Never throws: see status(). */
    initialize() {
      if (initPromise) return initPromise;
      const mine = generation;
      initPromise = tracked(async () => {
        try {
          const doc = await fetchDocument();
          if (mine !== generation) return;
          // Edits made offline before the last quit are still waiting.
          await useLocalCopyPendingOnly();
          adopt(doc);
          await persistLocal();
        } catch (error) {
          if (mine !== generation) return;
          log.error('[Sync] Settings could not be loaded; using the copy on this computer:', error?.message || error);
          await useLocalCopy();
          scheduleRetry();
        }
      }).then(() => {
        if (mine === generation && loaded && unsaved.size > 0) saveNow().catch(() => {});
      });
      statusChanged();
      return initPromise;
    },

    getValue: (key) => valueOf(key),

    /** A change made by the person here: in force at once, saved to the account shortly after. */
    async setValue(key, value) {
      if (!(key in defaults)) throw new Error(`Unknown synced state: ${key}`);
      if (!unsaved.has(key)) unsaved.set(key, valueOf(key));
      edits.set(key, (edits.get(key) || 0) + 1);
      put(key, value);
      statusChanged();
      persistLocal();
      if (saveTimer) clearTimer(saveTimer);
      saveTimer = setTimer(() => {
        saveTimer = null;
        api.retry();
      }, saveDelayMs);
    },

    /** Saves what is waiting now; rejects when it could not be saved. */
    async flush() {
      if (saveTimer) clearTimer(saveTimer);
      saveTimer = null;
      if (saving) await saving.catch(() => {});
      if (unsaved.size > 0) await saveNow();
    },

    /** Tries again: the load when it never succeeded, then whatever is waiting. */
    async retry() {
      if (!initPromise) return api.initialize();
      await initPromise;
      try {
        if (!loaded) await api.forceSync();
        else if (unsaved.size > 0) await saveNow();
      } catch {
        /* reported through status(); the next retry is already scheduled */
      }
    },

    /** Reads the account's settings again. Rejects when they could not be read. */
    async forceSync() {
      const mine = generation;
      await tracked(async () => {
        try {
          const doc = await fetchDocument();
          if (mine !== generation) return;
          adopt(doc);
          await persistLocal();
        } catch (error) {
          if (mine === generation) scheduleRetry();
          throw error;
        }
      });
      if (mine === generation && unsaved.size > 0) await saveNow();
      else if (mine === generation) stopRetry();
    },

    subscribe(key, callback) {
      if (!subscribers.has(key)) subscribers.set(key, new Set());
      subscribers.get(key).add(callback);
      return () => subscribers.get(key)?.delete(callback);
    },

    getAllSettings() {
      const result = {};
      for (const key of Object.keys(defaults)) result[key] = valueOf(key);
      return result;
    },

    status,
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    /** True once the account's settings were read from the server. */
    hasLoaded: () => loaded,
    /** The document as last read from the server, or null when it never was. */
    getDocument: () => document,
    /** Keys changed here that are not on the account yet. */
    unsavedKeys: () => [...unsaved.keys()],

    /** Sign-out: forget everything about the account (nothing more is sent for it). */
    reset() {
      generation += 1;
      if (saveTimer) clearTimer(saveTimer);
      saveTimer = null;
      stopRetry();
      cache = new Map();
      unsaved = new Map();
      edits = new Map();
      loaded = false;
      document = null;
      initPromise = null;
      saving = null;
      statusChanged();
    },
  };

  // After a successful load only the waiting edits are taken from the local
  // copy (their values and what they started from); everything else is the server's.
  async function useLocalCopyPendingOnly() {
    let local = null;
    try {
      local = await loadLocal();
    } catch {
      local = null;
    }
    if (!local || typeof local !== 'object') return;
    if (local.settingsOwner !== (getUserId() || '')) return;
    const pending = local.unsyncedSettings;
    if (!pending || typeof pending !== 'object' || Array.isArray(pending)) return;
    for (const [key, base] of Object.entries(pending)) {
      if (!(key in defaults) || unsaved.has(key) || local[key] === undefined) continue;
      if (Array.isArray(defaults[key]) !== Array.isArray(local[key])) continue;
      unsaved.set(key, base);
      put(key, local[key]);
    }
  }

  return api;
}

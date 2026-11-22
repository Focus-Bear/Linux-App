// The account's block lists and blocking schedules as the window holds them.
// The store itself (no React, no fetch: the API is passed in), so loading and
// saving can be tested with a fake API (blockingStoreCore.test.js).
//
// Saving a list: the edit shows at once; shortly after, the list is read from
// the account again, the edit is applied to that fresh copy and only that
// list is sent (blockingApiCore.js `updateList`). The window's copy can be
// 15 minutes old, so it is never what gets written.
import { LIST_LOCKED, SCHEDULE_LOCKED, withEntries, withKind, withName } from '../electron/blockingModel.js';

export const SAVE_FAILED = "Couldn't save that. Check your connection and try again.";
export const LIST_GONE = 'That block list was deleted on another device.';

export function createBlockingStore({
  api,
  // () => { scheduleIds: Set, listIds: Set }: what strict blocking in force
  // forbids changing right now (blockingModel.js `blockingLocks`).
  getLocks = () => ({ scheduleIds: new Set(), listIds: new Set() }),
  saveDelayMs = 600,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  log = console,
}) {
  let state = {
    status: 'loading', // loading | ready | error
    modes: [],
    schedules: [],
    error: null, // the last save that failed, in words
    stale: false, // the last reload failed: this is an older copy
  };
  const listeners = new Set();
  let loading = null;
  let saveTimer = null;
  let saving = Promise.resolve();
  // id -> the edits made here that the account doesn't have yet, in order.
  const pending = new Map();
  let generation = 0;
  let locks = getLocks;

  const listLocked = (id) => {
    if (!locks().listIds.has(id)) return false;
    set({ error: LIST_LOCKED });
    return true;
  };
  const scheduleLocked = (id) => {
    if (!locks().scheduleIds.has(id)) return false;
    set({ error: SCHEDULE_LOCKED });
    return true;
  };

  function set(patch) {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  }

  /** The lists as the account has them, with the edits still waiting here applied on top. */
  const withPending = (modes) =>
    modes.map((mode) => {
      const changes = mode && pending.get(mode.id);
      return changes ? changes.reduce((current, change) => change(current), mode) : mode;
    });

  async function saveList(id) {
    const changes = pending.get(id);
    if (!changes || changes.length === 0) return;
    const count = changes.length;
    const mine = generation;
    try {
      const { modes } = await api.updateList(id, (fresh) => changes.slice(0, count).reduce((current, change) => change(current), fresh));
      if (mine !== generation) return;
      // Edits made while this save was on its way stay queued for the next one.
      const rest = (pending.get(id) || []).slice(count);
      if (rest.length > 0) pending.set(id, rest);
      else pending.delete(id);
      set({ modes: withPending(modes), stale: false });
      if (rest.length > 0) queueSave();
    } catch (error) {
      if (mine !== generation) return;
      log.error('[Blocking] Could not save the block list:', error?.message || error);
      pending.delete(id);
      set({ error: error?.name === 'ListGoneError' ? LIST_GONE : SAVE_FAILED });
      await store.load();
    }
  }

  function queueSave() {
    if (saveTimer) clearTimer(saveTimer);
    saveTimer = setTimer(() => {
      saveTimer = null;
      // One save at a time, each list by itself.
      saving = saving.then(async () => {
        for (const id of [...pending.keys()]) await saveList(id);
      });
    }, saveDelayMs);
  }

  function replaceMode(id, change) {
    if (listLocked(id)) return;
    pending.set(id, [...(pending.get(id) || []), change]);
    set({ modes: state.modes.map((mode) => (mode && mode.id === id ? change(mode) : mode)), error: null });
    queueSave();
  }

  const store = {
    load() {
      if (loading) return loading;
      const mine = generation;
      loading = (async () => {
        try {
          const [modes, schedules] = await Promise.all([api.getLists(), api.getSchedules()]);
          if (mine !== generation) return;
          // A reload that lands while an edit is waiting must not undo it on screen.
          set({ status: 'ready', modes: withPending(modes), schedules, stale: false });
        } catch (error) {
          if (mine !== generation) return;
          log.error('[Blocking] Could not load block lists and schedules:', error?.message || error);
          set(state.status === 'ready' ? { stale: true } : { status: 'error' });
        } finally {
          loading = null;
        }
      })();
      return loading;
    },

    /** Creates a list; returns it, or null when the server refused. */
    async createList(name, kind) {
      try {
        const created = await api.createList(name, kind);
        set({ modes: [...state.modes, created], error: null });
        return created;
      } catch (error) {
        log.error('[Blocking] Could not create the block list:', error?.message || error);
        set({ error: SAVE_FAILED });
        return null;
      }
    },

    renameList: (id, name) => replaceMode(id, (mode) => withName(mode, name)),
    setListEntries: (id, entries) => replaceMode(id, (mode) => withEntries(mode, entries)),
    /** Adds and removes websites; unlike setListEntries, entries another device added meanwhile are kept. */
    editListEntries: (id, { add = [], remove = [] }) =>
      replaceMode(id, (mode) => {
        const kind = mode?.metadata?.isAllowedListApproach === true ? 'allow' : 'block';
        const current = kind === 'allow' ? mode.allowed_urls || [] : mode?.metadata?.blockUrlsArray || [];
        const gone = new Set(remove);
        return withEntries(mode, [...current.filter((entry) => !gone.has(entry)), ...add]);
      }),
    setListKind: (id, kind) => replaceMode(id, (mode) => withKind(mode, kind)),

    /** Deletes a list; it is put back if the server refuses. */
    async deleteList(id) {
      if (listLocked(id)) return false;
      const before = state.modes;
      pending.delete(id);
      set({ modes: before.filter((mode) => mode.id !== id), error: null });
      try {
        await api.deleteList(id);
        return true;
      } catch (error) {
        log.error('[Blocking] Could not delete the block list:', error?.message || error);
        set({ modes: before, error: "Couldn't delete that block list. Check your connection and try again." });
        return false;
      }
    },

    /** Creates or updates a schedule; false when the server refused. */
    async saveSchedule(draft, existing = null) {
      if (existing && scheduleLocked(existing.id)) return false;
      try {
        const saved = await api.saveSchedule(draft, existing);
        set({
          schedules: existing
            ? state.schedules.map((schedule) => (schedule.id === existing.id ? saved : schedule))
            : [...state.schedules, saved],
          error: null,
        });
        return true;
      } catch (error) {
        log.error('[Blocking] Could not save the schedule:', error?.message || error);
        return false;
      }
    },

    async deleteSchedule(id) {
      if (scheduleLocked(id)) return false;
      const before = state.schedules;
      set({ schedules: before.filter((schedule) => schedule.id !== id), error: null });
      try {
        await api.deleteSchedule(id);
        return true;
      } catch (error) {
        log.error('[Blocking] Could not delete the schedule:', error?.message || error);
        set({ schedules: before, error: "Couldn't delete that schedule. Check your connection and try again." });
        return false;
      }
    },

    /** Resolves when every queued save has been sent (for tests and for leaving a page). */
    async settled() {
      if (saveTimer) {
        clearTimer(saveTimer);
        saveTimer = null;
        saving = saving.then(async () => {
          for (const id of [...pending.keys()]) await saveList(id);
        });
      }
      await saving;
    },

    /** Sign-out: forget the account's lists; nothing queued is sent. */
    reset() {
      generation += 1;
      if (saveTimer) clearTimer(saveTimer);
      saveTimer = null;
      pending.clear();
      loading = null;
      set({ status: 'loading', modes: [], schedules: [], error: null, stale: false });
    },

    /** The shell passes the current locks in (it knows the session and the time). */
    setLocks(next) {
      locks = typeof next === 'function' ? next : getLocks;
    },

    clearError: () => set({ error: null }),
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return store;
}

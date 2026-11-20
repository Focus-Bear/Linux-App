// The account's block lists and blocking schedules in the window, shared by
// the Blocking pages, the focus start screen and the shell (which tells the
// main process what to block; see src/ui/useBlocking.js).
import { useSyncExternalStore } from 'react';
import { habitApi } from './habitApi.js';
import { createBlockingApi } from './blockingApiCore.js';
import { withEntries, withKind, withName } from '../electron/blockingModel.js';

export const blockingApi = createBlockingApi({
  request: (...args) => habitApi.request(...args),
  getDeviceId: () => habitApi.registerDevice(),
});

let state = {
  status: 'loading', // loading | ready | error
  modes: [],
  schedules: [],
  error: null, // the last save that failed, in words
};
const listeners = new Set();
let loading = null;
let saveTimer = null;

function set(patch) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

const SAVE_FAILED = "Couldn't save that. Check your connection and try again.";

/** Sends every list to the account shortly after the last edit. */
function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    blockingApi.saveLists(state.modes).catch((error) => {
      console.error('[Blocking] Could not save the block lists:', error);
      set({ error: SAVE_FAILED });
      blockingStore.load();
    });
  }, 600);
}

function replaceMode(id, change) {
  set({ modes: state.modes.map((mode) => (mode.id === id ? change(mode) : mode)), error: null });
  queueSave();
}

export const blockingStore = {
  load() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const [modes, schedules] = await Promise.all([blockingApi.getLists(), blockingApi.getSchedules()]);
        set({ status: 'ready', modes, schedules });
      } catch (error) {
        console.error('[Blocking] Could not load block lists and schedules:', error);
        set({ status: state.status === 'ready' ? 'ready' : 'error' });
      } finally {
        loading = null;
      }
    })();
    return loading;
  },

  /** Creates a list; returns it, or null when the server refused. */
  async createList(name, kind) {
    try {
      const created = await blockingApi.createList(name, kind);
      set({ modes: [...state.modes, created], error: null });
      return created;
    } catch (error) {
      console.error('[Blocking] Could not create the block list:', error);
      set({ error: SAVE_FAILED });
      return null;
    }
  },

  renameList: (id, name) => replaceMode(id, (mode) => withName(mode, name)),
  setListEntries: (id, entries) => replaceMode(id, (mode) => withEntries(mode, entries)),
  setListKind: (id, kind) => replaceMode(id, (mode) => withKind(mode, kind)),

  /** Deletes a list; it is put back if the server refuses. */
  async deleteList(id) {
    const before = state.modes;
    set({ modes: before.filter((mode) => mode.id !== id), error: null });
    try {
      await blockingApi.deleteList(id);
      return true;
    } catch (error) {
      console.error('[Blocking] Could not delete the block list:', error);
      set({ modes: before, error: "Couldn't delete that block list. Check your connection and try again." });
      return false;
    }
  },

  /** Creates or updates a schedule; false when the server refused. */
  async saveSchedule(draft, existing = null) {
    try {
      const saved = await blockingApi.saveSchedule(draft, existing);
      set({
        schedules: existing
          ? state.schedules.map((schedule) => (schedule.id === existing.id ? saved : schedule))
          : [...state.schedules, saved],
        error: null,
      });
      return true;
    } catch (error) {
      console.error('[Blocking] Could not save the schedule:', error);
      return false;
    }
  },

  async deleteSchedule(id) {
    const before = state.schedules;
    set({ schedules: before.filter((schedule) => schedule.id !== id), error: null });
    try {
      await blockingApi.deleteSchedule(id);
      return true;
    } catch (error) {
      console.error('[Blocking] Could not delete the schedule:', error);
      set({ schedules: before, error: "Couldn't delete that schedule. Check your connection and try again." });
      return false;
    }
  },

  clearError: () => set({ error: null }),
  get: () => state,
};

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** { status, modes, schedules, error } */
export function useBlockingStore() {
  return useSyncExternalStore(subscribe, blockingStore.get);
}

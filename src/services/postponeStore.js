// A postponed routine: which one and until when. Kept on this computer only,
// as on Windows (HABITSPOSTPONEENDTIME in the registry); there is no API for it.
// When the time comes the shell opens the Day Plan and shows a notification
// (see useRoutinePostpone in src/ui/preferences.jsx).
import { useSyncExternalStore } from 'react';
import { POSTPONE_KEY, postponeEntry, readPostpone } from './dayPlanExtras.js';

const listeners = new Set();
let entry = null;
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    entry = readPostpone(window.localStorage.getItem(POSTPONE_KEY), Date.now());
  } catch {
    entry = null;
  }
}

function save(next) {
  entry = next;
  try {
    if (next) window.localStorage.setItem(POSTPONE_KEY, JSON.stringify(next));
    else window.localStorage.removeItem(POSTPONE_KEY);
  } catch {
    // kept until the app closes
  }
  listeners.forEach((listener) => listener());
}

export const postponeStore = {
  get() {
    load();
    return entry;
  },
  postpone: (card, minutes) => save(postponeEntry(card, minutes, Date.now())),
  clear: () => save(null),
};

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The postponed routine ({ cardId, title, day, until }) or null. */
export function usePostpone() {
  return useSyncExternalStore(subscribe, postponeStore.get);
}

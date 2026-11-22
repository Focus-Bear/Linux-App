// Postponed routines: which ones and until when. Kept on this computer only,
// as on Windows (HABITSPOSTPONEENDTIME in the registry); there is no API for it.
// When the time comes the shell opens the Day Plan and shows a notification
// (see useRoutinePostpone in src/ui/preferences.jsx).
import { useSyncExternalStore } from 'react';
import { POSTPONE_KEY, nextPostponed, postponeEntry, readPostponed } from './dayPlanExtras.js';

const listeners = new Set();
let entries = {}; // { cardId: { cardId, title, day, until } }
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    entries = readPostponed(window.localStorage.getItem(POSTPONE_KEY), Date.now());
  } catch {
    entries = {};
  }
}

function save(next) {
  entries = next;
  try {
    if (Object.keys(next).length > 0) window.localStorage.setItem(POSTPONE_KEY, JSON.stringify(next));
    else window.localStorage.removeItem(POSTPONE_KEY);
  } catch {
    // kept until the app closes
  }
  listeners.forEach((listener) => listener());
}

export const postponeStore = {
  /** The postponed routine whose reminder comes first, or null. */
  get() {
    load();
    return nextPostponed(entries);
  },
  /** Every postponed routine, by card id. */
  getAll() {
    load();
    return entries;
  },
  postpone(card, minutes) {
    load();
    save({ ...entries, [card.id]: postponeEntry(card, minutes, Date.now()) });
  },
  /** Forgets one routine's postponement; without an id, the one `get()` returns. */
  clear(cardId = null) {
    load();
    const id = cardId ?? nextPostponed(entries)?.cardId;
    if (!id || !(id in entries)) return;
    const rest = { ...entries };
    delete rest[id];
    save(rest);
  },
};

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The postponed routines by card id: { [cardId]: { cardId, title, day, until } }. */
export function usePostpone() {
  return useSyncExternalStore(subscribe, postponeStore.getAll);
}

// The habit player bound to the signed-in user's habit API (see
// habitPlayerCore.js for what it does).
import { useSyncExternalStore } from 'react';
import { habitApi } from './habitApi.js';
import { createHabitPlayerStore } from './habitPlayerCore.js';

const store = createHabitPlayerStore({ api: habitApi });

export const habitPlayer = store.habitPlayer;
export const reportHabit = store.reportHabit;

/** { player, failed, version, outcomes, outcomesDay, asking } */
export function useHabitPlayer() {
  return useSyncExternalStore(store.subscribe, habitPlayer.get);
}

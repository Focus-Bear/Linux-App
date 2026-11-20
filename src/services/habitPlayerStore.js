// The routine being played, kept outside React so it survives moving between
// pages, plus the calls that report each habit to the account. The countdown's
// end is handled here (a timer on the habit's deadline), so a habit finishes on
// time even while another page is open.
import { useSyncExternalStore } from 'react';
import { habitApi } from './habitApi.js';
import { dayKey } from './dayPlanModel.js';
import {
  completionTiming,
  createPlayer,
  currentHabit,
  finishCurrent,
  isDue,
  isTimed,
  pausePlayer,
  remainingMs,
  resumePlayer,
  skipNext,
  startNext,
} from './habitPlayerModel.js';

let player = null;
let failed = []; // names of habits whose result couldn't be saved
let deadline = null;
// Bumped whenever a habit is reported, so the Day Plan reloads the day's progress.
let version = 0;
// What was reported today from this app ({ habitId: 'done' | 'skipped' }), shown
// on the Day Plan straight away. `outcomesDay` is the day they belong to.
let outcomes = {};
let outcomesDay = '';
let snapshot = { player, failed, version, outcomes, outcomesDay };
const listeners = new Set();

function publish() {
  snapshot = { player, failed, version, outcomes, outcomesDay };
  listeners.forEach((listener) => listener());
}

function schedule() {
  clearTimeout(deadline);
  deadline = null;
  if (!player || player.phase !== 'running' || player.pausedAt !== null) return;
  if (!isTimed(currentHabit(player))) return;
  deadline = setTimeout(() => {
    if (isDue(player, Date.now())) end('done');
    else schedule();
  }, remainingMs(player, Date.now()) + 30);
}

function set(next) {
  player = next;
  schedule();
  publish();
}

/**
 * Sends one habit's result to the account (`timing` null = skipped). A failure
 * is remembered for the page to show, and rethrown.
 */
export async function reportHabit(habit, timing) {
  const today = dayKey(new Date());
  if (outcomesDay !== today) {
    outcomes = {};
    outcomesDay = today;
  }
  const before = outcomes[habit.id];
  outcomes = { ...outcomes, [habit.id]: timing ? 'done' : 'skipped' };
  publish();
  try {
    if (timing) await habitApi.completeHabit(habit, timing);
    else await habitApi.skipHabit(habit);
  } catch (error) {
    console.error('[Habits] Could not save the habit:', error);
    failed = [...failed, habit.name];
    const rest = { ...outcomes };
    delete rest[habit.id];
    outcomes = before ? { ...rest, [habit.id]: before } : rest;
    throw error;
  } finally {
    version += 1;
    publish();
  }
}

function end(outcome) {
  if (!player || player.phase !== 'running') return;
  const now = Date.now();
  const habit = currentHabit(player);
  const timing = completionTiming(player, outcome, now);
  set(finishCurrent(player, outcome, now));
  reportHabit(habit, timing).catch(() => {});
}

export const habitPlayer = {
  /** Starts a Day Plan routine card, optionally at one habit. False when nothing is left to do. */
  start(card, startId = null) {
    const next = createPlayer({ card, startId, now: Date.now() });
    if (!next) return false;
    failed = [];
    set(next);
    return true;
  },
  pause: () => set(pausePlayer(player, Date.now())),
  resume: () => set(resumePlayer(player, Date.now())),
  /** 'done' | 'already-did' | 'skipped' for the habit that is playing. */
  end,
  next: () => set(startNext(player, Date.now())),
  skipNext() {
    if (!player || player.phase !== 'between') return;
    const habit = player.queue[player.index + 1];
    set(skipNext(player, Date.now()));
    reportHabit(habit, null).catch(() => {});
  },
  /** Leaves the player (back to the Day Plan). A habit that is still running is not reported. */
  close: () => set(null),
  clearFailed() {
    failed = [];
    publish();
  },
  get: () => snapshot,
};

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** { player, failed, version, outcomes, outcomesDay } */
export function useHabitPlayer() {
  return useSyncExternalStore(subscribe, habitPlayer.get);
}

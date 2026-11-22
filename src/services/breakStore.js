// Micro breaks in the window: the account's break settings, the plan for the
// next break and the break being played. Kept outside React so a break
// survives moving between pages. The break timer itself lives in the main
// process (see "Micro breaks" in src/electron/main.js); this module tells it
// the settings and plays the break when it is due.
//
// API calls, the same as the Windows app:
//   GET /user-settings                       break_activities, break_after_minutes
//   PUT /user-settings?device_id=            the whole document, with the new break_after_minutes
//   POST /completed-activity                 once per break habit played
import { useSyncExternalStore } from 'react';
import { habitApi } from './habitApi.js';
import {
  completionTiming,
  createPlayer,
  currentHabit,
  finishCurrent,
  isDue,
  isTimed,
  remainingMs,
  startNext,
} from './habitPlayerModel.js';
import { blocksNextBreak, breakHabits, breakSeconds, clampBreakMinutes, planBreak } from '../electron/breakModel.js';

let state = {
  status: 'loading', // loading | ready | error
  habits: [],
  minutes: clampBreakMinutes(undefined),
  startup: '',
  shutdown: '',
  lastRotatedId: null,
  plan: { play: [], rotatedId: null },
  player: null, // a habitPlayerModel player while a break is played
  rotatedId: null, // the rotating habit of the break being played
  due: false, // this break came from the timer (it may start by itself)
  failed: [],
  saving: false,
  saveError: null,
  nextAt: null, // from the main process
};
const listeners = new Set();
let deadline = null;
let loading = null;

function set(patch) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function replan(patch = {}) {
  const next = { ...state, ...patch };
  set({ ...patch, plan: planBreak(next.habits, next.lastRotatedId) });
}

function schedule() {
  clearTimeout(deadline);
  deadline = null;
  const player = state.player;
  if (!player || player.phase !== 'running' || !isTimed(currentHabit(player))) return;
  deadline = setTimeout(() => {
    if (isDue(state.player, Date.now())) finishHabit();
    else schedule();
  }, remainingMs(player, Date.now()) + 30);
}

/** The habit that is playing is done: report it and go straight on to the next one. */
function finishHabit() {
  const player = state.player;
  if (!player || player.phase !== 'running') return;
  const now = Date.now();
  const habit = currentHabit(player);
  const timing = completionTiming(player, 'done', now);
  let next = finishCurrent(player, 'done', now);
  if (next.phase === 'between') next = startNext(next, now);
  set({ player: next });
  schedule();
  habitApi.completeHabit(habit, timing).catch((error) => {
    console.error('[Breaks] Could not save the break habit:', error);
    set({ failed: [...state.failed, habit.name] });
  });
  if (next.phase === 'finished') breakTaken();
}

/** The break was taken: the rotating habit has had its turn, and the next break is a full interval away. */
function breakTaken() {
  const rotatedId = state.rotatedId;
  if (rotatedId) {
    replan({ lastRotatedId: rotatedId });
    window.api?.saveSettings?.({ lastRotatedBreakActivityId: rotatedId }).catch(() => {});
  }
  window.api?.breaks?.finished?.();
}

export const breakStore = {
  /** Reads the account's break settings (again). */
  load() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const [settings, local] = await Promise.all([
          habitApi.request('GET', '/user-settings'),
          window.api?.getLocalSettings?.().catch(() => null),
        ]);
        replan({
          status: 'ready',
          habits: breakHabits(settings),
          minutes: clampBreakMinutes(settings?.break_after_minutes),
          startup: settings?.startup_time || '',
          shutdown: settings?.shutdown_time || '',
          lastRotatedId: local?.lastRotatedBreakActivityId || null,
        });
      } catch (error) {
        console.error('[Breaks] Could not load the break settings:', error);
        set({ status: state.status === 'ready' ? 'ready' : 'error' });
      } finally {
        loading = null;
      }
    })();
    return loading;
  },

  /**
   * Saves the break frequency to the account. Like the Windows app, it reads
   * the settings again and sends the whole document back with only
   * break_after_minutes changed.
   */
  async saveMinutes(value) {
    const minutes = clampBreakMinutes(value);
    const before = state.minutes;
    set({ minutes, saving: true, saveError: null });
    try {
      const settings = await habitApi.request('GET', '/user-settings');
      if (!settings || typeof settings !== 'object') throw new Error('No settings');
      const deviceId = await habitApi.registerDevice();
      await habitApi.request('PUT', `/user-settings?device_id=${encodeURIComponent(deviceId)}`, {
        ...settings,
        break_after_minutes: minutes,
      });
      set({ saving: false });
    } catch (error) {
      console.error('[Breaks] Could not save the break frequency:', error);
      set({ minutes: before, saving: false, saveError: "Couldn't save that. Check your connection and try again." });
    }
  },

  /**
   * The timer says a break is due (the reminder ran out or "Start micro break
   * now"). A finished break still on screen ("Nice break", never closed with
   * "Back to Day Plan") gives way: it used to stay, so the next break opened
   * on the old finished screen with no way to start.
   */
  markDue() {
    if (blocksNextBreak(state.player)) return;
    set({ player: null, rotatedId: null, due: true });
  },

  /** The page was opened: a finished break from earlier is not shown again. */
  dismissFinished() {
    if (state.player && !blocksNextBreak(state.player)) set({ player: null, rotatedId: null });
  },

  /** Starts the planned break. False when there is nothing to play. */
  start() {
    if (state.player && state.player.phase !== 'finished') return true;
    const { play, rotatedId } = state.plan;
    const player = createPlayer({
      card: { id: 'break', kind: 'break', title: 'Micro break', habits: play },
      now: Date.now(),
    });
    if (!player) return false;
    set({ player, rotatedId, due: false, failed: [] });
    schedule();
    return true;
  },

  /** "I'm done" on a break habit without a timer. */
  done: finishHabit,

  /** Stops the break before its end. Habits already played stay recorded; the turn is not used up. */
  endEarly() {
    clearTimeout(deadline);
    set({ player: null, rotatedId: null, due: false });
    window.api?.breaks?.finished?.();
  },

  /** "Skip this break" on the start screen: the next break is a full interval away. */
  skip() {
    set({ due: false });
    window.api?.breaks?.finished?.();
  },

  /** Leaves the finished screen. */
  close() {
    set({ player: null, rotatedId: null, due: false });
  },

  setNextAt(nextAt) {
    if (nextAt !== state.nextAt) set({ nextAt: nextAt || null });
  },

  get: () => state,
};

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useBreakStore() {
  return useSyncExternalStore(subscribe, breakStore.get);
}

/** What the main process needs for its timer (see normaliseBreakConfig). */
export function breakConfig(current, { enabled, playing }) {
  return {
    enabled: enabled && current.status === 'ready',
    minutes: current.minutes,
    habitCount: current.plan.play.length,
    seconds: breakSeconds(current.plan.play),
    startup: current.startup,
    shutdown: current.shutdown,
    playing,
  };
}

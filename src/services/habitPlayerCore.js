// The routine being played, kept outside React so it survives moving between
// pages, plus the calls that report each habit to the account. The countdown's
// end is handled here (a timer on the habit's deadline), so a habit finishes on
// time even while another page is open.
//
// The API, the clock and the timers are passed in, so this can be tested with
// fakes (habitPlayerCore.test.js). habitPlayerStore.js binds it to the app.
import { dayKey } from './dayPlanModel.js';
import {
  completionTiming,
  createPlayer,
  currentHabit,
  dropQueued,
  finishCurrent,
  isDue,
  isTimed,
  pausePlayer,
  remainingMs,
  resumePlayer,
  skipNext,
  startNext,
} from './habitPlayerModel.js';

export function createHabitPlayerStore({
  api,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  logError = (...args) => console.error(...args),
}) {
  let player = null;
  let failed = []; // names of habits whose result couldn't be saved
  let deadline = null;
  // Bumped whenever a habit is reported, so the Day Plan reloads the day's progress.
  let version = 0;
  // What was reported today from this app ({ habitId: 'done' | 'skipped' }), shown
  // on the Day Plan straight away. `outcomesDay` is the day they belong to.
  let outcomes = {};
  let outcomesDay = '';
  // True when a timed habit that asks a question ran out: the player asks before reporting it.
  let asking = false;
  let snapshot = { player, failed, version, outcomes, outcomesDay, asking };
  const listeners = new Set();

  function publish() {
    snapshot = { player, failed, version, outcomes, outcomesDay, asking };
    listeners.forEach((listener) => listener());
  }

  function schedule() {
    clearTimer(deadline);
    deadline = null;
    if (!player || player.phase !== 'running' || player.pausedAt !== null) return;
    if (!isTimed(currentHabit(player))) return;
    deadline = setTimer(() => {
      if (!isDue(player, now())) schedule();
      else if (currentHabit(player)?.questions?.length > 0) {
        // Log quantity: wait for the answer (see habit-player.jsx).
        asking = true;
        publish();
      } else end('done');
    }, remainingMs(player, now()) + 30);
  }

  function set(next) {
    player = next;
    asking = false;
    schedule();
    publish();
  }

  /**
   * Sends one habit's result to the account (`timing` null = skipped). A failure
   * is remembered for the page to show, and rethrown.
   *
   * Also called for Done / Skip on a Day Plan row. A habit reported that way
   * leaves the player's queue, so the player doesn't play it later and report
   * it a second time.
   */
  async function reportHabit(habit, timing) {
    const today = dayKey(new Date(now()));
    if (outcomesDay !== today) {
      outcomes = {};
      outcomesDay = today;
    }
    player = dropQueued(player, habit.id);
    const before = outcomes[habit.id];
    outcomes = { ...outcomes, [habit.id]: timing ? 'done' : 'skipped' };
    publish();
    try {
      if (timing) await api.completeHabit(habit, timing);
      else await api.skipHabit(habit);
    } catch (error) {
      logError('[Habits] Could not save the habit:', error);
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

  function end(outcome, answers = []) {
    if (!player || player.phase !== 'running') return;
    const at = now();
    const habit = currentHabit(player);
    let timing = completionTiming(player, outcome, at);
    if (timing && Array.isArray(answers) && answers.length > 0) timing = { ...timing, answers };
    set(finishCurrent(player, outcome, at));
    reportHabit(habit, timing).catch(() => {});
  }

  const habitPlayer = {
    /** Starts a Day Plan routine card, optionally at one habit. False when nothing is left to do. */
    start(card, startId = null) {
      const next = createPlayer({ card, startId, now: now() });
      if (!next) return false;
      failed = [];
      set(next);
      return true;
    },
    pause: () => set(pausePlayer(player, now())),
    resume: () => set(resumePlayer(player, now())),
    /** 'done' | 'already-did' | 'skipped' for the habit that is playing; `answers` are its log quantity answers. */
    end,
    next: () => set(startNext(player, now())),
    skipNext() {
      if (!player || player.phase !== 'between') return;
      const habit = player.queue[player.index + 1];
      set(skipNext(player, now()));
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

  return { habitPlayer, reportHabit, subscribe };
}

// Habit / routine player: plays the habits of a routine one after another,
// like the Windows habit player (Habits/HabitActivityOnGoing.xaml and
// HabitActivityFinished.xaml):
//
//   running  - a timed habit counts down and finishes by itself; a habit with
//              completion requirements has no timer and waits for "I'm done"
//   between  - "<habit> finished!" with a button that starts the next one
//   finished - the routine's last habit is done or skipped
//
// Pure functions (no React, no fetch, no timers); times are epoch milliseconds.
import { formatSpan } from './dayPlanModel.js';

/** A habit counts down unless it has completion requirements (then the person says when it's done). */
export function isTimed(habit) {
  return Boolean(habit) && !habit.requirements && habit.seconds > 0;
}

/** The habits still to do, starting at `startId` when given (earlier ones follow after it). */
export function playQueue(habits, startId = null) {
  const open = (Array.isArray(habits) ? habits : []).filter((habit) => habit && !habit.done && !habit.skipped);
  const at = startId ? open.findIndex((habit) => habit.id === startId) : -1;
  return at > 0 ? [...open.slice(at), ...open.slice(0, at)] : open;
}

/** Starts playing a Day Plan routine card. Null when it has nothing left to do. */
export function createPlayer({ card, startId = null, now }) {
  const queue = playQueue(card?.habits, startId);
  if (queue.length === 0) return null;
  return {
    routine: { id: card.id, kind: card.kind, title: card.title },
    queue,
    index: 0,
    phase: 'running',
    startedAt: now,
    pausedAt: null,
    pausedMs: 0,
    results: [],
  };
}

export function currentHabit(player) {
  return player ? player.queue[player.index] || null : null;
}

/** The habit that plays after the current one, or null on the last. */
export function nextHabit(player) {
  return player ? player.queue[player.index + 1] || null : null;
}

/**
 * The habit the Day Plan's "routine in progress" banner names: the one that is
 * playing, or between habits the one that comes next (the current one has just
 * finished). Null once the routine is over.
 */
export function bannerHabit(player) {
  if (!player || player.phase === 'finished') return null;
  return player.phase === 'between' ? nextHabit(player) : currentHabit(player);
}

/**
 * Takes a habit that is still waiting its turn out of the queue. Used when it
 * was marked Done or Skipped on its Day Plan row while the routine plays: the
 * queue is a snapshot taken at Start, and playing the habit later would report
 * it a second time. The habit that is playing (or just finished) stays.
 */
export function dropQueued(player, habitId) {
  if (!player || player.phase === 'finished') return player;
  const at = player.queue.findIndex((habit, index) => index > player.index && habit.id === habitId);
  if (at < 0) return player;
  const queue = player.queue.filter((_, index) => index !== at);
  // Between habits with nothing left to start, the routine is over.
  const over = player.phase === 'between' && !queue[player.index + 1];
  return { ...player, queue, phase: over ? 'finished' : player.phase };
}

export function isPaused(player) {
  return Boolean(player) && player.phase === 'running' && player.pausedAt !== null;
}

/** Milliseconds spent on the current habit, not counting pauses. */
export function elapsedMs(player, now) {
  if (!player || player.phase !== 'running') return 0;
  const until = player.pausedAt ?? now;
  return Math.max(0, until - player.startedAt - player.pausedMs);
}

/** Milliseconds left on the current habit's countdown (0 for a habit without a timer). */
export function remainingMs(player, now) {
  const habit = currentHabit(player);
  if (!player || player.phase !== 'running' || !isTimed(habit)) return 0;
  return Math.max(0, habit.seconds * 1000 - elapsedMs(player, now));
}

/** True when the running habit's countdown has reached zero. */
export function isDue(player, now) {
  const habit = currentHabit(player);
  return Boolean(player) && player.phase === 'running' && !isPaused(player) && isTimed(habit) && remainingMs(player, now) === 0;
}

/** 0..1 of the current habit's countdown. */
export function habitProgress(player, now) {
  const habit = currentHabit(player);
  if (!isTimed(habit) || player.phase !== 'running') return 0;
  return Math.min(1, elapsedMs(player, now) / (habit.seconds * 1000));
}

export function pausePlayer(player, now) {
  if (!player || player.phase !== 'running' || player.pausedAt !== null) return player;
  return { ...player, pausedAt: now };
}

export function resumePlayer(player, now) {
  if (!isPaused(player)) return player;
  return { ...player, pausedAt: null, pausedMs: player.pausedMs + Math.max(0, now - player.pausedAt) };
}

/**
 * What to send for the current habit when it ends as `outcome`:
 *   'done'        timed: the habit's length; untimed: the time spent on it
 *   'already-did' one second ("I already did it"), flagged in the body
 *   'skipped'     nothing is logged (null)
 */
export function completionTiming(player, outcome, now) {
  const habit = currentHabit(player);
  if (!habit || outcome === 'skipped') return null;
  if (outcome === 'already-did') return { startMs: now - 1000, finishMs: now, seconds: 1, alreadyDid: true };
  const seconds = isTimed(habit) ? habit.seconds : Math.max(1, Math.round(elapsedMs(player, now) / 1000));
  return { startMs: now - seconds * 1000, finishMs: now, seconds, alreadyDid: false };
}

/** Ends the current habit. Moves to 'between' when another habit follows, else to 'finished'. */
export function finishCurrent(player, outcome, now) {
  const habit = currentHabit(player);
  if (!player || player.phase !== 'running' || !habit) return player;
  const timing = completionTiming(player, outcome, now);
  const result = {
    id: habit.id,
    name: habit.name,
    icon: habit.icon,
    outcome: outcome === 'skipped' ? 'skipped' : 'done',
    seconds: outcome === 'done' ? timing.seconds : 0,
  };
  return {
    ...player,
    phase: nextHabit(player) ? 'between' : 'finished',
    pausedAt: null,
    pausedMs: 0,
    results: [...player.results, result],
  };
}

/** From the 'between' screen: starts the next habit. */
export function startNext(player, now) {
  if (!player || player.phase !== 'between') return player;
  return { ...player, index: player.index + 1, phase: 'running', startedAt: now, pausedAt: null, pausedMs: 0 };
}

/** From the 'between' screen: skips the next habit without starting it. */
export function skipNext(player, now) {
  if (!player || player.phase !== 'between') return player;
  return finishCurrent(startNext(player, now), 'skipped', now);
}

export function lastResult(player) {
  return player && player.results.length > 0 ? player.results[player.results.length - 1] : null;
}

/** Seconds of habits done so far and seconds still to go, and how many were done / skipped. */
export function playerTotals(player) {
  if (!player) return { doneSeconds: 0, leftSeconds: 0, done: 0, skipped: 0 };
  const doneSeconds = player.results.reduce((sum, result) => sum + result.seconds, 0);
  const from = player.phase === 'running' ? player.index : player.index + 1;
  const leftSeconds = player.queue.slice(from).reduce((sum, habit) => sum + habit.seconds, 0);
  return {
    doneSeconds,
    leftSeconds,
    done: player.results.filter((result) => result.outcome === 'done').length,
    skipped: player.results.filter((result) => result.outcome === 'skipped').length,
  };
}

// --- texts (the Windows strings) -------------------------------------------

/** "Stretch finished!✅" / "Stretch skipped!" */
export function finishedHeading(result) {
  if (!result) return '';
  return result.outcome === 'skipped' ? `${result.name} skipped!` : `${result.name} finished!✅`;
}

/** "Start 5 min Stretch", or "Start Drink water" for a habit without a timer. */
export function startNextLabel(habit) {
  if (!habit) return '';
  return isTimed(habit) ? `Start ${formatSpan(habit.seconds)} ${habit.name}` : `Start ${habit.name}`;
}

/** "You have completed 6 min of habits - 10 min to go. You can do it!" */
export function progressLine(player) {
  const { doneSeconds, leftSeconds } = playerTotals(player);
  const done = `You have completed ${formatSpan(doneSeconds)} of habits`;
  return player?.phase === 'finished' || leftSeconds === 0 ? `${done}.` : `${done} - ${formatSpan(leftSeconds)} to go. You can do it!`;
}

/** The button that leaves the routine-finished screen. */
export function wrapUpLabel(player) {
  return player?.routine.kind === 'evening' ? "Let's wrap up for the day" : 'Back to Day Plan';
}

/** 'mm:ss' (or 'h:mm:ss') for the countdown, rounded up so it reads 05:00 at the start. */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

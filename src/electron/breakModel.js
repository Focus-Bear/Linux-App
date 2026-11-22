// Micro breaks: which break habits a break plays, when the next break is due
// and the texts around it. Mirrors the Windows app (Core/Breaks/BreakRotation.cs,
// Core/Breaks/MicrobreakSettings.cs, Habits/BreakWarning).
//
// Settings, the same ones the Windows and Mac apps use:
//   break_after_minutes                       GET/PUT /user-settings (5-180, step 5)
//   break_activities[].include_in_every_break GET/PUT /user-settings
//   kUserdefaultsBreaksEnabledFromOnboarding  device settings ("Enable Breaks")
//   kBreakAutoStartEnabled                    device settings ("Start breaks automatically")
//
// Pure functions (no Electron, no React); used by the main process and the UI.

export const DEFAULT_BREAK_MINUTES = 15;
export const MIN_BREAK_MINUTES = 5;
export const MAX_BREAK_MINUTES = 180;
export const STEP_BREAK_MINUTES = 5;

/** Seconds the warning counts down before the break starts by itself. */
export const WARNING_SECONDS = 30;
/** Seconds the start screen waits when "Start breaks automatically" is on. */
export const AUTO_START_SECONDS = 5;
export const POSTPONE_OPTIONS = [5, 10, 15, 20, 25, 30, 45, 60, 90];
export const DEFAULT_POSTPONE_MINUTES = 30;

/** A usable break interval from whatever the account has; the default when unreadable. */
export function clampBreakMinutes(value) {
  const minutes = Math.round(Number(value));
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_BREAK_MINUTES;
  return Math.min(MAX_BREAK_MINUTES, Math.max(MIN_BREAK_MINUTES, minutes));
}

/** The next value up or down in steps of 5, inside 5-180. */
export function stepBreakMinutes(current, direction) {
  const base = clampBreakMinutes(current);
  const next =
    direction > 0
      ? Math.floor(base / STEP_BREAK_MINUTES) * STEP_BREAK_MINUTES + STEP_BREAK_MINUTES
      : Math.ceil(base / STEP_BREAK_MINUTES) * STEP_BREAK_MINUTES - STEP_BREAK_MINUTES;
  return Math.min(MAX_BREAK_MINUTES, Math.max(MIN_BREAK_MINUTES, next));
}

/** What the frequency box holds, as minutes, or null ("Enter a whole number from 5 to 180 minutes."). */
export function parseBreakMinutes(text) {
  const value = String(text ?? '').trim();
  if (!/^\d{1,3}$/.test(value)) return null;
  const minutes = Number(value);
  return minutes >= MIN_BREAK_MINUTES && minutes <= MAX_BREAK_MINUTES ? minutes : null;
}

/** The account's break habits (`break_activities`), in the user's order. */
export function breakHabits(settings) {
  const list = settings && Array.isArray(settings.break_activities) ? settings.break_activities : [];
  return list
    .filter((activity) => activity && activity.id)
    .map((activity) => ({
      id: activity.id,
      name: activity.name || 'Break',
      icon: activity.habit_icon || '',
      seconds: Math.max(0, Number(activity.duration_seconds) || 0),
      sequenceId: activity.activity_sequence_id || '',
      requirements: String(activity.completion_requirements || '').trim(),
      everyBreak: activity.include_in_every_break === true,
    }));
}

/**
 * The habits of the next break: every "every break" habit plus one of the
 * others, taking turns. They play in the user's order.
 *
 * The turn goes to the first rotating habit after the one that had the last
 * turn (`lastRotatedId`), wrapping round; an id that no longer exists restarts
 * at the first. Returns { play, rotatedId } (rotatedId null when there is no
 * rotating habit). The caller saves rotatedId once the break was taken; a
 * break that is skipped or postponed doesn't use up the turn.
 */
export function planBreak(habits, lastRotatedId = null) {
  const list = Array.isArray(habits) ? habits : [];
  const lastPosition = lastRotatedId ? list.findIndex((habit) => habit.id === lastRotatedId) : -1;
  const candidates = list.map((habit, index) => (habit.everyBreak ? -1 : index)).filter((index) => index >= 0);
  let rotated = -1;
  if (candidates.length > 0) {
    const after = candidates.find((index) => index > lastPosition);
    rotated = after === undefined ? candidates[0] : after;
  }
  return {
    play: list.filter((habit, index) => habit.everyBreak || index === rotated),
    rotatedId: rotated >= 0 ? list[rotated].id : null,
  };
}

/** Timed seconds of a planned break (habits with completion requirements have no timer). */
export function breakSeconds(play) {
  return (Array.isArray(play) ? play : []).reduce((sum, habit) => (habit.requirements ? sum : sum + habit.seconds), 0);
}

/** '45 sec', '1 min', '3 min 10 sec'. */
export function formatBreakLength(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s} sec`;
  return s === 0 ? `${m} min` : `${m} min ${s} sec`;
}

/** The warning's title: "Your 50 sec micro break starts in". */
export function warningTitle(seconds) {
  return seconds > 0 ? `Your ${formatBreakLength(seconds)} micro break starts in` : 'Your micro break starts in';
}

/** "Postpone for 30 minutes". */
export function postponeLabel(minutes) {
  return `Postpone for ${minutes} minutes`;
}

/**
 * Whether the break on screen stops the next one from coming up: only a break
 * that is still being played does. A finished one is just a "Nice break"
 * screen that was left open.
 */
export function blocksNextBreak(player) {
  return Boolean(player) && player.phase !== 'finished';
}

export function normalisePostpone(value) {
  const minutes = Number(value);
  return POSTPONE_OPTIONS.includes(minutes) ? minutes : DEFAULT_POSTPONE_MINUTES;
}

// --- scheduling ---------------------------------------------------------------

/**
 * What the main process needs to run the break timer, from what the window
 * knows. Breaks need the switch on and at least one break habit.
 */
export function normaliseBreakConfig(config) {
  const input = config && typeof config === 'object' ? config : {};
  return {
    enabled: input.enabled !== false,
    minutes: clampBreakMinutes(input.minutes),
    habitCount: Math.max(0, Math.round(Number(input.habitCount) || 0)),
    seconds: Math.max(0, Math.round(Number(input.seconds) || 0)),
    startup: typeof input.startup === 'string' ? input.startup : '',
    shutdown: typeof input.shutdown === 'string' ? input.shutdown : '',
  };
}

export function breaksActive(config) {
  return Boolean(config) && config.enabled && config.habitCount > 0;
}

/** When the next break is due after `now` (epoch ms), or null when breaks are off. */
export function nextBreakAt(config, now, afterMinutes = null) {
  if (!breaksActive(config)) return null;
  return now + (afterMinutes ?? config.minutes) * 60000;
}

/**
 * The timer after the settings changed: the running countdown is kept unless
 * breaks were switched off / on or the interval changed.
 */
export function rescheduleAt(previous, next, currentAt, now) {
  if (!breaksActive(next)) return null;
  if (currentAt && breaksActive(previous) && previous.minutes === next.minutes) return currentAt;
  return nextBreakAt(next, now);
}

const minutesOf = (text) => {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(text ?? '').trim());
  if (!match) return null;
  const value = Number(match[1]) * 60 + Number(match[2]);
  return value < 1440 ? value : null;
};

/**
 * Why a due break is not shown now, or null when it should be. A held break is
 * tried again after a full interval, as on Windows.
 *   'focus'     a focus session is running (breaks are skipped during work blocks)
 *   'routine'   a routine or a break is being played
 *   'off-hours' between the end of the day (shutdown_time) and its start (startup_time)
 */
export function holdReason(config, { focusActive = false, playing = false, nowMinutes = null } = {}) {
  if (focusActive) return 'focus';
  if (playing) return 'routine';
  const start = minutesOf(config?.startup);
  const end = minutesOf(config?.shutdown);
  if (nowMinutes !== null && start !== null && end !== null && start !== end) {
    const working = start < end ? nowMinutes >= start && nowMinutes < end : nowMinutes >= start || nowMinutes < end;
    if (!working) return 'off-hours';
  }
  return null;
}

/** Tray / sidebar text: "Next break in 12 min", "Next break in less than a minute", or '' when off. */
export function nextBreakLabel(nextAt, now) {
  if (!nextAt) return '';
  const minutes = Math.ceil((nextAt - now) / 60000);
  if (minutes <= 1) return 'Next break in less than a minute';
  return `Next break in ${minutes} min`;
}

// The running focus session, as the main process holds it: one session, its
// end-of-session timer, its copy on disk, and whose it is.
//
// Taken out of main.js so the rules can be tested without Electron
// (focusSessionController.test.js): the clock, the timers and the file are
// passed in. main.js registers the IPC handlers and forwards them here.
//
// Strictness is enforced here, not in the window. A Captain session's pause,
// stop and "− 5 min" go through only after the 15-second wait has run in this
// process (`requestStop`, then the action); a Pawfessor session can't be
// paused or shortened, and stops only with the characters this process made
// up. The window used to hold the countdown and the code itself, so "− 5 min"
// (and any direct call) skipped them.
//
// A session belongs to the account that started it (`userId`). Signing out
// clears it, and a session found on disk for another account is dropped when
// someone else signs in: account B used to be shown account A's end screen.
import {
  STOP_DELAY_SECONDS,
  adjustSession,
  canPause,
  createSession,
  endSession,
  isActive,
  makeStopCode,
  needsStopCode,
  pauseSession,
  remainingMs,
  restoreSession,
  resumeSession,
  stopCodeMatches,
  stopDelaySeconds,
} from './focusSessionModel.js';

/** How long after its wait a Captain permit can still be used. */
export const PERMIT_LIFETIME_MS = 2 * 60 * 1000;
/** How often a running session notes that the app is alive (see `restore` and `heartbeat`). */
export const HEARTBEAT_MS = 60 * 1000;
/** A gap this long between two heartbeats means the computer slept or the app was closed. */
export const AWAY_MS = 10 * 60 * 1000;
const STOP_ACTIONS = ['end', 'pause', 'reduce'];

export function createFocusSessionController({
  now = () => Date.now(),
  load = async () => null, // the saved session, or null
  save = async () => {},
  remove = async () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  onChange = () => {}, // (session) after every change
  onTimeUp = () => {}, // the session ran out by itself
  random = Math.random,
}) {
  let session = null;
  let timer = null;
  let beat = null;
  // The stop / pause / shorten that was asked for: { action, readyAt, expiresAt, code }.
  let permit = null;
  // undefined: nobody has signed in yet in this run; null: signed out.
  let userId;

  function set(next) {
    session = next || null;
    Promise.resolve()
      .then(() => (session ? save(session) : remove()))
      .catch(() => {});

    if (timer) clearTimer(timer);
    timer = null;
    if (beat) clearTimer(beat);
    beat = null;
    if (!isActive(session)) permit = null;
    if (session && session.status === 'running') {
      beat = setTimer(heartbeat, HEARTBEAT_MS);
      timer = setTimer(() => {
        timer = null;
        if (!session || session.status !== 'running') return;
        // (An untimed session whose 12 hours passed while the computer slept
        // ends when the app was last seen: see heartbeat.)
        const last = session.lastSeenAt || session.startTime;
        set(endSession(session, session.untimed && now() - last > AWAY_MS ? last : now()));
        onTimeUp(session);
      }, remainingMs(session, now()) + 50);
    }

    onChange(session);
    return session;
  }

  /**
   * An untimed session has no end of its own (it is a 12-hour session on the
   * server). If the computer sleeps or the app is closed and nobody comes back
   * for hours, it must not count all that time: it ends at the last moment the
   * app was known to be running.
   */
  function heartbeat() {
    beat = null;
    if (!session || session.status !== 'running') return;
    const last = session.lastSeenAt || session.startTime;
    if (session.untimed && now() - last > AWAY_MS) {
      set(endSession(session, last));
      onTimeUp(session);
      return;
    }
    set({ ...session, lastSeenAt: now() });
  }

  /** Whether the wait (Captain) or the code (Pawfessor) for `action` has been satisfied. */
  function allowed(action, code) {
    if (!isActive(session)) return true;
    if (action !== 'end' && !canPause(session)) return false; // Pawfessor: no pause, no time off
    if (action === 'end' && needsStopCode(session)) {
      return Boolean(permit) && permit.action === 'end' && stopCodeMatches(permit.code, code);
    }
    if (stopDelaySeconds(session) > 0) {
      const at = now();
      return Boolean(permit) && permit.action === action && at >= permit.readyAt && at <= permit.expiresAt;
    }
    return true;
  }

  return {
    get: () => session,
    isActive: () => isActive(session),

    /** At launch: a session survives a restart, and ends if its time ran out meanwhile. */
    async restore() {
      let saved = null;
      try {
        saved = await load();
      } catch {
        saved = null;
      }
      // An untimed session left running while the app was closed for long
      // ends when the app was last seen, not now (and not 12 hours on).
      if (saved && saved.untimed && saved.status === 'running' && Number.isFinite(saved.startTime)) {
        const last = saved.lastSeenAt || saved.startTime;
        if (now() - last > AWAY_MS) saved = endSession(saved, last);
      }
      const restored = restoreSession(saved, now());
      if (!restored) return null;
      // Signed out (or another account signed in) before the file was read.
      if (userId === null) return null;
      if (userId && restored.userId && restored.userId !== userId) return null;
      return set(restored);
    },

    start(input) {
      if (isActive(session)) return session;
      // startTime: when the renderer already told the server the session started.
      const startTime = Number(input && input.startTime);
      const at = Number.isFinite(startTime) && Math.abs(now() - startTime) < 60000 ? startTime : now();
      return set({ ...createSession({ ...(input || {}), now: at }), userId: userId || null, lastSeenAt: at });
    },

    /**
     * Asks to stop, pause or shorten ('end' | 'pause' | 'reduce') the session.
     * Returns what the window has to show:
     *   { ready: true }               nothing to wait for (Junior)
     *   { waitSeconds, readyAt }      Captain: the action is accepted from readyAt
     *   { code }                      Pawfessor, ending: the characters to type
     *   { refused: true }             Pawfessor: no pause and no time off
     */
    requestStop(action) {
      if (!STOP_ACTIONS.includes(action) || !isActive(session)) return { refused: true };
      if (action !== 'end' && !canPause(session)) return { refused: true };
      if (action === 'end' && needsStopCode(session)) {
        permit = { action, code: makeStopCode(random), readyAt: now(), expiresAt: Infinity };
        return { code: permit.code };
      }
      const wait = stopDelaySeconds(session);
      if (wait <= 0) return { ready: true };
      const readyAt = now() + wait * 1000;
      permit = { action, readyAt, expiresAt: readyAt + PERMIT_LIFETIME_MS, code: '' };
      return { waitSeconds: wait, readyAt };
    },

    /** "Keep going": the wait or the code no longer counts. */
    cancelStop() {
      permit = null;
      return true;
    },

    pause() {
      if (!allowed('pause')) return session;
      permit = null;
      return set(pauseSession(session, now()));
    },
    resume: () => set(resumeSession(session, now())),
    /** + / − minutes. Adding time is free; taking time off is a way of stopping, so it follows the level. */
    adjust(deltaMinutes) {
      const delta = Number(deltaMinutes) || 0;
      if (delta < 0) {
        if (!allowed('reduce')) return session;
        permit = null;
      }
      return set(adjustSession(session, delta, now()));
    },
    /** Ends the session now. `code`: the typed characters, for a Pawfessor session. */
    end(code) {
      if (!allowed('end', code)) return session;
      permit = null;
      return set(endSession(session, now()));
    },
    /** True when Quit must not go through: a session that takes a wait or a code to stop is running. */
    blocksQuit: () => isActive(session) && (stopDelaySeconds(session) > 0 || needsStopCode(session)),

    /** The task queue changed (a task was finished, or another one was picked). */
    setTasks(tasks) {
      if (!isActive(session) || !Array.isArray(tasks)) return session;
      return set({ ...session, tasks });
    },

    /** The renderer has sent the finish to the server; don't send it again. */
    markReported() {
      if (!session || session.status !== 'ended') return session;
      return set({ ...session, finishReported: true });
    },

    /** The end screen was closed. */
    clear() {
      if (isActive(session)) return session;
      return set(null);
    },

    /** Removes the session whatever its state (Uninstall > Clean Up App Data). */
    discard: () => set(null),

    /**
     * Someone signed in. A session that belongs to another account is dropped
     * (it is not theirs to see, stop or report); one saved before sessions
     * carried an owner is taken as theirs.
     */
    signedIn(id) {
      userId = id || null;
      if (!session || !userId) return session;
      if (session.userId && session.userId !== userId) return set(null);
      if (!session.userId) return set({ ...session, userId });
      return session;
    },

    /** Signed out: the session ends with the sign-in. Returns the session that was dropped. */
    signedOut() {
      userId = null;
      const dropped = session;
      if (session) set(null);
      return dropped;
    },
  };
}

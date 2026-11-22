// The running focus session, as the main process holds it: one session, its
// end-of-session timer, its copy on disk, and whose it is.
//
// Taken out of main.js so the rules can be tested without Electron
// (focusSessionController.test.js): the clock, the timers and the file are
// passed in. main.js registers the IPC handlers and forwards them here.
//
// A session belongs to the account that started it (`userId`). Signing out
// clears it, and a session found on disk for another account is dropped when
// someone else signs in: account B used to be shown account A's end screen.
import {
  adjustSession,
  createSession,
  endSession,
  isActive,
  pauseSession,
  remainingMs,
  restoreSession,
  resumeSession,
} from './focusSessionModel.js';

export function createFocusSessionController({
  now = () => Date.now(),
  load = async () => null, // the saved session, or null
  save = async () => {},
  remove = async () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  onChange = () => {}, // (session) after every change
  onTimeUp = () => {}, // the session ran out by itself
}) {
  let session = null;
  let timer = null;
  // undefined: nobody has signed in yet in this run; null: signed out.
  let userId;

  function set(next) {
    session = next || null;
    Promise.resolve()
      .then(() => (session ? save(session) : remove()))
      .catch(() => {});

    if (timer) clearTimer(timer);
    timer = null;
    if (session && session.status === 'running') {
      timer = setTimer(() => {
        timer = null;
        if (!session || session.status !== 'running') return;
        set(endSession(session, now()));
        onTimeUp(session);
      }, remainingMs(session, now()) + 50);
    }

    onChange(session);
    return session;
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
      return set({ ...createSession({ ...(input || {}), now: at }), userId: userId || null });
    },

    pause: () => set(pauseSession(session, now())),
    resume: () => set(resumeSession(session, now())),
    adjust: (deltaMinutes) => set(adjustSession(session, Number(deltaMinutes) || 0, now())),
    end: () => set(endSession(session, now())),

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

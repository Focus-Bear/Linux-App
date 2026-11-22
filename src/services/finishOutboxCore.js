// Finished focus sessions that still have to be reported to the server
// (POST /focus-mode/{id}/finish).
//
// The finish used to be sent once; when it failed (offline at the end of the
// session, a 5xx) the session was marked reported anyway and never sent again.
// The server then kept the session's planned finish (start + 12 hours for an
// untimed one), and a reflection saved afterwards landed on the previous
// session's row.
//
// Now an ended session goes into this outbox, which is kept in storage, and
// stays there until the server has accepted it: retried while the app runs,
// when the network returns, and at the next start. Entries belong to the
// account that ran the session and are only ever sent with that account
// signed in.
//
// `storage` ({ read(): string|null, write(text) }) and `send(session)` are
// passed in (finishOutboxCore.test.js).

export const OUTBOX_KEY = 'fb_unsent_focus_finishes';
const MAX_ENTRIES = 30;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** A failure that sending again can't fix (the list was deleted, the session is unknown): the entry is dropped. */
export function isPermanent(error) {
  const status = Number(error && error.status);
  return status >= 400 && status < 500 && ![401, 403, 408, 425, 429].includes(status);
}

/** The parts of a session the finish request needs. */
function slim(session) {
  return {
    modeId: session.modeId,
    startTime: session.startTime,
    finishTime: session.finishTime,
    endedAt: session.endedAt,
    pausedTotalMs: session.pausedTotalMs || 0,
    status: 'ended',
    untimed: Boolean(session.untimed),
    tasks: Array.isArray(session.tasks) ? session.tasks : [],
  };
}

export function createFinishOutbox({ storage, send, now = () => Date.now(), log = console }) {
  const listeners = new Set();
  let flushing = null;

  function read() {
    try {
      const parsed = JSON.parse(storage.read() || '[]');
      return Array.isArray(parsed) ? parsed.filter((entry) => entry && entry.session && entry.session.modeId) : [];
    } catch {
      return [];
    }
  }

  function write(entries) {
    try {
      storage.write(JSON.stringify(entries.slice(-MAX_ENTRIES)));
    } catch {
      // kept in memory until the next change
    }
    listeners.forEach((listener) => listener());
  }

  const outbox = {
    /** Queues the finish of an ended session (once per session). */
    add(session, userId) {
      if (!session || session.status !== 'ended' || !session.synced || !session.modeId) return false;
      const entries = read();
      if (entries.some((entry) => entry.userId === (userId || '') && entry.session.startTime === session.startTime)) return false;
      entries.push({ userId: userId || '', addedAt: now(), session: slim(session) });
      write(entries);
      return true;
    },

    /** True while this session's finish has not reached the server. */
    has(startTime, userId) {
      return read().some((entry) => entry.userId === (userId || '') && entry.session.startTime === startTime);
    },

    pending: (userId) => read().filter((entry) => entry.userId === (userId || '')).length,

    /**
     * Sends what is waiting for `userId`, oldest first. Stops at the first
     * failure that may pass (offline, 5xx); drops entries the server refuses
     * for good and entries older than two weeks. Resolves to what is left.
     */
    flush(userId) {
      if (flushing) return flushing;
      flushing = (async () => {
        const mine = read().filter((entry) => entry.userId === (userId || ''));
        for (const entry of mine) {
          let done = now() - entry.addedAt > MAX_AGE_MS;
          if (!done) {
            try {
              await send(entry.session);
              done = true;
            } catch (error) {
              if (isPermanent(error)) {
                log.error('[Focus] The server refused a finished session; not sending it again:', error?.message || error);
                done = true;
              } else {
                break;
              }
            }
          }
          if (done) {
            write(read().filter((other) => !(other.userId === entry.userId && other.session.startTime === entry.session.startTime)));
          }
        }
        return outbox.pending(userId);
      })().finally(() => {
        flushing = null;
      });
      return flushing;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return outbox;
}

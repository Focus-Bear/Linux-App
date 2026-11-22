import { useEffect, useState } from 'react';
import { currentUserId, finishOutbox, flushFinishes } from '../services/finishOutbox.js';
import { isActive } from '../electron/focusSessionModel.js';

const RETRY_MS = 60 * 1000;

/**
 * The focus session held by the main process, plus a clock that ticks while it
 * runs. Also reports an ended session to the Focus Bear API once: the session
 * can end while another page is open (timer ran out, tray > Stop), so this
 * lives in the window shell, not in the focus page.
 *
 * Returns { session, now, loaded }.
 */
export function useFocusSession() {
  const [session, setSession] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const api = window.api?.focusSession;
    if (!api) {
      setLoaded(true);
      return undefined;
    }
    api
      .get()
      .then((current) => {
        if (cancelled) return;
        setSession(current || null);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    const off = api.onChanged((next) => {
      setNow(Date.now());
      setSession(next || null);
    });
    return () => {
      cancelled = true;
      if (typeof off === 'function') off();
    };
  }, []);

  const running = session?.status === 'running';
  useEffect(() => {
    if (!running) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);

  // An ended session's finish goes into the outbox (kept on disk) and is sent
  // from there until the server has it; "reported" now means "handed over".
  useEffect(() => {
    if (!session || session.status !== 'ended' || session.finishReported) return;
    finishOutbox.add(session, currentUserId());
    window.api?.focusSession?.markReported?.();
    flushFinishes();
  }, [session]);

  // Finishes that could not be sent earlier: now, when the network returns, and every minute.
  useEffect(() => {
    flushFinishes();
    const timer = setInterval(() => {
      if (finishOutbox.pending(currentUserId()) > 0) flushFinishes();
    }, RETRY_MS);
    window.addEventListener('online', flushFinishes);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', flushFinishes);
    };
  }, []);

  return { session, now, loaded, active: isActive(session) };
}

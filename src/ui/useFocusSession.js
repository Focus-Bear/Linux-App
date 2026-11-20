import { useEffect, useState } from 'react';
import { focusApi } from '../services/focusApi.js';
import { isActive } from '../electron/focusSessionModel.js';

// Sessions whose finish is being sent, keyed by start time, so a re-render (or
// React StrictMode's double effect) can't send POST /finish twice.
const reporting = new Set();

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

  useEffect(() => {
    if (!session || session.status !== 'ended' || session.finishReported) return;
    const key = session.startTime;
    if (reporting.has(key)) return;
    reporting.add(key);
    const send = session.synced && session.modeId ? focusApi.finishSession(session) : Promise.resolve();
    send
      .catch((error) => console.error('[Focus] Could not report the finished session:', error))
      .finally(() => window.api?.focusSession?.markReported?.())
      .finally(() => reporting.delete(key));
  }, [session]);

  return { session, now, loaded, active: isActive(session) };
}

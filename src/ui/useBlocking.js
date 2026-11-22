import { useEffect, useMemo, useState } from 'react';
import { blockingStore, useBlockingStore } from '../services/blockingStore.js';
import { activeBlocking, effectiveBlocking } from '../electron/blockingModel.js';
import { isActive } from '../electron/focusSessionModel.js';

const RELOAD_MS = 15 * 60 * 1000; // lists and schedules can change on another device
const TICK_MS = 20 * 1000; // schedules start and end on the minute
// The main process lifts a list the window hasn't confirmed for three minutes
// (src/electron/blockingState.js), so the window says it again every minute.
const CONFIRM_MS = 60 * 1000;

/**
 * Keeps the browser extensions on the block list that is in force: the running
 * focus session's list, else the active blocking schedule's. Runs in the
 * window shell. Returns { ...store state, inForce: { mode, schedule, source } }.
 */
export function useBlocking(session) {
  const store = useBlockingStore();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    blockingStore.load();
    const reload = setInterval(() => blockingStore.load(), RELOAD_MS);
    const tick = setInterval(() => setNow(new Date()), TICK_MS);
    return () => {
      clearInterval(reload);
      clearInterval(tick);
    };
  }, []);

  const sessionModeId = isActive(session) ? session.modeId : null;
  const { modes, schedules } = store;
  const inForce = useMemo(
    () => activeBlocking({ modes, schedules, sessionModeId, date: now }),
    [modes, schedules, sessionModeId, now],
  );

  // The always-blocked sites are added by the main process; only the list's own part is sent.
  const extra = useMemo(() => effectiveBlocking([], inForce.mode), [inForce.mode]);
  const key = JSON.stringify(extra);
  useEffect(() => {
    const send = () => window.api?.setModeBlocking?.(JSON.parse(key))?.catch?.(() => {});
    send();
    const confirm = setInterval(send, CONFIRM_MS);
    return () => clearInterval(confirm);
  }, [key]);

  return { ...store, inForce };
}

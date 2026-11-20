import { useEffect } from 'react';
import { breakConfig, breakStore, useBreakStore } from '../services/breakStore.js';
import { useHabitPlayer } from '../services/habitPlayerStore.js';
import { useSyncedState } from '../services/sync.js';

const RELOAD_MS = 30 * 60 * 1000;

/**
 * Runs micro breaks for the window shell: loads the account's break settings,
 * keeps the main process's break timer configured, and follows the timer
 * ("Next break in ..."). Returns the break store's state.
 */
export function useBreaks() {
  const breaks = useBreakStore();
  const [enabled, , enabledLoading] = useSyncedState('breaksEnabled');
  const { player: routine } = useHabitPlayer();

  // Break habits are edited on the dashboard page, so read them again now and then.
  useEffect(() => {
    breakStore.load();
    const timer = setInterval(() => breakStore.load(), RELOAD_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const api = window.api?.breaks;
    if (!api) return undefined;
    api.get().then((state) => breakStore.setNextAt(state?.nextAt)).catch(() => {});
    const offChanged = api.onChanged((state) => breakStore.setNextAt(state?.nextAt));
    const offDue = api.onDue(() => {
      breakStore.load();
      breakStore.markDue();
    });
    return () => {
      if (typeof offChanged === 'function') offChanged();
      if (typeof offDue === 'function') offDue();
    };
  }, []);

  const breakOnScreen = Boolean(breaks.player) && breaks.player.phase !== 'finished';
  const playing = breakOnScreen || (Boolean(routine) && routine.phase !== 'finished');
  const { status, minutes, plan, startup, shutdown } = breaks;
  useEffect(() => {
    if (enabledLoading || status === 'loading') return;
    window.api?.breaks
      ?.configure(breakConfig({ status, minutes, plan, startup, shutdown }, { enabled: enabled !== false, playing }))
      .then((state) => breakStore.setNextAt(state?.nextAt))
      .catch(() => {});
  }, [enabled, enabledLoading, status, minutes, plan, startup, shutdown, playing]);

  return breaks;
}

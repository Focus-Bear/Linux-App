// What the tray popup shows for the current focus session. Pure, so it is
// unit tested and shared by the popup script (src/electron/tray.js).
import { canPause, elapsedMs, formatClock, isActive, remainingMs } from './focusSessionModel.js';

/** 'HH:mm' in local time. */
export function clockTime(ms) {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * The focus card of the tray popup.
 * Returns { state, title, subtitle, primaryLabel, primaryAction, pauseLabel, pauseAction }.
 * pauseLabel is null when there is nothing to pause or resume.
 */
export function trayFocusView(session, now) {
  if (!isActive(session)) {
    return {
      state: 'idle',
      title: 'Focus session',
      subtitle: 'Not running',
      primaryLabel: 'Start Focus Session',
      primaryAction: 'start',
      pauseLabel: null,
      pauseAction: null,
    };
  }

  const goal = session.intention ? ` · ${session.intention}` : '';

  // An untimed session has no end to count down to.
  if (session.untimed) {
    const paused = session.status === 'paused';
    const soFar = formatClock(Math.floor(elapsedMs(session, now) / 1000) * 1000);
    return {
      state: paused ? 'paused' : 'running',
      title: paused ? 'Focus session paused' : `Focusing · ${soFar}`,
      subtitle: `${paused ? `${soFar} so far` : 'no end time'}${goal}`,
      primaryLabel: 'Stop Focus Session',
      primaryAction: 'stop',
      pauseLabel: !canPause(session) ? null : paused ? 'Resume Focus Session' : 'Pause Focus Session',
      pauseAction: !canPause(session) ? null : paused ? 'resume' : 'pause',
    };
  }

  const left = formatClock(remainingMs(session, now));

  if (session.status === 'paused') {
    return {
      state: 'paused',
      title: 'Focus session paused',
      subtitle: `${left} left${goal}`,
      primaryLabel: 'Stop Focus Session',
      primaryAction: 'stop',
      pauseLabel: 'Resume Focus Session',
      pauseAction: 'resume',
    };
  }

  return {
    state: 'running',
    title: `Focusing · ${left} left`,
    subtitle: `ends at ${clockTime(session.finishTime)}${goal}`,
    primaryLabel: 'Stop Focus Session',
    primaryAction: 'stop',
    // A Pawfessor session can't be paused.
    pauseLabel: canPause(session) ? 'Pause Focus Session' : null,
    pauseAction: canPause(session) ? 'pause' : null,
  };
}

/** Pages the tray may open in the main window. */
export const TRAY_PAGES = ['day-plan', 'focus-session', 'micro-break', 'todo-list', 'blocking'];

export function isTrayPage(pageId) {
  return TRAY_PAGES.includes(pageId);
}

/** 'light' | 'dark' from whatever the renderer or a settings file sent. */
export function normaliseTheme(value) {
  return value === 'dark' ? 'dark' : 'light';
}

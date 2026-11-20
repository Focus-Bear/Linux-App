// What the tray popup shows for the current focus session. Pure, so it is
// unit tested and shared by the popup script (src/electron/tray.js).
import { formatClock, isActive, remainingMs } from './focusSessionModel.js';

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

  const left = formatClock(remainingMs(session, now));
  const goal = session.intention ? ` · ${session.intention}` : '';

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
    pauseLabel: 'Pause Focus Session',
    pauseAction: 'pause',
  };
}

/** Pages the tray may open in the main window. */
export const TRAY_PAGES = ['day-plan', 'focus-session', 'todo-list', 'blocking'];

export function isTrayPage(pageId) {
  return TRAY_PAGES.includes(pageId);
}

/** 'light' | 'dark' from whatever the renderer or a settings file sent. */
export function normaliseTheme(value) {
  return value === 'dark' ? 'dark' : 'light';
}

// Focus session model: the session's state, its timer maths, and the request
// bodies for the Focus Bear API. The calls and rules mirror the Windows app
// (API/FocusBearAPIClient.cs StartFocusMode / FinishFocusMode,
// Core/Focus/FocusStartModel.cs), so a session started on Linux shows up in the
// same stats as one started on Windows or Mac.
//
// Pure functions only: the main process (which owns the running session) and
// the renderer (which draws it and talks to the API) both import this file,
// and node --test covers it. Times are epoch milliseconds.

export const DEFAULT_MINUTES = 25;
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 480; // 8 hours
export const STEP_MINUTES = 5;
export const MAX_TEXT = 255; // server limit for achievements / distractions
export const MAX_ACHIEVEMENT_CHARS = 120; // the end screen's counter

/** Name of the block list every account has (config.json focusPreferencesInfo.defaultFocusText). */
export const DEFAULT_MODE_NAME = 'Block super distracting sites/apps';

const MINUTE = 60 * 1000;

/** A whole number of minutes between 1 and 480; anything unusable becomes 25. */
export function clampMinutes(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_MINUTES;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, n));
}

/** The session length after pressing −5 / +5 on the start screen. */
export function stepMinutes(current, direction) {
  const minutes = clampMinutes(current);
  if (direction > 0) {
    // 1 -> 5 -> 10: the first step up from the minimum lands on the grid.
    return clampMinutes(minutes < STEP_MINUTES ? STEP_MINUTES : minutes + STEP_MINUTES);
  }
  return clampMinutes(minutes - STEP_MINUTES);
}

/** The user's usual session length (kPomodoroDurationMinutes in the device settings), or 25. */
export function defaultMinutes(deviceSettings) {
  const raw = deviceSettings ? deviceSettings.kPomodoroDurationMinutes : undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_MINUTES ? clampMinutes(n) : DEFAULT_MINUTES;
}

/** A new running session. `synced` says whether the server accepted the start. */
export function createSession({ modeId = null, modeName = '', intention = '', minutes, now, synced = false }) {
  const length = clampMinutes(minutes);
  return {
    status: 'running',
    modeId,
    modeName: String(modeName || ''),
    intention: String(intention || '').trim(),
    plannedMinutes: length,
    startTime: now,
    finishTime: now + length * MINUTE,
    pausedAt: null,
    pausedTotalMs: 0,
    endedAt: null,
    endedEarly: false,
    synced: Boolean(synced),
    finishReported: false,
  };
}

export function isActive(session) {
  return Boolean(session) && (session.status === 'running' || session.status === 'paused');
}

/** Time left on the clock. Frozen while paused, zero once ended. */
export function remainingMs(session, now) {
  if (!session || session.status === 'ended') return 0;
  const reference = session.status === 'paused' && session.pausedAt != null ? session.pausedAt : now;
  return Math.max(0, session.finishTime - reference);
}

/** Time actually spent focusing (pauses excluded). */
export function elapsedMs(session, now) {
  if (!session) return 0;
  let reference = now;
  if (session.status === 'ended' && session.endedAt != null) reference = session.endedAt;
  else if (session.status === 'paused' && session.pausedAt != null) reference = session.pausedAt;
  return Math.max(0, reference - session.startTime - session.pausedTotalMs);
}

/** Planned focus time for the session as it now stands (after −5 / +5). */
export function totalMs(session) {
  if (!session) return 0;
  return Math.max(0, session.finishTime - session.startTime - session.pausedTotalMs);
}

/** 0..1 for the progress bar. */
export function progress(session, now) {
  const total = totalMs(session);
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, elapsedMs(session, now) / total));
}

export function isDue(session, now) {
  return Boolean(session) && session.status === 'running' && now >= session.finishTime;
}

export function pauseSession(session, now) {
  if (!session || session.status !== 'running') return session;
  return { ...session, status: 'paused', pausedAt: now };
}

/** Resuming moves the finish time back by however long the pause lasted. */
export function resumeSession(session, now) {
  if (!session || session.status !== 'paused') return session;
  const pausedFor = Math.max(0, now - (session.pausedAt ?? now));
  return {
    ...session,
    status: 'running',
    pausedAt: null,
    pausedTotalMs: session.pausedTotalMs + pausedFor,
    finishTime: session.finishTime + pausedFor,
  };
}

/**
 * −5 / +5 during a session. The session never ends by taking time off (at
 * least a minute is left) and never grows past 8 hours of focus.
 */
export function adjustSession(session, deltaMinutes, now) {
  if (!isActive(session)) return session;
  const reference = session.status === 'paused' && session.pausedAt != null ? session.pausedAt : now;
  const earliest = reference + MINUTE;
  const latest = session.startTime + session.pausedTotalMs + MAX_MINUTES * MINUTE;
  const wanted = session.finishTime + deltaMinutes * MINUTE;
  const finishTime = Math.max(Math.min(wanted, Math.max(latest, earliest)), earliest);
  return { ...session, finishTime };
}

/** Ends the session now (stopped) or at its finish time (ran out). */
export function endSession(session, now) {
  if (!isActive(session)) return session;
  const reference = session.status === 'paused' && session.pausedAt != null ? session.pausedAt : now;
  const endedAt = Math.min(reference, session.finishTime);
  return {
    ...session,
    status: 'ended',
    endedAt,
    endedEarly: session.finishTime - endedAt > 1000,
    pausedAt: null,
  };
}

/**
 * What to do with a session read back from disk when the app starts: a session
 * whose time ran out while the app was closed ends at its finish time.
 */
export function restoreSession(saved, now) {
  if (!saved || typeof saved !== 'object') return null;
  if (!['running', 'paused', 'ended'].includes(saved.status)) return null;
  if (!Number.isFinite(saved.startTime) || !Number.isFinite(saved.finishTime)) return null;
  if (saved.status === 'running' && now >= saved.finishTime) return endSession(saved, now);
  return saved;
}

// --- text -------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

/** Countdown clock: 24:59, or 1:05:00 from an hour up. */
export function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Stat text: 27m 59s, 1h 5m, 45s. */
export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** HH:MM for the session-length field (00:25, 01:30). */
export function formatLength(minutes) {
  const total = clampMinutes(minutes);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** Minutes from what was typed into the length field: "25", "1:30", "01:30". Null when unreadable. */
export function parseLength(text) {
  const value = String(text ?? '').trim();
  let minutes;
  if (/^\d{1,3}$/.test(value)) minutes = Number(value);
  else {
    const match = /^(\d{1,2}):([0-5]?\d)$/.exec(value);
    if (!match) return null;
    minutes = Number(match[1]) * 60 + Number(match[2]);
  }
  if (minutes < MIN_MINUTES) return null;
  return clampMinutes(minutes);
}

/** "25 minute", "1 hour", "1 hour 30 minute": the middle of "Start a … session". */
export function lengthWords(minutes) {
  const total = clampMinutes(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const parts = [];
  if (h > 0) parts.push(`${h} hour`);
  if (m > 0) parts.push(`${m} minute`);
  return parts.join(' ');
}

/** "Start a 25 minute session" / "Start an 8 minute session" / "Start an 80 minute session". */
export function startLabel(minutes) {
  const words = lengthWords(minutes);
  const first = words.split(' ')[0];
  const an = /^(8|11|18)$/.test(first) || /^8\d$/.test(first);
  return `Start ${an ? 'an' : 'a'} ${words} session`;
}

/** "Sep 06, 2026 • 9:00 AM - 9:28 AM" for the end screen. */
export function formatRange(startMs, endMs, locale = 'en-US', timeZone) {
  const date = new Intl.DateTimeFormat(locale, { month: 'short', day: '2-digit', year: 'numeric', timeZone });
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone });
  return `${date.format(startMs)} • ${time.format(startMs)} - ${time.format(endMs)}`;
}

/** Title of the end screen: the goal, else the block list, else "Focus session". */
export function sessionTitle(session) {
  return (session && (session.intention || session.modeName)) || 'Focus session';
}

// --- Focus Bear API ---------------------------------------------------------

const iso = (ms) => new Date(ms).toISOString();

/** The focus mode to preselect: the account's default block list, else the first one. */
export function pickDefaultMode(modes = []) {
  if (!Array.isArray(modes) || modes.length === 0) return null;
  const defaults = modes.filter((mode) => mode && mode.metadata && mode.metadata.isDefault === true);
  return defaults.length > 0 ? defaults[defaults.length - 1] : modes[0];
}

/** Modes a person can pick for a session: named ones, default list first. */
export function selectableModes(modes = []) {
  if (!Array.isArray(modes)) return [];
  const usable = modes.filter((mode) => mode && mode.id && typeof mode.name === 'string' && mode.name.trim());
  return [...usable].sort((a, b) => Number(Boolean(b.metadata?.isDefault)) - Number(Boolean(a.metadata?.isDefault)));
}

/**
 * Body of POST /focus-mode that creates the default block list for an account
 * that has none yet (the Windows app does the same in
 * AppSettings.ReadAndCreateDefaultFocusModes; it creates the other built-in
 * lists itself when the user first signs in there).
 */
export function defaultModeBody(id) {
  return {
    id,
    name: DEFAULT_MODE_NAME,
    allowed_urls: [],
    metadata: {
      blockUrlsArray: [],
      allowed_apps_win: [],
      color: 'A3FFA1',
      lastTaskUsed: null,
      isAllowedAllApps: true,
      isAllowedListApproach: true,
      isDefault: true,
      isMeetings: false,
      isLockedFocus: false,
      isRelaxFocus: false,
      isDeepWorkFocus: false,
      isWorkFocus: false,
      autoSuggestFocusModeOnAllowedURL: false,
    },
  };
}

/** Body of POST /focus-mode/{id}/start. */
export function startBody(session) {
  return {
    intention: session.intention || '',
    finish_time: iso(session.finishTime),
    start_time: iso(session.startTime),
    to_dos: [],
  };
}

/** Body of PATCH /focus-mode/{id}/update_scheduled_finish. */
export function scheduledFinishBody(session) {
  return { scheduled_finish_time: iso(session.finishTime) };
}

/** Free text for the API: trimmed to the server limit, then URL-encoded like the other apps send it. */
export function encodeText(text, max = MAX_TEXT) {
  return encodeURIComponent(String(text ?? '').trim().slice(0, max));
}

/** Body of POST /focus-mode/{id}/finish. Stopping early and finishing on time send the same call. */
export function finishBody(session, { achievements = '', distractions = '' } = {}) {
  return {
    achievements: encodeText(achievements),
    distractions: String(distractions ?? '').trim().slice(0, MAX_TEXT),
    finish_time: iso(session.endedAt ?? session.finishTime),
    metadata: {},
    to_dos: [],
  };
}

/** The finished row to attach a reflection to, from GET /user/weekly-focus-block-summary. */
export function findSummaryRow(rows, modeId) {
  if (!Array.isArray(rows)) return null;
  return (
    rows.find((row) => row && row.focus_mode && row.focus_mode.id === modeId && !(row.metadata && row.metadata.is_manual === true)) ||
    null
  );
}

/** Body of PATCH /user/weekly-focus-block-summary/{rowId}. Null when there is nothing to save. */
export function reflectionBody({ achievements = '', stars = 0 } = {}) {
  const body = {};
  const text = String(achievements ?? '').trim();
  if (text) body.achievements = encodeText(text);
  const rating = Math.round(Number(stars));
  if (rating >= 1 && rating <= 5) body.focus_stars = rating;
  return Object.keys(body).length > 0 ? body : null;
}

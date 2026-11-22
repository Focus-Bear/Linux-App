// Block lists ("focus modes") and blocking schedules: the same data the
// Windows and Mac apps use, and what it means for what the browser extension
// blocks. Mirrors the Windows app (Core/Blocking/BlockListScreen.cs,
// Utils/ProcessBrowserURLs.cs, Core/Blocking/ScheduleWindow.cs,
// Core/Blocking/ScheduleOverlap.cs, Services/BlockingScheduleManager.cs).
//
// A block list:  { id, name, allowed_urls: [], metadata: { blockUrlsArray: [],
//                  isAllowedListApproach, isDefault, isRelaxFocus, ... } }
//   default list   blocks only the account's Always Blocked sites (Super Distracting Sites)
//   block list     also blocks its own metadata.blockUrlsArray
//   allow list     blocks everything except its allowed_urls
//                  (metadata.isAllowedListApproach, "block everything except ...")
//   relax list     blocks nothing extra
// Linux blocks websites only; the lists' app settings are kept as they are.
//
// A schedule:    { id, name, start_time 'HH:mm:ss', end_time, days_of_week [0 = Sunday ..],
//                  focus_mode_id, block_level, ... }
//
// Pure functions (no Electron, no React, no fetch).

export const MAX_LIST_NAME = 45;
export const NEW_LIST_COLOR = 'A3FFA1';

const meta = (mode) => (mode && mode.metadata && typeof mode.metadata === 'object' ? mode.metadata : {});
const strings = (list) => (Array.isArray(list) ? list.filter((entry) => typeof entry === 'string' && entry.trim()) : []);

// --- block lists --------------------------------------------------------------

/** 'default' | 'relax' | 'allow' | 'block' */
export function listKind(mode) {
  const m = meta(mode);
  if (m.isDefault === true) return 'default';
  if (m.isRelaxFocus === true) return 'relax';
  return m.isAllowedListApproach === true ? 'allow' : 'block';
}

/** Lists the other apps create themselves; they can't be renamed or deleted. */
export function isBuiltIn(mode) {
  const m = meta(mode);
  return Boolean(m.isDefault || m.isMeetings || m.isLockedFocus || m.isRelaxFocus || m.isDeepWorkFocus);
}

/** Lists a person can pick and edit: named ones, without Meetings and Locked Focus; the default list first. */
export function visibleLists(modes) {
  const usable = (Array.isArray(modes) ? modes : []).filter(
    (mode) => mode && mode.id && typeof mode.name === 'string' && mode.name.trim() && !meta(mode).isMeetings && !meta(mode).isLockedFocus,
  );
  return [...usable].sort((a, b) => Number(Boolean(meta(b).isDefault)) - Number(Boolean(meta(a).isDefault)));
}

/** The websites the list's editor shows: allowed sites for an allow list, blocked ones for a block list. */
export function listEntries(mode) {
  const kind = listKind(mode);
  if (kind === 'allow') return strings(mode.allowed_urls);
  if (kind === 'block') return strings(meta(mode).blockUrlsArray);
  return [];
}

/** "3 blocks", "1 block", "2 allowed", or '' for the default and relax lists. */
export function listCount(mode) {
  const kind = listKind(mode);
  const count = listEntries(mode).length;
  if (kind === 'allow') return `${count} allowed`;
  if (kind === 'block') return count === 1 ? '1 block' : `${count} blocks`;
  return '';
}

/** What the list does, in a sentence (the Windows notices, without the apps part). */
export function listNotice(mode) {
  switch (listKind(mode)) {
    case 'default':
      return 'When you use this block list, all websites are allowed except your Super Distracting Sites.';
    case 'relax':
      return 'All websites are allowed.';
    case 'allow':
      return 'This block list uses an allow list: everything is blocked except the sites below.';
    default:
      return 'When you use this block list, the sites below are blocked as well as your Super Distracting Sites.';
  }
}

/** What starting a session with this list does, for the focus start screen. */
export function listSummary(mode) {
  const count = listEntries(mode).length;
  const sites = count === 1 ? '1 site' : `${count} sites`;
  switch (listKind(mode)) {
    case 'default':
      return 'Blocks your Super Distracting Sites.';
    case 'relax':
      return 'Blocks nothing extra.';
    case 'allow':
      return `Blocks everything except the ${sites} on this list.`;
    default:
      return `Blocks the ${sites} on this list as well as your Super Distracting Sites.`;
  }
}

/** A site or keyword as it is stored: trimmed, lower case, without scheme, "www." or a trailing slash. */
export function normaliseEntry(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

/** Why an entry can't be added to a list, or null. */
export function entryError(value, entries = []) {
  const entry = normaliseEntry(value);
  if (!entry) return 'Type a website first.';
  if (/\s/.test(entry)) return 'Web addresses have no spaces.';
  if (entry.length < 3) return 'Use at least 3 characters, or too many pages will match.';
  if (entries.some((existing) => normaliseEntry(existing) === entry)) return 'That is already on this list.';
  return null;
}

/** Why a list can't have this name, or null. `selfId` is the list being renamed. */
export function listNameError(name, modes = [], selfId = null) {
  const text = String(name ?? '').trim();
  if (!text) return 'Give the block list a name.';
  if (text.length > MAX_LIST_NAME) return `Use ${MAX_LIST_NAME} characters or fewer.`;
  const taken = (Array.isArray(modes) ? modes : []).some(
    (mode) => mode && mode.id !== selfId && String(mode.name || '').trim().toLowerCase() === text.toLowerCase(),
  );
  return taken ? 'Focus Mode with the same name already exists.' : null;
}

/** Body of POST /focus-mode for a new list (the Windows defaults for a new list). */
export function newListBody(id, name, kind = 'block') {
  return {
    id,
    name: String(name).trim(),
    allowed_urls: [],
    metadata: {
      blockUrlsArray: [],
      allowed_apps_win: [],
      color: NEW_LIST_COLOR,
      lastTaskUsed: null,
      isAllowedAllApps: true,
      isAllowedListApproach: kind === 'allow',
      isDefault: false,
      isMeetings: false,
      isLockedFocus: false,
      isRelaxFocus: false,
      isDeepWorkFocus: false,
      isWorkFocus: false,
      autoSuggestFocusModeOnAllowedURL: false,
    },
  };
}

/** The list with its editor's websites replaced (allowed sites or blocked sites, by kind). */
export function withEntries(mode, entries) {
  const clean = [...new Set(strings(entries).map(normaliseEntry).filter(Boolean))];
  if (listKind(mode) === 'allow') return { ...mode, allowed_urls: clean };
  if (listKind(mode) === 'block') return { ...mode, metadata: { ...meta(mode), blockUrlsArray: clean } };
  return mode;
}

export function withName(mode, name) {
  return { ...mode, name: String(name).trim() };
}

/** Switches a custom list between block list and allow list; its websites move to the other field. */
export function withKind(mode, kind) {
  if (isBuiltIn(mode) || listKind(mode) === kind) return mode;
  const entries = listEntries(mode);
  const allow = kind === 'allow';
  return {
    ...mode,
    allowed_urls: allow ? entries : [],
    metadata: { ...meta(mode), isAllowedListApproach: allow, blockUrlsArray: allow ? [] : entries },
  };
}

/**
 * One list as PUT /focus-mode takes it. The server replaces the whole metadata
 * column, so the metadata is sent back as it came (with this app's changes).
 */
export function listBody(mode) {
  const body = { id: mode.id, name: mode.name || '', allowed_urls: strings(mode.allowed_urls), metadata: meta(mode) };
  if (Array.isArray(mode.categories)) body.categories = mode.categories;
  // The server replaces a list's tags with the ones sent (none sent = none
  // left), so tags that came with the list go back with it.
  if (Array.isArray(mode.tags)) {
    body.tags = mode.tags.filter((tag) => tag && tag.id).map((tag) => ({ id: tag.id, text: tag.text }));
  }
  return body;
}

/** Body of the bulk PUT /focus-mode: every list of the account (ids that aren't UUID-like local lists are left out). */
export function allListsBody(modes) {
  return (Array.isArray(modes) ? modes : []).filter((mode) => mode && /^[0-9a-f-]{36}$/i.test(String(mode.id))).map(listBody);
}

// --- what is blocked ----------------------------------------------------------

/**
 * What the browser extension should block while `mode` is in force (a focus
 * session or a blocking schedule), on top of `alwaysBlocked` (the account's
 * Super Distracting Sites, which are blocked all the time).
 *
 * Returns { blocklist, allowOnly }:
 *   blocklist  sites and keywords to block
 *   allowOnly  null, or the only sites that may be opened (everything else is blocked)
 */
export function effectiveBlocking(alwaysBlocked, mode = null) {
  const base = strings(alwaysBlocked);
  if (!mode) return { blocklist: base, allowOnly: null };
  const kind = listKind(mode);
  if (kind === 'default' || kind === 'relax') return { blocklist: base, allowOnly: null };
  const blocklist = [...new Set([...base, ...strings(meta(mode).blockUrlsArray).map(normaliseEntry).filter(Boolean)])];
  if (kind === 'block') return { blocklist, allowOnly: null };
  return { blocklist, allowOnly: strings(mode.allowed_urls).map(normaliseEntry).filter(Boolean) };
}

/**
 * Whether a URL is covered by a list entry, the way the other apps match:
 * lower case, without scheme and "www.", the entry anywhere in the URL, `*` as
 * a wildcard. The browser extensions carry the same rule (they can't import this).
 */
export function matchesEntry(url, entry) {
  const target = String(url ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  const pattern = normaliseEntry(entry);
  if (!pattern) return false;
  if (!pattern.includes('*')) return target.includes(pattern);
  const source = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(source).test(target);
}

// --- schedules ----------------------------------------------------------------

export const BLOCK_LEVELS = ['gentle', 'strict', 'super-strict'];
export const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']; // index 0 = Sunday, as on the wire
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAY_FULL_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** The order the day buttons are shown in: Monday first. */
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
export const WEEKDAYS = [1, 2, 3, 4, 5];
export const WEEKEND = [0, 6];
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** 'HH:mm' or 'HH:mm:ss' -> minutes since midnight, or null. */
export function timeToMinutes(text) {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h > 23 || m > 59 ? null : h * 60 + m;
}

const pad = (n) => String(n).padStart(2, '0');

/** Minutes since midnight -> 'HH:mm:ss' (the wire format). */
export function minutesToWire(minutes) {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00`;
}

/** 'HH:mm' for a time input, from the wire value. */
export function wireToInput(text) {
  const minutes = timeToMinutes(text);
  return minutes === null ? '' : `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** The days a schedule runs on, as sorted indices (0 = Sunday). Accepts numbers, numeric strings and "ALL". */
export function scheduleDays(schedule) {
  const raw = schedule && schedule.days_of_week;
  if (typeof raw === 'string') return raw.trim().toUpperCase() === 'ALL' ? [...EVERY_DAY] : [];
  if (!Array.isArray(raw)) return [];
  const days = new Set();
  for (const value of raw) {
    if (typeof value === 'string' && value.trim().toUpperCase() === 'ALL') return [...EVERY_DAY];
    const day = Number(value);
    if (Number.isInteger(day) && day >= 0 && day <= 6) days.add(day);
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * Whether the schedule is in force at `date` (local time). Both ends count.
 * When the end is before the start the schedule runs overnight and belongs to
 * its start day: Monday 22:00-06:00 runs from Monday 22:00 to Tuesday 06:00.
 */
export function isScheduleActive(schedule, date) {
  const start = timeToMinutes(schedule?.start_time);
  const end = timeToMinutes(schedule?.end_time);
  if (start === null || end === null || start === end) return false;
  const days = scheduleDays(schedule);
  const today = date.getDay();
  const now = date.getHours() * 60 + date.getMinutes();
  if (start < end) return days.includes(today) && now >= start && now <= end;
  if (now >= start) return days.includes(today);
  if (now <= end) return days.includes((today + 6) % 7);
  return false;
}

const levelRank = (schedule) => Math.max(0, BLOCK_LEVELS.indexOf(schedule?.block_level));

/** The schedule in force at `date`: the strictest of the active ones, the first in the list on a tie. Null when none. */
export function governingSchedule(schedules, date) {
  let best = null;
  for (const schedule of Array.isArray(schedules) ? schedules : []) {
    if (!schedule || !isScheduleActive(schedule, date)) continue;
    if (!best || levelRank(schedule) > levelRank(best)) best = schedule;
  }
  return best;
}

/**
 * The block list in force: a focus session's list, else the active schedule's.
 * A strict or super-strict schedule keeps its own list during a session, as on
 * Windows; a gentle one gives way to the session.
 * Returns { mode, schedule, source: 'session' | 'schedule' | null }.
 */
export function activeBlocking({ modes, schedules, sessionModeId = null, date }) {
  const list = Array.isArray(modes) ? modes : [];
  const byId = (id) => list.find((mode) => mode && mode.id === id) || null;
  const schedule = governingSchedule(schedules, date);
  const scheduleMode = schedule ? byId(schedule.focus_mode_id) : null;
  const sessionMode = sessionModeId ? byId(sessionModeId) : null;
  if (sessionMode && !(scheduleMode && levelRank(schedule) > 0)) {
    return { mode: sessionMode, schedule: null, source: 'session' };
  }
  if (scheduleMode) return { mode: scheduleMode, schedule, source: 'schedule' };
  return { mode: null, schedule: null, source: null };
}

/** "Every day", "Weekdays", "Weekends", "Mon-Wed", "Mon, Wed, Fri". */
export function daysSummary(days) {
  const set = [...new Set(days)].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
  if (set.length === 0) return 'No days';
  if (set.length === 7) return 'Every day';
  const key = [...set].sort((a, b) => a - b).join(',');
  if (key === WEEKDAYS.join(',')) return 'Weekdays';
  if (key === WEEKEND.join(',')) return 'Weekends';
  const positions = set.map((day) => DAY_ORDER.indexOf(day));
  const consecutive = positions.every((position, index) => index === 0 || position === positions[index - 1] + 1);
  if (consecutive && set.length > 2) return `${DAY_NAMES[set[0]]}-${DAY_NAMES[set[set.length - 1]]}`;
  return set.map((day) => DAY_NAMES[day]).join(', ');
}

/** "09:00 to 17:00", with "(next day)" for an overnight schedule. */
export function timeSummary(schedule) {
  const start = timeToMinutes(schedule?.start_time);
  const end = timeToMinutes(schedule?.end_time);
  if (start === null || end === null) return '';
  return `${wireToInput(schedule.start_time)} to ${wireToInput(schedule.end_time)}${end < start ? ' (next day)' : ''}`;
}

/** The form's values for a schedule (or for a new one). */
export function scheduleDraft(schedule = null, defaultModeId = '') {
  if (!schedule) return { name: '', days: [...WEEKDAYS], start: '09:00', end: '17:00', modeId: defaultModeId };
  return {
    name: schedule.name || '',
    days: scheduleDays(schedule),
    start: wireToInput(schedule.start_time),
    end: wireToInput(schedule.end_time),
    modeId: schedule.focus_mode_id || defaultModeId,
  };
}

/** Why the form can't be saved, or null (the Windows messages). */
export function scheduleError(draft) {
  if (!String(draft.name || '').trim()) return 'Please enter a name for your custom schedule before saving.';
  if (String(draft.name).trim().length > MAX_LIST_NAME) return `Use ${MAX_LIST_NAME} characters or fewer for the name.`;
  if (!draft.modeId) return 'Please select block list.';
  if (!Array.isArray(draft.days) || draft.days.length === 0) return 'Please select at least one day for this schedule.';
  const start = timeToMinutes(draft.start);
  const end = timeToMinutes(draft.end);
  if (start === null || end === null) return 'Please enter a start and an end time.';
  if (start === end) return "The start and end time can't be the same.";
  return null;
}

/**
 * Body of POST /blocking-schedules and PUT /blocking-schedules/{id}. Fields
 * this app doesn't edit (strictness, emoji, micro breaks, AI) are kept from
 * `existing`; a new schedule gets the Windows defaults.
 */
export function scheduleBody(draft, id, existing = null) {
  const metadata = existing && existing.metadata && typeof existing.metadata === 'object' ? existing.metadata : { is_micro_breaks_enabled: false };
  return {
    id,
    name: String(draft.name).trim(),
    start_time: minutesToWire(timeToMinutes(draft.start)),
    end_time: minutesToWire(timeToMinutes(draft.end)),
    days_of_week: [...new Set(draft.days)].sort((a, b) => a - b),
    focus_mode_id: draft.modeId,
    pause_friction: existing?.pause_friction || 'none',
    block_level: BLOCK_LEVELS.includes(existing?.block_level) ? existing.block_level : 'gentle',
    is_ai_blocking_enabled: existing?.is_ai_blocking_enabled === true,
    emoji: existing?.emoji ?? null,
    metadata,
  };
}

/** Names of other schedules whose times overlap this draft on a shared day (overnight spans included). */
export function overlappingSchedules(draft, schedules, selfId = null) {
  const spans = (days, start, end) => {
    const list = [];
    for (const day of days) {
      const from = day * 1440 + start;
      const to = end > start ? day * 1440 + end : (day + 1) * 1440 + end;
      list.push([from, to]);
      // a Saturday-night span also covers the start of the week
      if (to > 7 * 1440) list.push([from - 7 * 1440, to - 7 * 1440]);
    }
    return list;
  };
  const start = timeToMinutes(draft.start);
  const end = timeToMinutes(draft.end);
  if (start === null || end === null || start === end) return [];
  const mine = spans(draft.days || [], start, end);
  const names = [];
  for (const other of Array.isArray(schedules) ? schedules : []) {
    if (!other || other.id === selfId) continue;
    const s = timeToMinutes(other.start_time);
    const e = timeToMinutes(other.end_time);
    if (s === null || e === null || s === e) continue;
    const theirs = spans(scheduleDays(other), s, e);
    if (mine.some(([a, b]) => theirs.some(([c, d]) => a < d && c < b))) names.push(other.name || 'Schedule');
  }
  return names;
}

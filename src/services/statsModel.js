// Stats, leaderboard and achievements: what the server sends, made ready for
// the pages. Calls as in the Windows app (API/FocusBearAPIClient.Stats.cs,
// Stats/StatsTabs2.cs, Core/Stats/Achievements.cs):
//
//   GET   /user/details                                   streaks, leaderboard username
//   GET   /user/stats/onboarding                          level, streak days, achievements
//   GET   /user-stats/leaderboard?limit=20&streak_type=   { user_rank, users_rankings }
//   PUT   /user/username  { username }
//   GET / PATCH /user/long-term-goals  { goals: [] }
//   GET   /user/weekly-focus-block-summary?limit=&offset= the focus log
//
// Pure functions only, covered by node --test.

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

// --- streaks ------------------------------------------------------------------

/** The four routines the stats are kept for, in the order Windows shows them. */
export const STREAK_KINDS = [
  { id: 'morning', label: 'Morning routine', icon: '🌅', streak: 'morning_routines_streak', done: 'morning_number_days_completed', days: 'morning_num_days_of_stats' },
  { id: 'breaks', label: 'Breaks', icon: '☕', streak: 'micro_breaks_streak', done: 'micro_breaks_number_days_completed', days: 'micro_breaks_num_days_of_stats' },
  { id: 'evening', label: 'Evening routine', icon: '🌙', streak: 'evening_routines_streak', done: 'evening_number_days_completed', days: 'evening_num_days_of_stats' },
  { id: 'focus', label: 'Focus sessions', icon: '🎯', streak: 'focus_modes_streak', done: 'focus_modes_number_days_completed', days: 'focus_modes_num_days_of_stats' },
];

/** "N days completed out of last M" (the Windows caption). */
export function completionCaption(done, days) {
  const d = num(done);
  const m = num(days);
  if (m <= 0) return 'No days tracked yet';
  return `${d} ${d === 1 ? 'day' : 'days'} completed out of last ${m}`;
}

/** Streak tiles from GET /user/details (or a leaderboard row: the fields are the same). */
export function streakTiles(details) {
  const source = details || {};
  return STREAK_KINDS.map((kind) => {
    const done = num(source[kind.done]);
    const days = num(source[kind.days]);
    return {
      id: kind.id,
      label: kind.label,
      icon: kind.icon,
      streak: num(source[kind.streak]),
      done,
      days,
      percent: days > 0 ? Math.min(100, Math.round((done / days) * 100)) : 0,
      caption: completionCaption(done, days),
    };
  });
}

// --- leaderboard ----------------------------------------------------------------

export const LEADERBOARD_LIMIT = 20;

/** Sort choices; `id` is the streak_type query value. */
export const LEADERBOARD_SORTS = [
  { id: 'morning_routines_streak', label: 'Morning', kind: 'morning' },
  { id: 'micro_breaks_streak', label: 'Break', kind: 'breaks' },
  { id: 'evening_routines_streak', label: 'Evening', kind: 'evening' },
  { id: 'focus_modes_streak', label: 'Focus', kind: 'focus' },
];
export const DEFAULT_LEADERBOARD_SORT = LEADERBOARD_SORTS[0].id;

export function leaderboardPath(sortId, limit = LEADERBOARD_LIMIT) {
  const sort = LEADERBOARD_SORTS.some((option) => option.id === sortId) ? sortId : DEFAULT_LEADERBOARD_SORT;
  return `/user-stats/leaderboard?limit=${limit}&streak_type=${sort}`;
}

function leaderboardRow(raw) {
  const tiles = streakTiles(raw);
  const byKind = Object.fromEntries(tiles.map((tile) => [tile.id, tile]));
  return {
    id: String(raw.id ?? ''),
    rank: num(raw.rank),
    name: String(raw.username || '').trim() || 'Anonymous bear',
    isYou: raw.is_current_user === true,
    streaks: byKind,
  };
}

/**
 * The table for GET /user-stats/leaderboard: the top rows, plus `you` when the
 * signed-in person is ranked outside them (shown as "Your position").
 * Numbers arrive as strings from the server.
 */
export function leaderboardTable(response) {
  const rows = (Array.isArray(response?.users_rankings) ? response.users_rankings : [])
    .filter((row) => row && typeof row === 'object')
    .map(leaderboardRow)
    .sort((a, b) => a.rank - b.rank);
  const own = response?.user_rank && typeof response.user_rank === 'object' ? leaderboardRow({ ...response.user_rank, is_current_user: true }) : null;
  const listed = rows.some((row) => row.isYou);
  return { rows, you: own && !listed ? own : null, listed };
}

/** Why a leaderboard username can't be saved, or null. */
export function usernameError(value) {
  const name = String(value ?? '').trim();
  if (!name) return 'Type a username first.';
  if (name.length < 3) return 'Use at least 3 characters.';
  if (name.length > 30) return 'Use at most 30 characters.';
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return 'Use letters, numbers, dots, dashes and underscores only.';
  return null;
}

// --- focus log ------------------------------------------------------------------

function decode(text) {
  const value = String(text ?? '');
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** "8s", "25m", "1h 5m". */
export function formatSeconds(seconds) {
  const total = Math.max(0, Math.round(num(seconds)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}

/** Rows of GET /user/weekly-focus-block-summary for the Focus Log, newest first. */
export function focusLogRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.id)
    .map((row) => ({
      id: row.id,
      start: Date.parse(row.start_time || row.created_at || '') || 0,
      seconds: num(row.focus_duration_seconds),
      duration: formatSeconds(row.focus_duration_seconds),
      title: decode(row.intention).trim() || row.focus_mode?.name || 'Focus session',
      listName: row.focus_mode?.name || '',
      achievements: decode(row.achievements).trim(),
      stars: Math.min(5, Math.max(0, Math.round(num(row.metadata?.focus_stars ?? row.focus_stars)))),
    }))
    .sort((a, b) => b.start - a.start);
}

/** Total focus time of the rows shown. */
export function focusLogTotal(rows) {
  return formatSeconds((rows || []).reduce((sum, row) => sum + row.seconds, 0));
}

// --- achievements ---------------------------------------------------------------

/**
 * The set-up checklists of levels 1 and 2 (Core/Stats/Achievements.cs).
 * `page` is where the step is done in this app: [item id, child id].
 */
export const ACHIEVEMENT_LEVELS = [
  {
    level: 1,
    title: 'Level 1: Get set up',
    steps: [
      { key: 'create_account', label: 'Create your account' },
      { key: 'first_focus_session', label: 'Finish your first focus session', page: ['focus-session'] },
      { key: 'block_list', label: 'Set up your block list', page: ['blocking', 'super-distracting-sites'] },
      { key: 'blocking_schedule', label: 'Create a blocking schedule', page: ['blocking', 'blocking-schedule'] },
      { key: 'allow_list', label: 'Add the websites you use for work', page: ['blocking', 'block-lists'] },
      { key: 'connect_calendar', label: 'Connect your calendar' },
    ],
  },
  {
    level: 2,
    title: 'Level 2: Build your routine',
    steps: [
      { key: 'habits', label: 'Set up your habits', page: ['edit-habits'] },
      { key: 'breaks', label: 'Set up your breaks', page: ['settings', 'settings-breaks'] },
    ],
  },
];

export const MAX_LEVEL = 9;

/**
 * The Achievements page from GET /user/stats/onboarding: the two checklists
 * with their ticks, and the streaks that the later levels are about.
 *
 * `local` ({ key: true }) ticks steps this app can see are done (sites on the
 * block list, a blocking schedule, an allow list) when the server hasn't
 * caught up; the Windows app works most ticks out locally too.
 */
export function achievementsView(stats, local = null) {
  const done = { ...(stats && typeof stats.achievements === 'object' && stats.achievements ? stats.achievements : {}) };
  for (const [key, value] of Object.entries(local || {})) if (value === true) done[key] = true;
  const checklists = ACHIEVEMENT_LEVELS.map((group) => {
    const steps = group.steps.map((step) => ({ ...step, done: done[step.key] === true }));
    const count = steps.filter((step) => step.done).length;
    return { ...group, steps, count, total: steps.length, complete: count === steps.length };
  });
  const level = Math.min(MAX_LEVEL, Math.max(1, Math.round(num(stats?.level)) || 1));
  const streaks = [
    { id: 'morning', label: 'Morning routine', icon: '🌅', days: num(stats?.morning_routine_completion_streak_days), percent: num(stats?.morning_routines_completion_percentage_for_current_level) },
    { id: 'evening', label: 'Evening routine', icon: '🌙', days: num(stats?.evening_routine_completion_streak_days), percent: num(stats?.evening_routines_completion_percentage_for_current_level) },
    { id: 'focus', label: 'Focus sessions', icon: '🎯', days: num(stats?.focus_mode_completion_streak_days), percent: num(stats?.focus_modes_completion_percentage_for_current_level) },
    { id: 'breaks', label: 'Breaks', icon: '☕', days: num(stats?.break_routine_completion_streak_days), percent: num(stats?.break_routines_completion_percentage_for_current_level) },
  ].map((streak) => ({ ...streak, percent: Math.min(100, Math.max(0, Math.round(streak.percent))) }));
  const stepsDone = checklists.reduce((sum, group) => sum + group.count, 0);
  const stepsTotal = checklists.reduce((sum, group) => sum + group.total, 0);
  return { level, checklists, streaks, stepsDone, stepsTotal };
}

/** The steps this app can tell are done from the account's blocking set-up. */
export function localAchievements({ blockedSites = [], schedules = [], modes = [] } = {}) {
  return {
    block_list: (Array.isArray(blockedSites) ? blockedSites : []).some((entry) => typeof entry === 'string' && entry.includes('.')),
    blocking_schedule: Array.isArray(schedules) && schedules.length > 0,
    allow_list:
      Array.isArray(modes) &&
      modes.some((mode) => mode?.metadata?.isAllowedListApproach === true && Array.isArray(mode.allowed_urls) && mode.allowed_urls.length > 0),
  };
}

// --- focus music ----------------------------------------------------------------

/** Tracks of GET /tracks, by name. */
export function trackList(tracks) {
  return (Array.isArray(tracks) ? tracks : [])
    .filter((track) => track && track.id && track.download_url)
    .map((track) => ({
      id: track.id,
      name: String(track.name || 'Untitled track'),
      url: track.download_url,
      image: track.thumbnail_download_url || '',
      seconds: num(track.duration),
      length: formatSeconds(track.duration),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** The track after (or before) the current one, wrapping round. Null for an empty list. */
export function neighbourTrack(tracks, currentId, step = 1) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const index = tracks.findIndex((track) => track.id === currentId);
  if (index < 0) return tracks[0];
  return tracks[(index + step + tracks.length) % tracks.length];
}

/** 1:05 / 1:05:09 for the player. */
export function formatPosition(seconds) {
  const total = Math.max(0, Math.floor(num(seconds)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// --- hiding tools ---------------------------------------------------------------

export const HIDDEN_TOOLS_KEY = 'fb_hidden_tool_ids';

/** The ids of hidden tools from what was stored (comma-separated, as Windows keeps HiddenToolIds). */
export function parseHiddenTools(stored, toolIds = []) {
  const known = new Set(toolIds);
  return String(stored ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id && known.has(id));
}

export function toggleHiddenTool(hidden, id) {
  return hidden.includes(id) ? hidden.filter((item) => item !== id) : [...hidden, id];
}

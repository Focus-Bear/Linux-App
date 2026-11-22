// Day Plan beyond today's habits and tasks: other days, focus blocks, your own
// events, log quantity, skipping and postponing a routine. Follows the Windows
// Day Plan (Habits/HabitsDayPlan.xaml.cs, Habits/DayPlan/DayPlanScheduleBuilder.cs,
// DayPlanEventStore.cs, API/ActivityCompletedBody.cs).
//
// Pure functions only, covered by node --test. Times of day are minutes since
// local midnight; days are 'YYYY-MM-DD'.
import { dayKey, formatDay, formatTime, minutesOfDay, parseTime } from './dayPlanModel.js';

// --- days -----------------------------------------------------------------------

/** The day `delta` days from `day`. */
export function shiftDay(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + delta));
}

/** Local midnight of a day as a Date. */
export function dayDate(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** "Today · Sat 21 Nov", "Tomorrow · Sun 22 Nov", "Yesterday · …", else the date. */
export function dayLabel(day, today) {
  const date = formatDay(dayDate(day));
  if (day === today) return `Today · ${date}`;
  if (day === shiftDay(today, 1)) return `Tomorrow · ${date}`;
  if (day === shiftDay(today, -1)) return `Yesterday · ${date}`;
  return date;
}

/**
 * Minutes east of UTC on `day` (at noon, clear of the hour a clock change
 * happens), for the `timezone` of the routine-progress call. Today's offset is
 * an hour off for a day on the other side of a daylight saving change.
 */
export function dayOffsetMinutes(day, offsetOf = (date) => -date.getTimezoneOffset()) {
  const [y, m, d] = day.split('-').map(Number);
  return offsetOf(new Date(y, m - 1, d, 12));
}

// --- focus blocks ---------------------------------------------------------------

export const MIN_FOCUS_BLOCK_MINUTES = 20;

/**
 * Focus blocks: the free time between the cards of the day, from the first
 * card's end to the last card's start (the Windows schedule builder fills the
 * gaps between habits and meetings the same way). For today, only time that is
 * still ahead counts. `breakMinutes` (when breaks are on) is noted on the block.
 */
export function focusBlocks(cards, { nowMinutes = null, breakMinutes = 0 } = {}) {
  const sorted = [...(Array.isArray(cards) ? cards : [])]
    .filter((card) => card && Number.isFinite(card.start) && Number.isFinite(card.end))
    .sort((a, b) => a.start - b.start);
  if (sorted.length < 2) return [];
  const blocks = [];
  let cursor = sorted[0].end;
  for (const card of sorted.slice(1)) {
    let start = cursor;
    const end = card.start;
    if (nowMinutes !== null) start = Math.max(start, nowMinutes);
    if (end - start >= MIN_FOCUS_BLOCK_MINUTES) {
      blocks.push({
        kind: 'focus',
        id: `focus-${Math.round(start)}`,
        title: 'Focus block',
        icon: '🎯',
        start,
        end,
        minutes: Math.round(end - start),
        breakMinutes: breakMinutes > 0 && breakMinutes < end - start ? Math.round(breakMinutes) : 0,
      });
    }
    cursor = Math.max(cursor, card.end);
  }
  return blocks;
}

/** "2 h 15 min of focus time" under a focus block. */
export function focusBlockNote(block) {
  const h = Math.floor(block.minutes / 60);
  const m = block.minutes % 60;
  const length = h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
  return block.breakMinutes > 0 ? `${length} free · a break every ${block.breakMinutes} min` : `${length} free`;
}

// --- your own events ------------------------------------------------------------

export const MAX_EVENT_TITLE = 255;

/** Why an event can't be added, or null. Times are 'HH:mm'. */
export function eventError({ title, start, end }) {
  if (!String(title ?? '').trim()) return 'Give the event a name.';
  const from = parseTime(start);
  const to = parseTime(end);
  if (from === null || to === null) return 'Set a start and an end time.';
  if (to <= from) return 'The end time has to be after the start time.';
  return null;
}

/**
 * Body of POST /day-plan/events for one event on `day`. Local times without an
 * offset plus the IANA timezone, as the Windows app sends them.
 */
export function eventBody({ title, start, end, description = '' }, day, timezone, id) {
  const stamp = (time) => `${day}T${formatTime(parseTime(time))}:00`;
  const item = {
    title: String(title).trim().slice(0, MAX_EVENT_TITLE),
    dtstart_local: stamp(start),
    dtend_local: stamp(end),
    timezone: timezone || 'UTC',
    external_id: `linux:${id}`,
  };
  const text = String(description ?? '').trim();
  if (text) item.description = text;
  return { events: [item] };
}

/** The end time offered for a new event: an hour after its start, capped at 23:59. */
export function defaultEventEnd(start) {
  const from = parseTime(start, 9 * 60);
  return formatTime(Math.min(from + 60, 23 * 60 + 59));
}

/** The start offered for a new event: the next half hour (09:00 for another day). */
export function defaultEventStart(now, isToday) {
  if (!isToday) return '09:00';
  const next = Math.ceil((minutesOfDay(now) + 1) / 30) * 30;
  return formatTime(Math.min(next, 23 * 60));
}

// --- log quantity ---------------------------------------------------------------

/** The questions a habit asks when it is done (log_quantity_questions; none when log_quantity is off). */
export function habitQuestions(activity) {
  if (!activity || activity.log_quantity !== true) return [];
  return (Array.isArray(activity.log_quantity_questions) ? activity.log_quantity_questions : [])
    .filter((question) => question && question.id && String(question.question || '').trim())
    .map((question) => ({
      id: question.id,
      text: String(question.question).trim(),
      min: Number.isFinite(Number(question.min_value)) && question.min_value !== null ? Number(question.min_value) : null,
      max: Number.isFinite(Number(question.max_value)) && question.max_value !== null ? Number(question.max_value) : null,
      minLabel: question.min_value_description || '',
      maxLabel: question.max_value_description || '',
    }));
}

/**
 * The number typed into an answer field: null when empty, NaN when it isn't a
 * number. A decimal comma is accepted ("1,5"), as most of Europe types it.
 */
export function parseQuantity(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/.test(text)) return NaN;
  return Number(text.replace(',', '.'));
}

/** Why a typed value isn't a usable answer, or null. An empty answer is allowed (the question is left out). */
export function quantityError(question, value) {
  const n = parseQuantity(value);
  if (n === null) return null;
  if (!Number.isFinite(n)) return 'Type a number.';
  if (question.min !== null && n < question.min) return `Use ${question.min} or more.`;
  if (question.max !== null && question.max > (question.min ?? -Infinity) && n > question.max) return `Use ${question.max} or less.`;
  return null;
}

/** `log_quantity_answers` for POST /completed-activity: one per answered question. */
export function quantityAnswers(questions, values) {
  const answers = [];
  for (const question of Array.isArray(questions) ? questions : []) {
    const n = parseQuantity(values?.[question.id]);
    if (n === null || quantityError(question, values?.[question.id])) continue;
    answers.push({ question_id: question.id, logged_value: n });
  }
  return answers;
}

// --- skipping and postponing a routine ------------------------------------------

/** Routine state from GET /completed-activity-sequence/routine-progress: { sequenceId, cancelled }. */
export function routineState(progress, kind) {
  const node = progress && typeof progress === 'object' ? progress[`${kind}_routine`] : null;
  if (!node || typeof node !== 'object') return { sequenceId: '', cancelled: false };
  return { sequenceId: node.sequence_id || '', cancelled: node.was_force_completed === true };
}

/**
 * The same for a custom routine. The progress lists custom routines in
 * `custom_routines` (RoutineProgressItem[]), each with its `sequence_id`; the
 * settings give that id as the routine's `activity_sequence_id`.
 */
export function customRoutineState(progress, sequenceId) {
  if (!sequenceId) return { sequenceId: '', cancelled: false };
  const lists = [progress?.custom_routines, progress?.standalone_routines];
  const node = lists.flatMap((list) => (Array.isArray(list) ? list : [])).find((item) => item && item.sequence_id === sequenceId);
  return { sequenceId, cancelled: node?.was_force_completed === true };
}

/** The sequence id the skip / undo calls need for a routine card ('' when it isn't known). */
export function routineSequenceId(card) {
  return (card && (card.sequenceId || card.habits?.[0]?.sequenceId)) || '';
}

/** Body of the force-complete ("Skip routine for today") and uncomplete (undo) calls. */
export function routineBody(operatingSystem = 'Web') {
  return { operating_system: operatingSystem, metadata: {} };
}

export const POSTPONE_CHOICES = [15, 30, 60];
export const POSTPONE_KEY = 'fb_routine_postponed';

/** What to remember when a routine is postponed. */
export function postponeEntry(card, minutes, now) {
  return { cardId: card.id, title: card.title, day: dayKey(new Date(now)), until: now + minutes * 60 * 1000 };
}

/** The stored postponement if it is still for today, else null. */
export function readPostpone(stored, now) {
  let entry = stored;
  if (typeof stored === 'string') {
    try {
      entry = JSON.parse(stored);
    } catch {
      return null;
    }
  }
  if (!entry || typeof entry !== 'object' || !entry.cardId || !Number.isFinite(entry.until)) return null;
  if (entry.day !== dayKey(new Date(now))) return null;
  return entry;
}

/**
 * Every postponed routine that is still for today, by card id. One entry per
 * routine, so postponing the evening routine doesn't replace the morning one.
 * Also reads the single entry older versions stored.
 */
export function readPostponed(stored, now) {
  let value = stored;
  if (typeof stored === 'string') {
    try {
      value = JSON.parse(stored);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object') return {};
  const entries = {};
  for (const item of value.cardId ? [value] : Object.values(value)) {
    const entry = readPostpone(item, now);
    if (entry) entries[entry.cardId] = entry;
  }
  return entries;
}

/** The postponed routine whose reminder comes first, or null. */
export function nextPostponed(entries) {
  let first = null;
  for (const entry of Object.values(entries || {})) {
    if (!first || entry.until < first.until) first = entry;
  }
  return first;
}

/** Card ids of postponed routines that are over (all habits done or skipped): they need no reminder. */
export function finishedPostponed(cards, entries) {
  return (Array.isArray(cards) ? cards : [])
    .filter((card) => card && card.habits && (card.allDone || card.cancelled) && entries?.[card.id])
    .map((card) => card.id);
}

/** True while the routine's reminder time hasn't come yet. */
export function isPostponed(entry, cardId, now) {
  return Boolean(entry) && entry.cardId === cardId && now < entry.until;
}

/** "Postponed until 09:30" */
export function postponeLabel(entry) {
  return `Postponed until ${formatTime(minutesOfDay(new Date(entry.until)))}`;
}

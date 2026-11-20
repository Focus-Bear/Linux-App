// Day Plan model: turns the account's settings (routines and habits), today's
// calendar events and the to-do list into what the Day Plan page shows.
// Mirrors the Windows Day Plan (Habits/HabitsDayPlan.xaml,
// Habits/DayPlan/*): routine cards with their habits on a timeline, meetings
// between them, and "Tasks for today" beside it.
//
// Pure functions only (no React, no fetch), covered by node --test.
// Times of day are minutes since local midnight; dates are 'YYYY-MM-DD'.

import { focusBlocks, habitQuestions, routineState } from './dayPlanExtras.js';

export const DEFAULT_STARTUP = '05:15';
export const DEFAULT_SHUTDOWN = '20:00';

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar date of a Date as 'YYYY-MM-DD'. */
export function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Minutes since local midnight for a Date. */
export function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** 'HH:mm' -> minutes since midnight, or the fallback when unreadable. */
export function parseTime(text, fallback = null) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(text ?? '').trim());
  if (!match) return fallback;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return fallback;
  return h * 60 + m;
}

/** Minutes since midnight -> 'HH:mm' (wraps past midnight). */
export function formatTime(minutes) {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** '5 min', '1 h', '1 h 30 min', '45 sec'. */
export function formatSpan(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total} sec`;
  const minutes = Math.round(total / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** The timezone query value the API expects, e.g. 'UTC+11:00' (offset in minutes east of UTC). */
export function timezoneParam(offsetMinutesEast) {
  const sign = offsetMinutesEast < 0 ? '-' : '+';
  const abs = Math.abs(Math.round(offsetMinutesEast));
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** Whether a habit or routine with this `days_of_week` runs on the given weekday (0 = Sunday). */
export function runsOnDay(daysOfWeek, weekday) {
  if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) return true;
  const wanted = DAY_NAMES[weekday];
  return daysOfWeek.some((day) => {
    const value = String(day ?? '').trim().toUpperCase();
    return value === 'ALL' || value.slice(0, 3) === wanted;
  });
}

/**
 * Every habit id marked done / skipped in GET /completed-activity-sequence/routine-progress.
 * `local` ({ habitId: 'done' | 'skipped' }) adds what was just done in this
 * app, so a row changes at once instead of after the next reload.
 */
export function progressIds(progress, local = null) {
  const done = new Set();
  const skipped = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'completed_habit_ids' && Array.isArray(value)) value.forEach((id) => done.add(id));
      else if (key === 'skipped_habit_ids' && Array.isArray(value)) value.forEach((id) => skipped.add(id));
      else walk(value);
    }
  };
  walk(progress);
  // The server lists a skipped habit under completed_habit_ids as well.
  for (const id of skipped) done.delete(id);
  for (const [id, outcome] of Object.entries(local || {})) {
    if (outcome === 'done') {
      done.add(id);
      skipped.delete(id);
    } else if (outcome === 'skipped') {
      skipped.add(id);
      done.delete(id);
    }
  }
  return { done, skipped };
}

function habitRows(activities, startMinutes, weekday, ids) {
  let cursor = startMinutes;
  const rows = [];
  for (const activity of Array.isArray(activities) ? activities : []) {
    if (!activity || !runsOnDay(activity.days_of_week, weekday)) continue;
    const seconds = Math.max(0, Number(activity.duration_seconds) || 0);
    const start = cursor;
    cursor += seconds / 60;
    rows.push({
      id: activity.id,
      icon: activity.habit_icon || '',
      name: activity.name || 'Habit',
      start,
      end: cursor,
      seconds,
      // Needed to report the habit as done or skipped (habitApiCore.js).
      sequenceId: activity.activity_sequence_id || '',
      // "Complete after: ..." A habit with requirements has no countdown.
      requirements: String(activity.completion_requirements || '').trim(),
      // Asked when the habit is done ("How many pages did you read?").
      questions: habitQuestions(activity),
      done: ids.done.has(activity.id),
      skipped: ids.skipped.has(activity.id),
    });
  }
  return { rows, end: cursor };
}

function routineCard(kind, title, icon, activities, startMinutes, weekday, ids) {
  const { rows, end } = habitRows(activities, startMinutes, weekday, ids);
  if (rows.length === 0) return null;
  return {
    kind,
    id: kind,
    title,
    icon,
    start: startMinutes,
    end,
    habits: rows,
    allDone: rows.every((row) => row.done || row.skipped),
    openCount: rows.filter((row) => !row.done && !row.skipped).length,
  };
}

/**
 * Calendar events of the day as timeline cards. Accepts the fields the
 * calendar endpoints return for Google and Microsoft accounts.
 * Events that span the whole day and events that don't touch `day` are left out.
 */
export function meetingCards(events, day) {
  const cards = [];
  const seen = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event) continue;
    const begins = event.event_begins || event.start?.dateTime;
    const ends = event.event_ends || event.end?.dateTime;
    if (!begins || !ends) continue;
    const startDate = new Date(begins);
    const endDate = new Date(ends);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) continue;
    if (dayKey(startDate) !== day) continue;
    if (endDate - startDate >= 24 * 60 * 60 * 1000) continue;
    const id = event.external_id || event.id || `${begins}-${event.summary || event.subject || ''}`;
    if (seen.has(id)) continue; // the same meeting on two connected calendars
    seen.add(id);
    const start = minutesOfDay(startDate);
    cards.push({
      kind: 'meeting',
      id: `meeting-${id}`,
      title: event.summary || event.subject || event.title || 'Meeting',
      // The server's id, needed to delete an event added in the Day Plan.
      sourceId: event.id || null,
      icon: '📅',
      start,
      end: start + (endDate - startDate) / 60000,
    });
  }
  return cards;
}

/**
 * The timeline for `day`: morning routine, scheduled custom routines, meetings
 * and the evening routine, in time order.
 *
 * `nowMinutes` (only for today) hides meetings that have finished, as the
 * Windows Day Plan does, and marks the card that is on now.
 */
export function buildTimeline({
  settings,
  progress,
  events,
  planEvents = [],
  day,
  weekday,
  nowMinutes = null,
  local = null,
  withFocusBlocks = false,
  breakMinutes = 0,
}) {
  const config = settings || {};
  const ids = progressIds(progress, local);
  const cards = [];

  const morning = routineCard(
    'morning',
    'Morning routine habits',
    '🌅',
    config.morning_activities,
    parseTime(config.startup_time, parseTime(DEFAULT_STARTUP)),
    weekday,
    ids,
  );
  if (morning) {
    // "Skip routine for today" (was_force_completed on the server).
    Object.assign(morning, routineState(progress, 'morning'));
    cards.push(morning);
  }

  for (const routine of Array.isArray(config.custom_routines) ? config.custom_routines : []) {
    if (!routine || routine.trigger === 'ON_DEMAND') continue;
    if (!runsOnDay(routine.days_of_week, weekday)) continue;
    const start = parseTime(routine.start_time);
    if (start === null) continue;
    const card = routineCard('custom', routine.name || 'Routine', '🔁', routine.standalone_activities, start, weekday, ids);
    if (!card) continue;
    card.id = `custom-${routine.id || routine.name}`;
    const scheduledEnd = parseTime(routine.end_time);
    if (scheduledEnd !== null && scheduledEnd > start) card.end = Math.max(card.end, scheduledEnd);
    cards.push(card);
  }

  for (const meeting of meetingCards(events, day)) {
    if (nowMinutes !== null && meeting.end <= nowMinutes) continue;
    cards.push(meeting);
  }

  const evening = routineCard(
    'evening',
    'Evening routine habits',
    '🌙',
    config.evening_activities,
    parseTime(config.shutdown_time, parseTime(DEFAULT_SHUTDOWN)),
    weekday,
    ids,
  );
  if (evening) {
    Object.assign(evening, routineState(progress, 'evening'));
    cards.push(evening);
  }

  // Events added in the Day Plan (GET /day-plan/events/day/{day}). Unlike
  // calendar meetings they stay listed once over, and can be deleted.
  for (const own of meetingCards(planEvents, day)) {
    if (cards.some((card) => card.kind === 'meeting' && card.id === own.id)) continue;
    cards.push({ ...own, kind: 'event', id: own.id.replace(/^meeting-/, 'event-'), icon: '🗓️' });
  }

  // Free time between the cards becomes focus blocks, as on Windows.
  if (withFocusBlocks) cards.push(...focusBlocks(cards, { nowMinutes, breakMinutes }));

  cards.sort((a, b) => a.start - b.start || a.end - b.end);
  for (const card of cards) {
    card.current = nowMinutes !== null && nowMinutes >= card.start && nowMinutes < card.end;
    card.past = nowMinutes !== null && card.end <= nowMinutes;
  }
  return cards;
}

/** 'HH:mm–HH:mm' for a card or a habit row. */
export function timeRange(item) {
  return `${formatTime(item.start)}–${formatTime(item.end)}`;
}

// --- tasks ------------------------------------------------------------------

/** The calendar day a task belongs to: its planned day, else its due date. Null when it has neither. */
export function taskDay(task) {
  const value = (task && (task.planned_date || task.due_date)) || '';
  const match = /^\d{4}-\d{2}-\d{2}/.exec(String(value));
  return match ? match[0] : null;
}

export function isCompleted(task) {
  return Boolean(task) && task.status === 'COMPLETED';
}

/**
 * "Tasks for today": tasks planned or due today, plus unfinished ones from
 * earlier days (overdue tasks move to today, as on Windows). Unfinished first,
 * most important quadrant first.
 */
export function tasksForDay(tasks, day, today = day) {
  const list = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || !task.id) continue;
    const when = taskDay(task);
    if (!when || when > day) continue;
    // Overdue tasks move to today only; another day shows just its own tasks.
    if (when < day && (day !== today || isCompleted(task))) continue;
    list.push({
      id: task.id,
      title: task.title || 'Untitled task',
      details: task.details || '',
      quadrant: Number(task.eisenhower_quadrant) || 1,
      seconds: Math.max(0, Number(task.duration) || 0),
      completed: isCompleted(task),
      overdue: when < day,
    });
  }
  return list.sort(
    (a, b) => Number(a.completed) - Number(b.completed) || a.quadrant - b.quadrant || a.title.localeCompare(b.title),
  );
}

/** Seconds of work left in the list (completed tasks excluded). */
export function remainingTaskSeconds(tasks) {
  return (tasks || []).reduce((sum, task) => (task.completed ? sum : sum + task.seconds), 0);
}

/** Body of PUT /to-do that ticks a task off (or back on). The API upserts, so title and quadrant go along. */
export function taskStatusBody(task, completed) {
  return {
    id: task.id,
    title: task.title,
    eisenhower_quadrant: task.quadrant || 1,
    status: completed ? 'COMPLETED' : 'NOT_STARTED',
  };
}

/** Body of PUT /to-do that creates a task for `day`. Null for a blank title. */
export function newTaskBody(title, day, minutes = 10) {
  const text = String(title ?? '').trim();
  if (!text) return null;
  return {
    title: text.slice(0, 255),
    eisenhower_quadrant: 1,
    due_date: day,
    planned_date: day,
    duration: Math.max(1, Math.round(minutes)) * 60,
  };
}

/** 'Sat 21 Nov' for the page header. */
export function formatDay(date, locale = 'en-GB') {
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(date).replace(',', '');
}

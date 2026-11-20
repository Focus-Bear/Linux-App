import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTimeline,
  dayKey,
  formatDay,
  formatSpan,
  formatTime,
  isCompleted,
  meetingCards,
  minutesOfDay,
  newTaskBody,
  parseTime,
  progressIds,
  remainingTaskSeconds,
  runsOnDay,
  taskDay,
  tasksForDay,
  taskStatusBody,
  timeRange,
  timezoneParam,
} from './dayPlanModel.js';

const DAY = '2026-11-21'; // a Saturday
const SATURDAY = 6;
// Local-time ISO strings (no Z), so the tests don't depend on the machine's timezone.
const at = (time) => `${DAY}T${time}:00`;

const SETTINGS = {
  startup_time: '07:00',
  shutdown_time: '20:30',
  morning_activities: [
    { id: 'm1', name: 'Drink water', habit_icon: '💧', duration_seconds: 60, days_of_week: ['ALL'] },
    { id: 'm2', name: 'Stretch', habit_icon: '🧘', duration_seconds: 300, days_of_week: ['ALL'] },
    { id: 'm3', name: 'Weekday standup prep', duration_seconds: 600, days_of_week: ['MON', 'TUE', 'WED', 'THU', 'FRI'] },
  ],
  evening_activities: [{ id: 'e1', name: 'Tidy desk', habit_icon: '🧹', duration_seconds: 300 }],
  custom_routines: [
    {
      id: 'c1',
      name: 'Lunch reset',
      trigger: 'ON_SCHEDULE',
      days_of_week: ['SAT'],
      start_time: '12:30',
      end_time: '13:00',
      standalone_activities: [{ id: 'c1a', name: 'Walk', duration_seconds: 600 }],
    },
    { id: 'c2', name: 'On demand', trigger: 'ON_DEMAND', start_time: '09:00', standalone_activities: [{ id: 'c2a', name: 'X', duration_seconds: 60 }] },
    { id: 'c3', name: 'Sunday review', trigger: 'ON_SCHEDULE', days_of_week: ['SUN'], start_time: '10:00', standalone_activities: [{ id: 'c3a', name: 'Y', duration_seconds: 60 }] },
  ],
};

test('dates and times of day', () => {
  const date = new Date(2026, 10, 21, 9, 5);
  assert.equal(dayKey(date), '2026-11-21');
  assert.equal(minutesOfDay(date), 545);
  assert.equal(parseTime('05:15'), 315);
  assert.equal(parseTime('20:30:00'), 1230);
  assert.equal(parseTime('7:05'), 425);
  assert.equal(parseTime('25:00', 1), 1);
  assert.equal(parseTime('soon'), null);
  assert.equal(parseTime(undefined, 300), 300);
  assert.equal(formatTime(545), '09:05');
  assert.equal(formatTime(0), '00:00');
  assert.equal(formatTime(1445), '00:05', 'wraps past midnight');
  assert.equal(formatTime(366.4), '06:06');
});

test('durations read naturally', () => {
  assert.equal(formatSpan(45), '45 sec');
  assert.equal(formatSpan(60), '1 min');
  assert.equal(formatSpan(300), '5 min');
  assert.equal(formatSpan(3600), '1 h');
  assert.equal(formatSpan(5400), '1 h 30 min');
  assert.equal(formatSpan('600'), '10 min', 'the API sends task durations as strings');
  assert.equal(formatSpan(undefined), '0 sec');
});

test('the timezone query value matches what the other apps send', () => {
  assert.equal(timezoneParam(660), 'UTC+11:00');
  assert.equal(timezoneParam(0), 'UTC+00:00');
  assert.equal(timezoneParam(-300), 'UTC-05:00');
  assert.equal(timezoneParam(330), 'UTC+05:30');
});

test('days_of_week: ALL, short and full names, and none meaning every day', () => {
  assert.equal(runsOnDay(['ALL'], SATURDAY), true);
  assert.equal(runsOnDay(['MON', 'SAT'], SATURDAY), true);
  assert.equal(runsOnDay(['Saturday'], SATURDAY), true);
  assert.equal(runsOnDay(['MON', 'TUE'], SATURDAY), false);
  assert.equal(runsOnDay([], SATURDAY), true);
  assert.equal(runsOnDay(undefined, SATURDAY), true);
});

test('done and skipped habit ids are collected from every routine in the progress response', () => {
  const ids = progressIds({
    morning_routine: { completed_habit_ids: ['m1'], skipped_habit_ids: ['m2'] },
    evening_routine: null,
    custom_routines: [{ id: 'c1', completed_habit_ids: ['c1a'], skipped_habit_ids: [] }],
    standalone_routines: [],
  });
  assert.deepEqual([...ids.done].sort(), ['c1a', 'm1']);
  assert.deepEqual([...ids.skipped], ['m2']);
  assert.equal(progressIds(null).done.size, 0);
});

test('the timeline lists routines in time order with each habit at its time', () => {
  const cards = buildTimeline({ settings: SETTINGS, progress: null, events: [], day: DAY, weekday: SATURDAY });
  assert.deepEqual(cards.map((c) => c.id), ['morning', 'custom-c1', 'evening']);

  const morning = cards[0];
  assert.equal(morning.title, 'Morning routine habits');
  assert.equal(timeRange(morning), '07:00–07:06');
  assert.deepEqual(morning.habits.map((h) => [h.name, timeRange(h)]), [
    ['Drink water', '07:00–07:01'],
    ['Stretch', '07:01–07:06'],
  ], 'the weekday-only habit is left out on Saturday');

  assert.equal(timeRange(cards[1]), '12:30–13:00', 'a scheduled routine keeps its scheduled end');
  assert.equal(timeRange(cards[2]), '20:30–20:35');
});

test('on-demand routines and routines for other days are not on the timeline', () => {
  const cards = buildTimeline({ settings: SETTINGS, events: [], day: DAY, weekday: SATURDAY });
  assert.equal(cards.some((c) => c.title === 'On demand' || c.title === 'Sunday review'), false);
  const sunday = buildTimeline({ settings: SETTINGS, events: [], day: '2026-11-22', weekday: 0 });
  assert.equal(sunday.some((c) => c.title === 'Sunday review'), true);
  assert.equal(sunday.some((c) => c.title === 'Lunch reset'), false);
});

test('default start and end of day are used when the account has none', () => {
  const cards = buildTimeline({
    settings: { morning_activities: [{ id: 'a', name: 'A', duration_seconds: 60 }], evening_activities: [{ id: 'b', name: 'B', duration_seconds: 60 }] },
    day: DAY,
    weekday: SATURDAY,
  });
  assert.equal(cards[0].start, 315); // 05:15
  assert.equal(cards[1].start, 1200); // 20:00
});

test('done and skipped habits are marked, and a finished routine says so', () => {
  const progress = { morning_routine: { completed_habit_ids: ['m1'], skipped_habit_ids: ['m2'] } };
  const [morning, , evening] = buildTimeline({ settings: SETTINGS, progress, events: [], day: DAY, weekday: SATURDAY });
  assert.equal(morning.habits[0].done, true);
  assert.equal(morning.habits[1].skipped, true);
  assert.equal(morning.allDone, true);
  assert.equal(evening.allDone, false);
});

test('an account with no habits has an empty timeline', () => {
  assert.deepEqual(buildTimeline({ settings: { morning_activities: [], evening_activities: [] }, day: DAY, weekday: SATURDAY }), []);
  assert.deepEqual(buildTimeline({ settings: null, day: DAY, weekday: SATURDAY }), []);
});

const EVENTS = [
  { external_id: 'g1', summary: 'Standup', event_begins: at('09:00'), event_ends: at('09:15') },
  { id: 'ms1', subject: 'Design review', start: { dateTime: at('14:00') }, end: { dateTime: at('15:00') } },
  { external_id: 'g1', summary: 'Standup (copy on a second calendar)', event_begins: at('09:00'), event_ends: at('09:15') },
  { external_id: 'allday', summary: 'Conference', event_begins: `${DAY}T00:00:00`, event_ends: '2026-11-22T00:00:00' },
  { external_id: 'tomorrow', summary: 'Tomorrow', event_begins: '2026-11-22T10:00:00', event_ends: '2026-11-22T11:00:00' },
  { external_id: 'broken', summary: 'No end', event_begins: at('10:00') },
  { external_id: 'backwards', event_begins: at('11:00'), event_ends: at('10:00') },
  null,
];

test('meetings come from Google and Microsoft shaped events; duplicates, all-day and other days are dropped', () => {
  const cards = meetingCards(EVENTS, DAY);
  assert.deepEqual(cards.map((c) => [c.title, timeRange(c)]), [
    ['Standup', '09:00–09:15'],
    ['Design review', '14:00–15:00'],
  ]);
  assert.equal(cards[0].kind, 'meeting');
  assert.deepEqual(meetingCards(null, DAY), []);
});

test('meetings sit between the routines by start time', () => {
  const cards = buildTimeline({ settings: SETTINGS, events: EVENTS, day: DAY, weekday: SATURDAY });
  assert.deepEqual(cards.map((c) => c.title), [
    'Morning routine habits',
    'Standup',
    'Lunch reset',
    'Design review',
    'Evening routine habits',
  ]);
});

test('today, finished meetings are hidden and the card that is on now is marked', () => {
  const cards = buildTimeline({ settings: SETTINGS, events: EVENTS, day: DAY, weekday: SATURDAY, nowMinutes: 14 * 60 + 30 });
  assert.equal(cards.some((c) => c.title === 'Standup'), false, 'the 09:00 meeting is over');
  const review = cards.find((c) => c.title === 'Design review');
  assert.equal(review.current, true);
  assert.equal(cards.find((c) => c.id === 'morning').past, true, 'routines stay, greyed');
  assert.equal(cards.find((c) => c.id === 'evening').current, false);
  assert.equal(cards.find((c) => c.id === 'evening').past, false);
});

test('a meeting that ends exactly now is over', () => {
  const cards = buildTimeline({ settings: {}, events: EVENTS, day: DAY, weekday: SATURDAY, nowMinutes: 15 * 60 });
  assert.deepEqual(cards, []);
});

const TASKS = [
  { id: 't1', title: 'Send the report', eisenhower_quadrant: 2, due_date: '2026-11-21T00:00:00.000Z', planned_date: '2026-11-21', duration: '1800', status: 'NOT_STARTED' },
  { id: 't2', title: 'Reply to the accountant', eisenhower_quadrant: 1, due_date: '2026-11-20T00:00:00.000Z', planned_date: null, duration: '600', status: 'NOT_STARTED' },
  { id: 't3', title: 'Plan the offsite', eisenhower_quadrant: 2, due_date: '2026-11-28T00:00:00.000Z', duration: '3600', status: 'NOT_STARTED' },
  { id: 't4', title: 'Someday', eisenhower_quadrant: 4, due_date: null, planned_date: null, status: 'NOT_STARTED' },
  { id: 't5', title: 'Done today', eisenhower_quadrant: 1, planned_date: '2026-11-21', duration: 300, status: 'COMPLETED' },
  { id: 't6', title: 'Done yesterday', eisenhower_quadrant: 1, due_date: '2026-11-20T00:00:00.000Z', status: 'COMPLETED' },
  { id: 't7', title: 'Due later but planned today', eisenhower_quadrant: 3, due_date: '2026-11-30T00:00:00.000Z', planned_date: '2026-11-21', status: 'NOT_STARTED' },
  { title: 'No id' },
  null,
];

test('a task belongs to its planned day, else its due date', () => {
  assert.equal(taskDay(TASKS[0]), '2026-11-21');
  assert.equal(taskDay(TASKS[1]), '2026-11-20');
  assert.equal(taskDay(TASKS[6]), '2026-11-21');
  assert.equal(taskDay(TASKS[3]), null);
  assert.equal(taskDay(null), null);
});

test('tasks for today: planned or due today plus overdue ones, unfinished and most important first', () => {
  const list = tasksForDay(TASKS, DAY);
  assert.deepEqual(list.map((t) => t.id), ['t2', 't1', 't7', 't5']);
  assert.equal(list[0].overdue, true);
  assert.equal(list[1].overdue, false);
  assert.equal(list[1].seconds, 1800);
  assert.equal(list[3].completed, true);
  assert.deepEqual(tasksForDay(null, DAY), []);
});

test('the estimate counts only unfinished tasks', () => {
  assert.equal(remainingTaskSeconds(tasksForDay(TASKS, DAY)), 600 + 1800);
  assert.equal(remainingTaskSeconds([]), 0);
});

test('ticking a task sends the upsert body with its title and quadrant', () => {
  const [task] = tasksForDay(TASKS, DAY);
  assert.deepEqual(taskStatusBody(task, true), {
    id: 't2',
    title: 'Reply to the accountant',
    eisenhower_quadrant: 1,
    status: 'COMPLETED',
  });
  assert.equal(taskStatusBody(task, false).status, 'NOT_STARTED');
  assert.equal(isCompleted({ status: 'COMPLETED' }), true);
  assert.equal(isCompleted({ status: 'IN_PROGRESS' }), false);
});

test('a new task is planned and due on the day, 10 minutes by default', () => {
  assert.deepEqual(newTaskBody('  Call the bank ', DAY), {
    title: 'Call the bank',
    eisenhower_quadrant: 1,
    due_date: DAY,
    planned_date: DAY,
    duration: 600,
  });
  assert.equal(newTaskBody('   ', DAY), null);
  assert.equal(newTaskBody('x'.repeat(400), DAY).title.length, 255);
});

test('the header shows the day', () => {
  assert.equal(formatDay(new Date(2026, 10, 21)), 'Sat 21 Nov');
});

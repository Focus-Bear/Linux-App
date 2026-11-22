import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTimeline,
  dateDay,
  dayKey,
  formatDay,
  formatSpan,
  formatTime,
  isCompleted,
  meetingCards,
  minutesOfDay,
  newTaskBody,
  overridesAfterLoad,
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

test('a task belongs to its due date, else its planned day', () => {
  assert.equal(taskDay(TASKS[0]), '2026-11-21');
  assert.equal(taskDay(TASKS[1]), '2026-11-20');
  assert.equal(taskDay(TASKS[4]), '2026-11-21', 'planned only');
  assert.equal(taskDay(TASKS[6]), '2026-11-30', 'filed by due date, as on Windows: planned_date lags behind edits');
  assert.equal(taskDay(TASKS[3]), null);
  assert.equal(taskDay(null), null);
});

// A stand-in for a PC in another timezone: the local day of an instant at a fixed UTC offset.
const zone = (minutesEast) => (date) => new Date(date.getTime() + minutesEast * 60000).toISOString().slice(0, 10);
const SYDNEY = zone(11 * 60); // UTC+11
const LOS_ANGELES = zone(-8 * 60); // UTC-8

test('a due date with a time part means the local day it falls on (UTC+11 and UTC-8)', () => {
  // Due 23 Nov in Sydney, stored as local midnight: 13:00Z on the 22nd.
  const sydneyTask = { id: 's', due_date: '2026-11-22T13:00:00.000Z' };
  assert.equal(taskDay(sydneyTask, SYDNEY), '2026-11-23');
  assert.equal(taskDay(sydneyTask, LOS_ANGELES), '2026-11-22');
  // Due 22 Nov in Los Angeles at 23:59 local: already the 23rd in UTC.
  const lateTask = { id: 'l', due_date: '2026-11-23T07:59:00.000Z' };
  assert.equal(taskDay(lateTask, LOS_ANGELES), '2026-11-22');
  assert.equal(taskDay({ id: 'm', due_date: '2026-11-23T08:00:00Z' }, LOS_ANGELES), '2026-11-23');
  assert.equal(taskDay(lateTask, SYDNEY), '2026-11-23');
});

test('a plain day, and the midnight-UTC instant the server makes of one, is that day in every zone', () => {
  for (const toLocalDay of [SYDNEY, LOS_ANGELES]) {
    assert.equal(dateDay('2026-11-23', toLocalDay), '2026-11-23');
    // PUT /to-do with due_date '2026-11-23' comes back like this (timestamptz column).
    assert.equal(dateDay('2026-11-23T00:00:00.000Z', toLocalDay), '2026-11-23');
    assert.equal(taskDay({ planned_date: '2026-11-23' }, toLocalDay), '2026-11-23');
  }
  assert.equal(dateDay('', SYDNEY), null);
  assert.equal(dateDay(null, SYDNEY), null);
  assert.equal(dateDay('next week', SYDNEY), null);
  assert.equal(dateDay('2026-13-45T99:00:00Z', SYDNEY), null);
});

test('in Sydney a task due tomorrow is not listed today, and is not overdue tomorrow', () => {
  const tasks = [{ id: 's', title: 'Due on the 23rd', due_date: '2026-11-22T13:00:00.000Z', status: 'NOT_STARTED' }];
  const options = { toLocalDay: SYDNEY };
  assert.deepEqual(tasksForDay(tasks, '2026-11-22', '2026-11-22', options), []);
  const [listed] = tasksForDay(tasks, '2026-11-23', '2026-11-23', options);
  assert.equal(listed.id, 's');
  assert.equal(listed.overdue, false);
  // In Los Angeles the same instant is the 22nd.
  assert.equal(tasksForDay(tasks, '2026-11-22', '2026-11-22', { toLocalDay: LOS_ANGELES }).length, 1);
});

test('tasks for today: planned or due today plus overdue ones, unfinished and most important first', () => {
  const list = tasksForDay(TASKS, DAY);
  assert.deepEqual(list.map((t) => t.id), ['t2', 't1', 't5']);
  assert.equal(list[0].overdue, true);
  assert.equal(list[1].overdue, false);
  assert.equal(list[1].seconds, 1800);
  assert.equal(list[2].completed, true);
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

test('un-ticking gives a task back the status it had; ticks made here show over the loaded list', () => {
  const raw = [
    { id: 'p', title: 'Half done', eisenhower_quadrant: 3, due_date: DAY, status: 'IN_PROGRESS' },
    { id: 'c', title: 'Was completed', eisenhower_quadrant: 2, due_date: DAY, status: 'COMPLETED' },
  ];
  const ticked = tasksForDay(raw, DAY, DAY, { overrides: { p: true, c: false } });
  const half = ticked.find((task) => task.id === 'p');
  assert.equal(half.completed, true, 'ticked here');
  assert.deepEqual(taskStatusBody(half, false), { id: 'p', title: 'Half done', eisenhower_quadrant: 3, status: 'IN_PROGRESS' });
  const reopened = ticked.find((task) => task.id === 'c');
  assert.equal(reopened.completed, false, 'un-ticked here');
  assert.equal(taskStatusBody(reopened, false).status, 'NOT_STARTED');
  assert.equal(taskStatusBody(reopened, true).status, 'COMPLETED');
  // An overdue task ticked here leaves today's list like any completed overdue task.
  const overdue = [{ id: 'o', title: 'Old', due_date: '2026-11-19', status: 'NOT_STARTED' }];
  assert.equal(tasksForDay(overdue, DAY, DAY).length, 1);
  assert.equal(tasksForDay(overdue, DAY, DAY, { overrides: { o: true } }).length, 0);
});

test('after a reload only the ticks it could not know about are kept', () => {
  const overrides = { before: true, during: true, saving: false };
  const savedAt = { before: 1000, during: 2500, saving: Infinity };
  // The reload was asked for at 2000: `before` is in its answer, the others may not be.
  assert.deepEqual(overridesAfterLoad(overrides, savedAt, 2000), { during: true, saving: false });
  assert.deepEqual(overridesAfterLoad({ stray: true }, {}, 2000), {});
  assert.deepEqual(overridesAfterLoad(null, null, 0), {});
});

test('a meeting that began before midnight and is still running starts the day at 00:00', () => {
  const events = [{ id: 'late', summary: 'Release night', event_begins: '2026-11-20T23:30:00', event_ends: `${DAY}T00:45:00` }];
  const [today] = meetingCards(events, DAY);
  assert.equal(timeRange(today), '00:00–00:45');
  const [yesterday] = meetingCards(events, '2026-11-20');
  assert.equal(timeRange(yesterday), '23:30–00:45');
  assert.deepEqual(meetingCards(events, '2026-11-22'), []);
  // It is "on now" at 00:10 and gone from today's list once over.
  const at = (nowMinutes) => buildTimeline({ settings: {}, events, day: DAY, weekday: SATURDAY, nowMinutes });
  assert.equal(at(10)[0].current, true);
  assert.deepEqual(at(50), []);
});

test('a custom routine skipped for today is read from the progress by its sequence id', () => {
  const settings = {
    custom_routines: [
      { id: 'c1', name: 'Lunch reset', start_time: '12:30', activity_sequence_id: 'seq-c1', standalone_activities: [{ id: 'walk', name: 'Walk', duration_seconds: 600, activity_sequence_id: 'seq-c1' }] },
      // An older answer without the routine's own sequence id: the habits carry it.
      { id: 'c2', name: 'Afternoon', start_time: '15:00', standalone_activities: [{ id: 'tea', name: 'Tea', duration_seconds: 300, activity_sequence_id: 'seq-c2' }] },
      { id: 'c3', name: 'No sequence', start_time: '17:00', standalone_activities: [{ id: 'x', name: 'X', duration_seconds: 300 }] },
    ],
  };
  // The shape of GET /completed-activity-sequence/routine-progress (TodayRoutineProgress).
  const progress = {
    morning_routine: null,
    evening_routine: null,
    custom_routines: [
      { sequence_id: 'seq-c1', status: 'completed', completed_habit_ids: [], skipped_habit_ids: [], was_force_completed: true },
      { sequence_id: 'seq-c2', status: 'postponed', completed_habit_ids: [], skipped_habit_ids: [] },
    ],
    standalone_routines: [],
  };
  const cards = buildTimeline({ settings, progress, events: [], day: DAY, weekday: SATURDAY });
  assert.deepEqual(cards.map((c) => [c.title, c.sequenceId, c.cancelled]), [
    ['Lunch reset', 'seq-c1', true],
    ['Afternoon', 'seq-c2', false],
    ['No sequence', '', false],
  ]);
  const plain = buildTimeline({ settings, progress: null, events: [], day: DAY, weekday: SATURDAY });
  assert.equal(plain[0].cancelled, false);
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

test('a skipped habit is not done, although the server lists it under completed too', () => {
  const progress = { morning_routine: { completed_habit_ids: ['a', 'b'], skipped_habit_ids: ['b'] } };
  const ids = progressIds(progress);
  assert.deepEqual([...ids.done], ['a']);
  assert.deepEqual([...ids.skipped], ['b']);
});

test('what was just done in this app shows before the server reports it', () => {
  const progress = { morning_routine: { completed_habit_ids: ['a', 'b', 'c'], skipped_habit_ids: ['b', 'c'] } };
  const ids = progressIds(progress, { c: 'done', d: 'skipped', e: 'done', a: 'skipped' });
  assert.deepEqual([...ids.done].sort(), ['c', 'e']);
  assert.deepEqual([...ids.skipped].sort(), ['a', 'b', 'd']);
});

test('habit rows carry what is needed to report them, and cards count what is left', () => {
  const settings = {
    startup_time: '07:00',
    morning_activities: [
      { id: 'm1', name: 'Water', duration_seconds: 60, activity_sequence_id: 'seq-m', completion_requirements: ' Glass is empty ' },
      { id: 'm2', name: 'Stretch', duration_seconds: 300, activity_sequence_id: 'seq-m' },
    ],
  };
  const [card] = buildTimeline({ settings, progress: null, events: [], day: DAY, weekday: SATURDAY, local: { m1: 'done' } });
  assert.equal(card.habits[0].sequenceId, 'seq-m');
  assert.equal(card.habits[0].requirements, 'Glass is empty');
  assert.equal(card.habits[1].requirements, '');
  assert.equal(card.habits[0].done, true);
  assert.equal(card.openCount, 1);
  assert.equal(card.allDone, false);
});

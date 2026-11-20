// Day Plan: other days, focus blocks, own events, log quantity, routine skip / postpone (#140, #160).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayLabel,
  defaultEventEnd,
  eventBody,
  eventError,
  focusBlockNote,
  focusBlocks,
  habitQuestions,
  isPostponed,
  postponeEntry,
  postponeLabel,
  quantityAnswers,
  quantityError,
  readPostpone,
  routineBody,
  routineState,
  shiftDay,
} from './dayPlanExtras.js';
import { buildTimeline, tasksForDay } from './dayPlanModel.js';
import { createDayPlanApi } from './dayPlanApiCore.js';
import { completedBody } from './habitApiCore.js';

const DAY = '2026-11-21';

// --- days -----------------------------------------------------------------------

test('moving between days crosses months and years', () => {
  assert.equal(shiftDay('2026-11-30', 1), '2026-12-01');
  assert.equal(shiftDay('2027-01-01', -1), '2026-12-31');
  assert.equal(shiftDay(DAY, 0), DAY);
});

test('the day is named Today, Tomorrow or Yesterday next to its date', () => {
  assert.equal(dayLabel(DAY, DAY), 'Today · Sat 21 Nov');
  assert.equal(dayLabel('2026-11-22', DAY), 'Tomorrow · Sun 22 Nov');
  assert.equal(dayLabel('2026-11-20', DAY), 'Yesterday · Fri 20 Nov');
  assert.equal(dayLabel('2026-11-25', DAY), 'Wed 25 Nov');
});

test('another day shows its own tasks only; overdue tasks move to today', () => {
  const tasks = [
    { id: 'old', title: 'Old', due_date: '2026-11-19' },
    { id: 'today', title: 'Today', planned_date: DAY },
    { id: 'tomorrow', title: 'Tomorrow', due_date: '2026-11-22T00:00:00.000Z' },
  ];
  assert.deepEqual(tasksForDay(tasks, DAY).map((task) => task.id), ['old', 'today']);
  assert.deepEqual(tasksForDay(tasks, '2026-11-22', DAY).map((task) => task.id), ['tomorrow']);
  assert.deepEqual(tasksForDay(tasks, '2026-11-20', DAY).map((task) => task.id), []);
});

// --- focus blocks ---------------------------------------------------------------

const card = (id, start, end) => ({ id, kind: 'x', start, end });

test('free time between cards becomes focus blocks; short gaps do not', () => {
  const blocks = focusBlocks([card('evening', 1230, 1255), card('morning', 315, 331), card('lunch', 720, 780), card('call', 790, 820)]);
  assert.deepEqual(blocks.map((block) => [block.start, block.end]), [[331, 720], [820, 1230]]);
  assert.equal(blocks[0].kind, 'focus');
  assert.equal(blocks[0].minutes, 389);
  assert.deepEqual(focusBlocks([card('only', 300, 330)]), []);
});

test('for today a focus block starts now, and time that has gone is left out', () => {
  const cards = [card('morning', 315, 331), card('lunch', 720, 780), card('evening', 1230, 1255)];
  const blocks = focusBlocks(cards, { nowMinutes: 600, breakMinutes: 25 });
  assert.deepEqual(blocks.map((block) => [block.start, block.end]), [[600, 720], [780, 1230]]);
  assert.equal(focusBlockNote(blocks[0]), '2 h free · a break every 25 min');
  assert.equal(focusBlockNote(focusBlocks(cards)[0]), '6 h 29 min free');
  assert.deepEqual(focusBlocks(cards, { nowMinutes: 1225 }), []);
});

test('overlapping cards do not produce a block inside the overlap', () => {
  const blocks = focusBlocks([card('a', 300, 600), card('b', 400, 450), card('c', 700, 730)]);
  assert.deepEqual(blocks.map((block) => [block.start, block.end]), [[600, 700]]);
});

const SETTINGS = {
  startup_time: '05:15',
  shutdown_time: '20:30',
  morning_activities: [{ id: 'm1', name: 'Stretch', duration_seconds: 600, activity_sequence_id: 'seq-m' }],
  evening_activities: [
    {
      id: 'e1',
      name: 'Read a book',
      duration_seconds: 1200,
      activity_sequence_id: 'seq-e',
      log_quantity: true,
      log_quantity_questions: [{ id: 'q1', question: 'How many pages did you read?', min_value: 0, max_value: 200 }],
    },
  ],
};

test('the timeline carries own events, focus blocks and the questions of a habit', () => {
  const planEvents = [{ id: 'ev1', title: 'Dentist', event_begins: new Date(2026, 10, 21, 15, 0).toISOString(), event_ends: new Date(2026, 10, 21, 15, 45).toISOString(), external_id: 'linux:1' }];
  const cards = buildTimeline({ settings: SETTINGS, progress: null, events: [], planEvents, day: DAY, weekday: 6, withFocusBlocks: true });
  assert.deepEqual(cards.map((item) => item.kind), ['morning', 'focus', 'event', 'focus', 'evening']);
  const event = cards.find((item) => item.kind === 'event');
  assert.equal(event.title, 'Dentist');
  assert.equal(event.sourceId, 'ev1');
  assert.equal(cards[4].habits[0].questions[0].text, 'How many pages did you read?');
  const plain = buildTimeline({ settings: SETTINGS, progress: null, events: [], day: DAY, weekday: 6 });
  assert.deepEqual(plain.map((item) => item.kind), ['morning', 'evening']);
});

// --- events ---------------------------------------------------------------------

test('an event needs a name and an end after its start', () => {
  assert.equal(eventError({ title: ' ', start: '09:00', end: '10:00' }), 'Give the event a name.');
  assert.match(eventError({ title: 'Dentist', start: '', end: '10:00' }), /start and an end/);
  assert.match(eventError({ title: 'Dentist', start: '10:00', end: '10:00' }), /after the start/);
  assert.equal(eventError({ title: 'Dentist', start: '09:00', end: '09:45' }), null);
  assert.equal(defaultEventEnd('09:30'), '10:30');
  assert.equal(defaultEventEnd('23:30'), '23:59');
});

test('an event is sent with local times, the timezone and a linux: external id', () => {
  assert.deepEqual(eventBody({ title: ' Dentist ', start: '15:00', end: '15:45' }, DAY, 'Australia/Melbourne', 'abc'), {
    events: [
      {
        title: 'Dentist',
        dtstart_local: '2026-11-21T15:00:00',
        dtend_local: '2026-11-21T15:45:00',
        timezone: 'Australia/Melbourne',
        external_id: 'linux:abc',
      },
    ],
  });
});

// --- log quantity ---------------------------------------------------------------

test('a habit asks its questions only when log quantity is on', () => {
  const questions = habitQuestions(SETTINGS.evening_activities[0]);
  assert.deepEqual(questions, [{ id: 'q1', text: 'How many pages did you read?', min: 0, max: 200, minLabel: '', maxLabel: '' }]);
  assert.deepEqual(habitQuestions({ ...SETTINGS.evening_activities[0], log_quantity: false }), []);
  assert.deepEqual(habitQuestions(SETTINGS.morning_activities[0]), []);
});

test('answers must be numbers within the range; empty answers are left out', () => {
  const [question] = habitQuestions(SETTINGS.evening_activities[0]);
  assert.equal(quantityError(question, ''), null);
  assert.equal(quantityError(question, '12'), null);
  assert.equal(quantityError(question, 'lots'), 'Type a number.');
  assert.equal(quantityError(question, '-1'), 'Use 0 or more.');
  assert.equal(quantityError(question, '201'), 'Use 200 or less.');
  assert.deepEqual(quantityAnswers([question], { q1: ' 12.5 ' }), [{ question_id: 'q1', logged_value: 12.5 }]);
  assert.deepEqual(quantityAnswers([question], { q1: '' }), []);
  assert.deepEqual(quantityAnswers([question], { q1: '999' }), []);
});

test('answers go into the completed-activity body; without answers the field is absent', () => {
  const habit = { id: 'e1', sequenceId: 'seq-e' };
  const timing = { startMs: 0, finishMs: 1000, seconds: 1 };
  const withAnswers = completedBody(habit, 'dev', { ...timing, answers: [{ question_id: 'q1', logged_value: 12 }] });
  assert.deepEqual(withAnswers.log_quantity_answers, [{ question_id: 'q1', logged_value: 12 }]);
  assert.equal('log_quantity_answers' in completedBody(habit, 'dev', timing), false);
});

// --- skip / postpone ------------------------------------------------------------

test('a routine skipped for today is read from the progress, with its sequence id', () => {
  const progress = { morning_routine: { sequence_id: 'seq-m', was_force_completed: true }, evening_routine: { sequence_id: 'seq-e', was_force_completed: false } };
  assert.deepEqual(routineState(progress, 'morning'), { sequenceId: 'seq-m', cancelled: true });
  assert.deepEqual(routineState(progress, 'evening'), { sequenceId: 'seq-e', cancelled: false });
  assert.deepEqual(routineState(null, 'morning'), { sequenceId: '', cancelled: false });
  const cards = buildTimeline({ settings: SETTINGS, progress, events: [], day: DAY, weekday: 6 });
  assert.equal(cards[0].cancelled, true);
  assert.equal(cards[1].cancelled, false);
  assert.deepEqual(routineBody(), { operating_system: 'Web', metadata: {} });
});

test('postponing remembers the routine until the time comes, for today only', () => {
  const now = new Date(2026, 10, 21, 9, 0).getTime();
  const entry = postponeEntry({ id: 'morning', title: 'Morning routine habits' }, 30, now);
  assert.equal(entry.until, now + 30 * 60000);
  assert.equal(isPostponed(entry, 'morning', now + 29 * 60000), true);
  assert.equal(isPostponed(entry, 'morning', now + 30 * 60000), false);
  assert.equal(isPostponed(entry, 'evening', now), false);
  assert.equal(postponeLabel(entry), 'Postponed until 09:30');
  assert.deepEqual(readPostpone(JSON.stringify(entry), now), entry);
  assert.equal(readPostpone(JSON.stringify(entry), now + 24 * 3600000), null);
  assert.equal(readPostpone('{broken', now), null);
  assert.equal(readPostpone(null, now), null);
});

// --- API ------------------------------------------------------------------------

test('events, routine skip and its undo use the Windows paths; a DELETE sends no Content-Type', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ line: `${init.method} ${url.replace('https://api.test', '')}`, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const body = url.includes('/event-series/') ? { events: [{ id: 's1' }] } : url.includes('/events/day/') ? { events: [{ id: 'e1' }] } : { events: [{ id: 'new' }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const api = createDayPlanApi({ fetch, getToken: async () => 'tok', baseUrl: 'https://api.test' });
  assert.deepEqual(await api.getPlanEvents(DAY), [{ id: 'e1' }, { id: 's1', is_series: true }]);
  assert.deepEqual(await api.addEvent({ title: 'Dentist', start: '15:00', end: '15:45' }, DAY, 'UTC', 'abc'), { id: 'new' });
  await api.deleteEvent('e1');
  await api.skipRoutine('seq-m');
  await api.undoSkipRoutine('seq-m');
  assert.deepEqual(calls.map((call) => call.line), [
    `GET /day-plan/events/day/${DAY}`,
    `GET /day-plan/event-series/day/${DAY}`,
    'POST /day-plan/events',
    'DELETE /day-plan/events/e1',
    'POST /completed-activity-sequence/seq-m/force-complete-current-sequence?cancel_habits_for_today=true',
    'POST /completed-activity-sequence/seq-m/uncomplete',
  ]);
  assert.equal('Content-Type' in calls[3].headers, false);
  assert.equal(calls[2].headers['Content-Type'], 'application/json');
  assert.deepEqual(calls[4].body, { operating_system: 'Web', metadata: {} });
});

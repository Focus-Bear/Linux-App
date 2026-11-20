// Task queue, strictness levels and untimed sessions (#141).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STOP_CODE_LENGTH,
  UNTIMED_MINUTES,
  activeTask,
  adjustSession,
  canPause,
  candidateTasks,
  clockMs,
  completeTask,
  createSession,
  defaultStrictness,
  doneTasks,
  endSession,
  finishBody,
  hasStopFriction,
  makeStopCode,
  needsStopCode,
  pauseSession,
  playTask,
  remainingMs,
  sessionQueue,
  startBody,
  stopCodeMatches,
  stopDelaySeconds,
  taskDoneBody,
} from './focusSessionModel.js';
import { trayFocusView } from './trayModel.js';
import { createFocusApi } from '../services/focusApiCore.js';
import { createToolsApi } from '../services/toolsApiCore.js';

const T0 = Date.UTC(2026, 10, 21, 9, 0, 0);
const MIN = 60 * 1000;
const TASKS = [
  { id: 't1', title: 'Write the report', status: 'IN_PROGRESS', duration: '1800', icon: '📝', eisenhower_quadrant: 2 },
  { id: 't2', title: 'Reply to Sam', status: 'NOT_STARTED' },
  { id: 't3', title: 'Book flights', status: 'NOT_STARTED', duration: 0 },
];

// --- strictness -----------------------------------------------------------------

test('the strictness offered first: the last one picked, else Junior (Cuddly) or Pawfessor (Grizzly)', () => {
  assert.equal(defaultStrictness('captain', 'grizzly'), 'captain');
  assert.equal(defaultStrictness('', 'cuddly'), 'junior');
  assert.equal(defaultStrictness(null, 'grizzly'), 'pawfessor');
  assert.equal(defaultStrictness('nonsense', undefined), 'junior');
});

test('the level is sent to the server as block_level; no level, no field', () => {
  const make = (strictness) => startBody(createSession({ modeId: 'm', minutes: 25, now: T0, strictness }));
  assert.equal(make('junior').block_level, 'gentle');
  assert.equal(make('captain').block_level, 'strict');
  assert.equal(make('pawfessor').block_level, 'super-strict');
  assert.equal('block_level' in make(null), false);
  assert.equal(createSession({ minutes: 25, now: T0, strictness: 'nonsense' }).strictness, null);
});

test('Junior stops at once, Captain waits 15 seconds, Pawfessor needs the characters and cannot pause', () => {
  const session = (strictness) => createSession({ minutes: 25, now: T0, strictness });
  assert.equal(stopDelaySeconds(session('junior')), 0);
  assert.equal(hasStopFriction(session('junior')), false);
  assert.equal(stopDelaySeconds(session('captain')), 15);
  assert.equal(needsStopCode(session('captain')), false);
  assert.equal(hasStopFriction(session('captain')), true);
  assert.equal(needsStopCode(session('pawfessor')), true);
  assert.equal(canPause(session('pawfessor')), false);
  assert.equal(canPause(session('captain')), true);

  // The pause is refused in the model, so the tray can't pause a Pawfessor session either.
  const strict = session('pawfessor');
  assert.equal(pauseSession(strict, T0 + MIN), strict);
  assert.equal(pauseSession(session('captain'), T0 + MIN).status, 'paused');
  assert.equal(trayFocusView(strict, T0 + MIN).pauseLabel, null);
  assert.equal(trayFocusView(session('junior'), T0 + MIN).pauseLabel, 'Pause Focus Session');
});

test('the characters to type: random, the right length, matched exactly', () => {
  let n = 0;
  const code = makeStopCode(() => (n++ % 10) / 10);
  assert.equal(code.length, STOP_CODE_LENGTH);
  assert.notEqual(makeStopCode(() => 0.5), makeStopCode(() => 0.1));
  assert.ok(!/[0O1lI]/.test(makeStopCode())); // no look-alike characters
  assert.equal(stopCodeMatches(code, ` ${code} `), true);
  assert.equal(stopCodeMatches(code, code.toLowerCase()), code === code.toLowerCase());
  assert.equal(stopCodeMatches('', ''), false);
});

// --- untimed --------------------------------------------------------------------

test('an untimed session is a 12 hour session whose clock counts up', () => {
  const session = createSession({ minutes: 25, now: T0, untimed: true });
  assert.equal(session.untimed, true);
  assert.equal(session.plannedMinutes, UNTIMED_MINUTES);
  assert.equal(session.finishTime, T0 + 12 * 60 * MIN);
  assert.equal(clockMs(session, T0 + 7 * MIN), 7 * MIN);
  assert.equal(startBody(session).finish_time, '2026-11-21T21:00:00.000Z');
  // −5 / +5 mean nothing without an end time
  assert.equal(adjustSession(session, 5, T0 + MIN), session);

  const timed = createSession({ minutes: 25, now: T0 });
  assert.equal(clockMs(timed, T0 + 7 * MIN), remainingMs(timed, T0 + 7 * MIN));
});

test('ending an untimed session reports the time it actually ran', () => {
  const ended = endSession(createSession({ minutes: 25, now: T0, untimed: true }), T0 + 42 * MIN);
  const body = finishBody(ended);
  assert.equal(body.finish_time, '2026-11-21T09:42:00.000Z');
  assert.equal(body.metadata.focus_duration_seconds, 42 * 60);
});

test('the tray shows an untimed session without a countdown', () => {
  const view = trayFocusView(createSession({ minutes: 25, now: T0, untimed: true, intention: 'Deep work' }), T0 + 65 * 1000);
  assert.equal(view.title, 'Focusing · 01:05');
  assert.equal(view.subtitle, 'no end time · Deep work');
});

// --- task queue -----------------------------------------------------------------

test('the queue keeps the chosen order, flags the first task and fills in a length', () => {
  const queue = sessionQueue([...TASKS, TASKS[0], null]);
  assert.deepEqual(queue.map((row) => row.id), ['t1', 't2', 't3']);
  assert.deepEqual(queue.map((row) => row.isPlaying), [true, false, false]);
  assert.equal(queue[0].duration, 1800);
  assert.equal(queue[2].duration, 25 * 60);
  assert.equal(queue[0].icon, '📝');
  assert.equal(activeTask(queue).id, 't1');
  assert.deepEqual(sessionQueue(null), []);
});

test('finishing a task marks it COMPLETED and moves on to the next unfinished one', () => {
  let queue = completeTask(sessionQueue(TASKS), 't1');
  assert.equal(queue[0].status, 'COMPLETED');
  assert.equal(activeTask(queue).id, 't2');
  queue = playTask(queue, 't3');
  assert.equal(activeTask(queue).id, 't3');
  assert.equal(playTask(queue, 't1'), queue); // a finished task can't be picked again
  queue = completeTask(queue, 't3');
  assert.equal(activeTask(queue).id, 't2');
  queue = completeTask(queue, 't2');
  assert.equal(activeTask(queue), null);
  assert.deepEqual(doneTasks(queue).map((row) => row.id), ['t1', 't2', 't3']);
});

test('the queue goes to the server at the start, and the finished tasks at the end', () => {
  const queue = sessionQueue(TASKS);
  const session = createSession({ modeId: 'm', minutes: 25, now: T0, tasks: queue, intention: 'Write the report' });
  assert.deepEqual(startBody(session).to_dos.map((row) => row.id), ['t1', 't2', 't3']);
  assert.equal(startBody(session).to_dos[0].isPlaying, true);
  const ended = endSession({ ...session, tasks: completeTask(queue, 't1') }, T0 + 10 * MIN);
  assert.deepEqual(finishBody(ended).to_dos.map((row) => `${row.id}:${row.status}`), ['t1:COMPLETED']);
  assert.deepEqual(taskDoneBody(queue[0]), { id: 't1', title: 'Write the report', eisenhower_quadrant: 2, status: 'COMPLETED' });
});

test('tasks to pick from: in progress first, no duplicates, nothing finished', () => {
  const list = candidateTasks([{ id: 'a' }, { id: 'done', status: 'COMPLETED' }], [{ id: 'b' }, { id: 'a' }]);
  assert.deepEqual(list.map((task) => task.id), ['a', 'b']);
});

// --- API ------------------------------------------------------------------------

test('the start screen reads in-progress and not-started to-dos, searches, creates and completes', async () => {
  const urls = [];
  const fetch = async (url, init) => {
    urls.push(`${init.method} ${url.replace('https://api.test', '')}`);
    const body = url.includes('IN_PROGRESS') ? { data: [{ id: 'a' }] } : url.includes('NOT_STARTED') ? { data: [{ id: 'b' }] } : [{ id: 'c' }];
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const api = createFocusApi({ fetch, getToken: async () => 'token', baseUrl: 'https://api.test' });
  assert.deepEqual((await api.getCandidateTasks()).map((task) => task.id), ['a', 'b']);
  assert.deepEqual((await api.searchTasks('re port')).map((task) => task.id), ['c']);
  await api.createTask({ title: 'New' });
  await api.completeTask({ id: 't1', title: 'T', eisenhower_quadrant: 1 });
  assert.deepEqual(urls, [
    'GET /to-do?page=1&take=20&order=DESC&sort_mode=SMART&status=IN_PROGRESS',
    'GET /to-do?page=1&take=20&order=DESC&sort_mode=SMART&status=NOT_STARTED',
    'GET /to-do/search?title=re%20port&take=10',
    'PUT /to-do',
    'PUT /to-do',
  ]);
});

test('the brain dump box adds to the end of the Brain Dump note, or creates it', async () => {
  const calls = [];
  const make = (notes) =>
    createToolsApi({
      request: async (method, path, body) => {
        calls.push({ method, path, body });
        return method === 'GET' ? { data: notes } : body;
      },
    });
  await make([{ id: 'n1' }, { id: 'd1', title: 'Brain Dump', body: '<p>old</p>', is_brain_dump: true }]).appendBrainDump(' call the bank ');
  assert.deepEqual(calls[1].body, { title: 'Brain Dump', body: '<p>old</p><p>call the bank</p>', id: 'd1', is_brain_dump: true });
  calls.length = 0;
  await make([]).appendBrainDump('first thought');
  assert.deepEqual(calls[1].body, { title: 'Brain Dump', body: '<p>first thought</p>', is_brain_dump: true });
  calls.length = 0;
  assert.equal(await make([]).appendBrainDump('   '), null);
  assert.equal(calls.length, 0);
});

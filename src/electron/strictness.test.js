// Strictness enforced in the main process (focusSessionController.js), the
// finish outbox, and untimed sessions left running. Fake clock and timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AWAY_MS, HEARTBEAT_MS, PERMIT_LIFETIME_MS, createFocusSessionController } from './focusSessionController.js';
import { DONE_QUIET_MS, canFinishTask, remainingMs } from './focusSessionModel.js';
import { createFinishOutbox, isPermanent } from '../services/finishOutboxCore.js';

const T0 = Date.UTC(2026, 10, 22, 9, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;

function setup(input = {}) {
  const c = { t: T0, timers: [] };
  const disk = { value: null };
  const ended = [];
  const controller = createFocusSessionController({
    now: () => c.t,
    setTimer: (fn, ms) => {
      const timer = { fn, at: c.t + ms, cancelled: false };
      c.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cancelled = true;
    },
    load: async () => disk.value,
    save: async (session) => {
      disk.value = session;
    },
    remove: async () => {
      disk.value = null;
    },
    onTimeUp: (session) => ended.push(session),
    random: () => 0.5,
  });
  /** Moves the clock, running the timers that come due on the way. */
  const advance = (ms) => {
    const until = c.t + ms;
    for (;;) {
      const due = c.timers.filter((timer) => !timer.cancelled && timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.cancelled = true;
      c.t = Math.max(c.t, due.at); // a timer that was due during a sleep fires late, not in the past
      due.fn();
    }
    c.t = until;
  };
  /** The computer sleeps: the clock jumps, no timer runs meanwhile. */
  const sleep = (ms) => {
    c.t += ms;
  };
  controller.signedIn('auth0|a');
  if (input.strictness !== undefined) {
    controller.start({ modeId: 'm', modeName: 'Study', minutes: 25, synced: true, ...input });
  }
  return { c, disk, ended, controller, advance, sleep };
}

const left = (controller, c) => Math.round(remainingMs(controller.get(), c.t) / MINUTE);

// --- Captain -------------------------------------------------------------------

test('Captain: "− 5 min" is refused without the 15-second wait (the live bypass)', () => {
  const { controller, c, advance } = setup({ strictness: 'captain', minutes: 5 });
  // What the old window did: call adjust straight away. Five clicks took a session to one minute.
  controller.adjust(-5);
  controller.adjust(-5);
  assert.equal(left(controller, c), 5, 'nothing was taken off');

  // The wait has to be asked for and has to run in this process.
  const terms = controller.requestStop('reduce');
  assert.equal(terms.waitSeconds, 15);
  assert.equal(terms.readyAt, T0 + 15 * SECOND);
  advance(10 * SECOND);
  controller.adjust(-2);
  assert.equal(left(controller, c), 5, 'still refused after 10 seconds');
  advance(5 * SECOND);
  controller.adjust(-2);
  assert.equal(Math.round(remainingMs(controller.get(), c.t) / SECOND), 165, 'two minutes off after the wait');
  // One wait, one use.
  controller.adjust(-1);
  assert.equal(Math.round(remainingMs(controller.get(), c.t) / SECOND), 165);
  // Adding time needs no wait.
  controller.adjust(5);
  assert.equal(Math.round(remainingMs(controller.get(), c.t) / SECOND), 465);
});

test('Captain: pause and end are refused until their own wait has run', () => {
  const { controller, advance } = setup({ strictness: 'captain' });
  assert.equal(controller.pause().status, 'running');
  assert.equal(controller.end().status, 'running');

  controller.requestStop('pause');
  advance(15 * SECOND);
  assert.equal(controller.end().status, 'running', 'a wait asked for pausing does not end the session');
  assert.equal(controller.pause().status, 'paused');
  assert.equal(controller.resume().status, 'running');

  controller.requestStop('end');
  advance(14 * SECOND);
  assert.equal(controller.end().status, 'running');
  advance(1 * SECOND);
  assert.equal(controller.end().status, 'ended');
});

test('Captain: "Keep going" cancels the wait, and a wait left lying around runs out', () => {
  const cancelled = setup({ strictness: 'captain' });
  cancelled.controller.requestStop('end');
  cancelled.advance(15 * SECOND);
  cancelled.controller.cancelStop();
  assert.equal(cancelled.controller.end().status, 'running');

  const stale = setup({ strictness: 'captain' });
  stale.controller.requestStop('end');
  stale.advance(15 * SECOND + PERMIT_LIFETIME_MS + SECOND);
  assert.equal(stale.controller.end().status, 'running', 'asking once does not unlock the session for good');
});

// --- Pawfessor -----------------------------------------------------------------

test('Pawfessor: no pause, no time off, and End needs the characters this process made up', () => {
  const { controller, c } = setup({ strictness: 'pawfessor' });
  assert.deepEqual(controller.requestStop('pause'), { refused: true });
  assert.deepEqual(controller.requestStop('reduce'), { refused: true });
  assert.equal(controller.pause().status, 'running');
  controller.adjust(-5);
  assert.equal(left(controller, c), 25);

  assert.equal(controller.end().status, 'running', 'no code asked for');
  assert.equal(controller.end('anything').status, 'running');
  const { code } = controller.requestStop('end');
  assert.equal(code.length, 12);
  assert.equal(controller.end('').status, 'running');
  assert.equal(controller.end(code.toLowerCase() === code ? code.toUpperCase() : code.toLowerCase()).status, 'running', 'case matters');
  assert.equal(controller.end(code).status, 'ended');
});

test('Pawfessor: a new code is needed after "Keep going"', () => {
  const { controller } = setup({ strictness: 'pawfessor' });
  const { code } = controller.requestStop('end');
  controller.cancelStop();
  assert.equal(controller.end(code).status, 'running');
});

// --- Junior, quitting, running out ----------------------------------------------

test('Junior and sessions without a level stop, pause and shorten at once', () => {
  for (const strictness of ['junior', null]) {
    const { controller, c } = setup({ strictness });
    assert.deepEqual(controller.requestStop('end'), { ready: true });
    controller.adjust(-5);
    assert.equal(left(controller, c), 20);
    assert.equal(controller.pause().status, 'paused');
    controller.resume();
    assert.equal(controller.end().status, 'ended');
  }
});

test('tray Quit is refused while a Captain or Pawfessor session runs, and allowed otherwise', () => {
  assert.equal(setup({ strictness: 'pawfessor' }).controller.blocksQuit(), true);
  assert.equal(setup({ strictness: 'captain' }).controller.blocksQuit(), true);
  assert.equal(setup({ strictness: 'junior' }).controller.blocksQuit(), false);
  assert.equal(setup().controller.blocksQuit(), false, 'no session');
  const over = setup({ strictness: 'pawfessor', minutes: 1 });
  over.advance(2 * MINUTE);
  assert.equal(over.controller.get().status, 'ended');
  assert.equal(over.controller.blocksQuit(), false, 'the session ran out');
});

test('a strict session still ends by itself when its time is up', () => {
  const { controller, advance, ended } = setup({ strictness: 'pawfessor', minutes: 5 });
  advance(5 * MINUTE + SECOND);
  assert.equal(controller.get().status, 'ended');
  assert.equal(controller.get().endedEarly, false);
  assert.equal(ended.length, 1);
});

// --- untimed sessions left running ----------------------------------------------

test('an untimed session ends when the app was last seen, not 12 hours on (laptop shut overnight)', () => {
  const { controller, advance, sleep, ended } = setup({ strictness: 'junior', untimed: true });
  advance(60 * MINUTE); // working; a heartbeat every minute
  assert.equal(controller.get().status, 'running');
  sleep(14 * 60 * MINUTE); // the lid is shut at 10:00 and opened the next morning
  advance(HEARTBEAT_MS); // the first tick after waking
  const session = controller.get();
  assert.equal(session.status, 'ended');
  const focusedMinutes = Math.round((session.endedAt - session.startTime) / MINUTE);
  assert.ok(focusedMinutes >= 59 && focusedMinutes <= 61, `about one hour of focus, not ${focusedMinutes} minutes`);
  assert.equal(ended.length, 1);
});

test('an untimed session found on disk after a long gap ends at its last heartbeat; a quick restart keeps it', async () => {
  const lastSeenAt = T0 + 45 * MINUTE;
  const saved = { status: 'running', untimed: true, startTime: T0, finishTime: T0 + 720 * MINUTE, pausedTotalMs: 0, pausedAt: null, userId: 'auth0|a', lastSeenAt };

  const nextMorning = setup();
  nextMorning.disk.value = saved;
  nextMorning.c.t = T0 + 20 * 60 * MINUTE; // past the 12-hour mark
  const restored = await nextMorning.controller.restore();
  assert.equal(restored.status, 'ended');
  assert.equal(restored.endedAt, lastSeenAt, 'not start + 12 h (43200 s of "focus")');

  const quick = setup();
  quick.disk.value = saved;
  quick.c.t = lastSeenAt + 30 * SECOND;
  assert.equal((await quick.controller.restore()).status, 'running');
  assert.ok(AWAY_MS > 2 * HEARTBEAT_MS);
});

test('a timed session is not ended by a short sleep', () => {
  const { controller, advance, sleep } = setup({ strictness: 'junior', minutes: 60 });
  advance(5 * MINUTE);
  sleep(20 * MINUTE);
  advance(HEARTBEAT_MS);
  assert.equal(controller.get().status, 'running');
});

// --- the finish outbox ------------------------------------------------------------

function outboxSetup() {
  const store = { text: null };
  const server = { online: true, status: 0, received: [] };
  const clock = { t: T0 };
  const make = () =>
    createFinishOutbox({
      storage: { read: () => store.text, write: (text) => { store.text = text; } },
      send: async (session) => {
        if (!server.online) throw Object.assign(new Error('offline'), { status: 0 });
        if (server.status) throw Object.assign(new Error('refused'), { status: server.status });
        server.received.push(session);
      },
      now: () => clock.t,
      log: { error() {} },
    });
  return { store, server, clock, make, outbox: make() };
}

const ENDED = { status: 'ended', synced: true, modeId: 'm', startTime: T0, finishTime: T0 + 25 * MINUTE, endedAt: T0 + 25 * MINUTE, pausedTotalMs: 0, tasks: [] };

test('a finish that fails is kept and sent again, also after a restart', async () => {
  const { server, make, outbox } = outboxSetup();
  server.online = false; // the connection dropped before the session ended
  assert.equal(outbox.add(ENDED, 'auth0|a'), true);
  assert.equal(await outbox.flush('auth0|a'), 1, 'still waiting');
  assert.equal(outbox.has(T0, 'auth0|a'), true);

  // The app is closed and opened again: the entry is still there.
  const afterRestart = make();
  assert.equal(afterRestart.has(T0, 'auth0|a'), true);
  server.online = true;
  assert.equal(await afterRestart.flush('auth0|a'), 0);
  assert.equal(server.received.length, 1);
  assert.equal(server.received[0].endedAt, ENDED.endedAt);
  assert.equal(afterRestart.has(T0, 'auth0|a'), false);
  // Not sent twice.
  await afterRestart.flush('auth0|a');
  assert.equal(server.received.length, 1);
});

test('a session is queued once, and only synced, ended sessions are', () => {
  const { outbox } = outboxSetup();
  assert.equal(outbox.add(ENDED, 'auth0|a'), true);
  assert.equal(outbox.add(ENDED, 'auth0|a'), false);
  assert.equal(outbox.add({ ...ENDED, startTime: T0 + 1, synced: false }, 'auth0|a'), false);
  assert.equal(outbox.add({ ...ENDED, startTime: T0 + 2, status: 'running' }, 'auth0|a'), false);
  assert.equal(outbox.pending('auth0|a'), 1);
});

test("one account's finish is never sent with another account signed in", async () => {
  const { server, outbox } = outboxSetup();
  outbox.add(ENDED, 'auth0|a');
  assert.equal(await outbox.flush('auth0|b'), 0);
  assert.equal(server.received.length, 0);
  assert.equal(outbox.has(T0, 'auth0|a'), true, "it waits for its own account's next sign-in");
});

test('a finish the server refuses for good is dropped; a 5xx or 401 is kept', async () => {
  const { server, outbox } = outboxSetup();
  outbox.add(ENDED, 'auth0|a');
  server.status = 503;
  assert.equal(await outbox.flush('auth0|a'), 1);
  server.status = 401;
  assert.equal(await outbox.flush('auth0|a'), 1);
  server.status = 404; // the block list was deleted
  assert.equal(await outbox.flush('auth0|a'), 0);
  assert.equal(isPermanent({ status: 429 }), false);
  assert.equal(isPermanent(new TypeError('Failed to fetch')), false);
});

// --- Done on a task -----------------------------------------------------------------

test('a second click on Done right after the first is ignored', () => {
  assert.equal(canFinishTask(NaN, T0), true);
  assert.equal(canFinishTask(T0, T0 + 150), false, 'the double click that ticked off two tasks');
  assert.equal(canFinishTask(T0, T0 + DONE_QUIET_MS), true);
});

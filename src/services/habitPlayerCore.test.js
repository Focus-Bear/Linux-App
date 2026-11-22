import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHabitPlayerStore } from './habitPlayerCore.js';
import { currentHabit } from './habitPlayerModel.js';

const T0 = new Date(2026, 10, 21, 7, 0).getTime();

const habit = (id, extra = {}) => ({ id, name: id, icon: '', seconds: 60, requirements: '', questions: [], done: false, skipped: false, sequenceId: 'seq-m', ...extra });
const card = () => ({ id: 'morning', kind: 'morning', title: 'Morning routine habits', habits: [habit('water'), habit('stretch'), habit('read')] });

/** A store on a fake API, a clock moved by hand and timers that are fired by hand. */
function setup({ failing = false } = {}) {
  const posts = [];
  const timers = [];
  let clock = T0;
  const api = {
    async completeHabit(item, timing) {
      posts.push(['done', item.id, timing.seconds]);
      if (failing) throw new Error('offline');
    },
    async skipHabit(item) {
      posts.push(['skipped', item.id]);
      if (failing) throw new Error('offline');
    },
  };
  const store = createHabitPlayerStore({
    api,
    now: () => clock,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
    logError: () => {},
  });
  return {
    ...store,
    posts,
    timers,
    advance(ms) {
      clock += ms;
    },
    player: () => store.habitPlayer.get().player,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a habit marked done on its Day Plan row while the routine plays is not played and posted again', async () => {
  const s = setup();
  assert.equal(s.habitPlayer.start(card()), true);
  assert.equal(currentHabit(s.player()).id, 'water');

  // Back on the Day Plan: Done on the row of the second habit.
  await s.reportHabit(habit('stretch'), { startMs: T0, finishMs: T0 + 60000, seconds: 60 });
  assert.deepEqual(s.player().queue.map((item) => item.id), ['water', 'read']);

  // Back in the player: finish the first habit and carry on.
  s.habitPlayer.end('done');
  await settle();
  assert.equal(s.player().phase, 'between');
  s.habitPlayer.next();
  assert.equal(currentHabit(s.player()).id, 'read', 'the habit done on its row is not played');
  s.habitPlayer.end('done');
  await settle();
  assert.equal(s.player().phase, 'finished');

  assert.deepEqual(s.posts, [
    ['done', 'stretch', 60],
    ['done', 'water', 60],
    ['done', 'read', 60],
  ]);
  assert.equal(s.posts.filter(([, id]) => id === 'stretch').length, 1);
});

test('skipping the last waiting habit on its row between habits ends the routine', async () => {
  const s = setup();
  s.habitPlayer.start({ ...card(), habits: [habit('water'), habit('stretch')] });
  s.habitPlayer.end('done');
  await settle();
  assert.equal(s.player().phase, 'between');
  await s.reportHabit(habit('stretch'), null);
  assert.equal(s.player().phase, 'finished');
  s.habitPlayer.next();
  s.habitPlayer.skipNext();
  await settle();
  assert.deepEqual(s.posts, [['done', 'water', 60], ['skipped', 'stretch']]);
});

test('the player own reports keep its queue: next and skip-next move through it', async () => {
  const s = setup();
  s.habitPlayer.start(card());
  s.habitPlayer.end('done');
  await settle();
  s.habitPlayer.skipNext();
  await settle();
  assert.equal(s.player().queue.length, 3);
  assert.equal(s.player().phase, 'between');
  s.habitPlayer.next();
  assert.equal(currentHabit(s.player()).id, 'read');
  assert.deepEqual(s.posts, [['done', 'water', 60], ['skipped', 'stretch']]);
});

test('the countdown reports the habit as done when its time is up', async () => {
  const s = setup();
  s.habitPlayer.start(card());
  assert.equal(s.timers.length, 1);
  s.advance(60000);
  s.timers[0]();
  await settle();
  assert.deepEqual(s.posts, [['done', 'water', 60]]);
  assert.equal(s.player().phase, 'between');
});

test('a timed habit that asks a question waits for the answer instead of reporting', async () => {
  const s = setup();
  s.habitPlayer.start({ ...card(), habits: [habit('read', { questions: [{ id: 'q1' }] })] });
  s.advance(60000);
  s.timers[0]();
  assert.equal(s.habitPlayer.get().asking, true);
  assert.deepEqual(s.posts, []);
  s.habitPlayer.end('done', [{ question_id: 'q1', logged_value: 12 }]);
  await settle();
  assert.equal(s.habitPlayer.get().asking, false);
  assert.equal(s.posts.length, 1);
});

test('a report that fails is remembered, rolled back on the Day Plan and bumps the version', async () => {
  const s = setup({ failing: true });
  const before = s.habitPlayer.get().version;
  await assert.rejects(s.reportHabit(habit('water'), null));
  const state = s.habitPlayer.get();
  assert.deepEqual(state.failed, ['water']);
  assert.deepEqual(state.outcomes, {});
  assert.equal(state.version, before + 1);
  s.habitPlayer.clearFailed();
  assert.deepEqual(s.habitPlayer.get().failed, []);
});

test('what was reported shows at once, for today', async () => {
  const s = setup();
  let heard = 0;
  const off = s.subscribe(() => {
    heard += 1;
  });
  await s.reportHabit(habit('water'), { startMs: T0, finishMs: T0, seconds: 1 });
  await s.reportHabit(habit('stretch'), null);
  const state = s.habitPlayer.get();
  assert.deepEqual(state.outcomes, { water: 'done', stretch: 'skipped' });
  assert.equal(state.outcomesDay, '2026-11-21');
  assert.ok(heard >= 4);
  off();
  // The next day starts empty.
  s.advance(24 * 3600000);
  await s.reportHabit(habit('read'), null);
  assert.deepEqual(s.habitPlayer.get().outcomes, { read: 'skipped' });
});

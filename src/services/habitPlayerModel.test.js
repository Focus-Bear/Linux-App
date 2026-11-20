import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  completionTiming,
  createPlayer,
  currentHabit,
  elapsedMs,
  finishCurrent,
  finishedHeading,
  formatCountdown,
  habitProgress,
  isDue,
  isPaused,
  isTimed,
  lastResult,
  nextHabit,
  pausePlayer,
  playQueue,
  playerTotals,
  progressLine,
  remainingMs,
  resumePlayer,
  skipNext,
  startNext,
  startNextLabel,
  wrapUpLabel,
} from './habitPlayerModel.js';

const T0 = 1_800_000_000_000;
const SEC = 1000;

const water = { id: 'h1', name: 'Drink water', icon: '💧', seconds: 60, requirements: 'Glass is empty', sequenceId: 's1' };
const stretch = { id: 'h2', name: 'Stretch', icon: '🧘', seconds: 300, requirements: '', sequenceId: 's1' };
const plan = { id: 'h3', name: 'Plan the day', icon: '📝', seconds: 600, requirements: '', sequenceId: 's1' };
const card = (habits, kind = 'morning') => ({ id: kind, kind, title: 'Morning routine habits', habits });

test('a habit with completion requirements has no countdown', () => {
  assert.equal(isTimed(stretch), true);
  assert.equal(isTimed(water), false);
  assert.equal(isTimed({ ...stretch, seconds: 0 }), false);
  assert.equal(isTimed(null), false);
});

test('the queue is the habits still to do, optionally starting at one of them', () => {
  const habits = [{ ...water, done: true }, stretch, { ...plan, skipped: true }, { id: 'h4', name: 'Read', seconds: 60 }];
  assert.deepEqual(playQueue(habits).map((h) => h.id), ['h2', 'h4']);
  assert.deepEqual(playQueue(habits, 'h4').map((h) => h.id), ['h4', 'h2']);
  assert.deepEqual(playQueue(habits, 'h1').map((h) => h.id), ['h2', 'h4']); // already done: normal order
  assert.deepEqual(playQueue(null), []);
});

test('a routine with nothing left to do cannot be played', () => {
  assert.equal(createPlayer({ card: card([{ ...water, done: true }]), now: T0 }), null);
  assert.equal(createPlayer({ card: null, now: T0 }), null);
});

test('a timed habit counts down and is due at zero', () => {
  const player = createPlayer({ card: card([stretch, plan]), now: T0 });
  assert.equal(player.phase, 'running');
  assert.equal(currentHabit(player).id, 'h2');
  assert.equal(nextHabit(player).id, 'h3');
  assert.equal(remainingMs(player, T0), 300 * SEC);
  assert.equal(remainingMs(player, T0 + 100 * SEC), 200 * SEC);
  assert.equal(habitProgress(player, T0 + 150 * SEC), 0.5);
  assert.equal(isDue(player, T0 + 299 * SEC), false);
  assert.equal(isDue(player, T0 + 300 * SEC), true);
  assert.equal(remainingMs(player, T0 + 999 * SEC), 0);
});

test('a habit without a timer is never due and reports no time left', () => {
  const player = createPlayer({ card: card([water, stretch]), now: T0 });
  assert.equal(remainingMs(player, T0 + 10 * SEC), 0);
  assert.equal(isDue(player, T0 + 9999 * SEC), false);
  assert.equal(habitProgress(player, T0 + 10 * SEC), 0);
});

test('pausing stops the clock and resuming carries on from where it was', () => {
  let player = createPlayer({ card: card([stretch]), now: T0 });
  player = pausePlayer(player, T0 + 60 * SEC);
  assert.equal(isPaused(player), true);
  assert.equal(remainingMs(player, T0 + 500 * SEC), 240 * SEC);
  assert.equal(isDue(player, T0 + 500 * SEC), false);
  assert.equal(pausePlayer(player, T0 + 70 * SEC), player); // already paused
  player = resumePlayer(player, T0 + 160 * SEC);
  assert.equal(isPaused(player), false);
  assert.equal(elapsedMs(player, T0 + 170 * SEC), 70 * SEC);
  assert.equal(remainingMs(player, T0 + 170 * SEC), 230 * SEC);
  assert.equal(resumePlayer(player, T0 + 180 * SEC), player); // not paused
});

test('a timed habit logs its length; an untimed one logs the time spent', () => {
  const timed = createPlayer({ card: card([stretch]), now: T0 });
  assert.deepEqual(completionTiming(timed, 'done', T0 + 300 * SEC), {
    startMs: T0,
    finishMs: T0 + 300 * SEC,
    seconds: 300,
    alreadyDid: false,
  });
  const untimed = createPlayer({ card: card([water]), now: T0 });
  assert.equal(completionTiming(untimed, 'done', T0 + 42 * SEC).seconds, 42);
  assert.equal(completionTiming(untimed, 'done', T0).seconds, 1); // never zero
});

test('"I already did it" is a one second completion flagged as such; a skip logs nothing', () => {
  const player = createPlayer({ card: card([stretch]), now: T0 });
  assert.deepEqual(completionTiming(player, 'already-did', T0 + 5 * SEC), {
    startMs: T0 + 4 * SEC,
    finishMs: T0 + 5 * SEC,
    seconds: 1,
    alreadyDid: true,
  });
  assert.equal(completionTiming(player, 'skipped', T0 + 5 * SEC), null);
});

test('finishing a habit shows the between screen, and the next habit starts on request', () => {
  let player = createPlayer({ card: card([stretch, plan]), now: T0 });
  player = finishCurrent(player, 'done', T0 + 300 * SEC);
  assert.equal(player.phase, 'between');
  assert.deepEqual(lastResult(player), { id: 'h2', name: 'Stretch', icon: '🧘', outcome: 'done', seconds: 300 });
  assert.equal(finishedHeading(lastResult(player)), 'Stretch finished!✅');
  assert.equal(startNextLabel(nextHabit(player)), 'Start 10 min Plan the day');
  assert.equal(progressLine(player), 'You have completed 5 min of habits - 10 min to go. You can do it!');
  assert.equal(finishCurrent(player, 'done', T0 + 301 * SEC), player); // nothing is running

  player = startNext(player, T0 + 320 * SEC);
  assert.equal(player.phase, 'running');
  assert.equal(currentHabit(player).id, 'h3');
  assert.equal(remainingMs(player, T0 + 320 * SEC), 600 * SEC);
  assert.equal(startNext(player, T0 + 330 * SEC), player); // only from the between screen
});

test('the last habit ends the routine', () => {
  let player = createPlayer({ card: card([stretch, plan]), now: T0 });
  player = finishCurrent(player, 'done', T0 + 300 * SEC);
  player = startNext(player, T0 + 300 * SEC);
  player = finishCurrent(player, 'skipped', T0 + 310 * SEC);
  assert.equal(player.phase, 'finished');
  assert.equal(finishedHeading(lastResult(player)), 'Plan the day skipped!');
  assert.deepEqual(playerTotals(player), { doneSeconds: 300, leftSeconds: 0, done: 1, skipped: 1 });
  assert.equal(progressLine(player), 'You have completed 5 min of habits.');
});

test('the next habit can be skipped from the between screen without starting it', () => {
  let player = createPlayer({ card: card([stretch, plan, water]), now: T0 });
  player = finishCurrent(player, 'done', T0 + 300 * SEC);
  player = skipNext(player, T0 + 301 * SEC);
  assert.equal(player.phase, 'between');
  assert.equal(lastResult(player).outcome, 'skipped');
  assert.equal(nextHabit(player).id, 'h1');
  player = skipNext(player, T0 + 302 * SEC);
  assert.equal(player.phase, 'finished');
  assert.deepEqual(player.results.map((r) => r.outcome), ['done', 'skipped', 'skipped']);
});

test('"I already did it" counts as done but adds no time', () => {
  let player = createPlayer({ card: card([stretch]), now: T0 });
  player = finishCurrent(player, 'already-did', T0 + 3 * SEC);
  assert.deepEqual(lastResult(player), { id: 'h2', name: 'Stretch', icon: '🧘', outcome: 'done', seconds: 0 });
});

test('button texts: untimed habits have no length, the evening routine wraps up the day', () => {
  assert.equal(startNextLabel(water), 'Start Drink water');
  assert.equal(startNextLabel(null), '');
  assert.equal(wrapUpLabel(createPlayer({ card: card([stretch]), now: T0 })), 'Back to Day Plan');
  assert.equal(wrapUpLabel(createPlayer({ card: card([stretch], 'evening'), now: T0 })), "Let's wrap up for the day");
});

test('the countdown rounds up and shows hours when needed', () => {
  assert.equal(formatCountdown(300 * SEC), '05:00');
  assert.equal(formatCountdown(299_400), '05:00');
  assert.equal(formatCountdown(59_000), '00:59');
  assert.equal(formatCountdown(0), '00:00');
  assert.equal(formatCountdown(-5), '00:00');
  assert.equal(formatCountdown(3725 * SEC), '1:02:05');
});

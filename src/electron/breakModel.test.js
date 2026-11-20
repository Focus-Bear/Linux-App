import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BREAK_MINUTES,
  DEFAULT_POSTPONE_MINUTES,
  breakHabits,
  breakSeconds,
  breaksActive,
  clampBreakMinutes,
  formatBreakLength,
  holdReason,
  nextBreakAt,
  nextBreakLabel,
  normaliseBreakConfig,
  normalisePostpone,
  parseBreakMinutes,
  planBreak,
  postponeLabel,
  rescheduleAt,
  stepBreakMinutes,
  warningTitle,
} from './breakModel.js';

const habit = (id, everyBreak = false, extra = {}) => ({ id, name: id, icon: '', seconds: 30, sequenceId: 'seq', requirements: '', everyBreak, ...extra });
const ids = (plan) => plan.play.map((h) => h.id);
const T0 = 1_800_000_000_000;
const MIN = 60000;

test('the break interval stays inside 5-180 and defaults to 15', () => {
  assert.equal(DEFAULT_BREAK_MINUTES, 15);
  assert.equal(clampBreakMinutes(60), 60);
  assert.equal(clampBreakMinutes('45'), 45);
  assert.equal(clampBreakMinutes(1), 5);
  assert.equal(clampBreakMinutes(999), 180);
  assert.equal(clampBreakMinutes(undefined), 15);
  assert.equal(clampBreakMinutes('abc'), 15);
  assert.equal(clampBreakMinutes(0), 15);
});

test('the stepper moves in fives and snaps odd values', () => {
  assert.equal(stepBreakMinutes(15, 1), 20);
  assert.equal(stepBreakMinutes(15, -1), 10);
  assert.equal(stepBreakMinutes(17, 1), 20);
  assert.equal(stepBreakMinutes(17, -1), 15);
  assert.equal(stepBreakMinutes(5, -1), 5);
  assert.equal(stepBreakMinutes(180, 1), 180);
});

test('the frequency box takes whole numbers from 5 to 180 only', () => {
  assert.equal(parseBreakMinutes('25'), 25);
  assert.equal(parseBreakMinutes(' 180 '), 180);
  assert.equal(parseBreakMinutes('4'), null);
  assert.equal(parseBreakMinutes('181'), null);
  assert.equal(parseBreakMinutes('12.5'), null);
  assert.equal(parseBreakMinutes('ten'), null);
  assert.equal(parseBreakMinutes(''), null);
});

test('break habits are read from break_activities with their every-break flag', () => {
  const settings = {
    break_activities: [
      { id: 'a', name: 'Look away', habit_icon: '👀', duration_seconds: 20, activity_sequence_id: 's', include_in_every_break: true },
      { id: 'b', duration_seconds: '30', completion_requirements: ' 10 squats ' },
      null,
      { name: 'no id' },
    ],
  };
  assert.deepEqual(breakHabits(settings), [
    { id: 'a', name: 'Look away', icon: '👀', seconds: 20, sequenceId: 's', requirements: '', everyBreak: true },
    { id: 'b', name: 'Break', icon: '', seconds: 30, sequenceId: '', requirements: '10 squats', everyBreak: false },
  ]);
  assert.deepEqual(breakHabits({}), []);
  assert.deepEqual(breakHabits(null), []);
});

test('a break plays every every-break habit plus one other, taking turns', () => {
  const habits = [habit('every1', true), habit('r1'), habit('r2'), habit('every2', true), habit('r3')];
  const first = planBreak(habits, null);
  assert.deepEqual(ids(first), ['every1', 'r1', 'every2']);
  assert.equal(first.rotatedId, 'r1');
  const second = planBreak(habits, first.rotatedId);
  assert.deepEqual(ids(second), ['every1', 'r2', 'every2']);
  const third = planBreak(habits, second.rotatedId);
  assert.deepEqual(ids(third), ['every1', 'every2', 'r3']); // in the user's order
  const fourth = planBreak(habits, third.rotatedId);
  assert.equal(fourth.rotatedId, 'r1'); // wraps round
});

test('the turn restarts when the last habit is gone, and continues past an every-break habit', () => {
  const habits = [habit('r1'), habit('e', true), habit('r2')];
  assert.equal(planBreak(habits, 'deleted').rotatedId, 'r1');
  // The habit that had the last turn was since switched to "every break": the turn moves on from its place.
  assert.equal(planBreak(habits, 'e').rotatedId, 'r2');
});

test('only every-break habits, only rotating habits, and no habits', () => {
  assert.deepEqual(planBreak([habit('e1', true), habit('e2', true)], 'e1'), {
    play: [habit('e1', true), habit('e2', true)],
    rotatedId: null,
  });
  assert.deepEqual(ids(planBreak([habit('r1'), habit('r2')], 'r1')), ['r2']);
  assert.deepEqual(planBreak([], 'x'), { play: [], rotatedId: null });
  assert.deepEqual(planBreak(null), { play: [], rotatedId: null });
});

test('the break length counts timed habits and reads like the Windows warning', () => {
  const play = [habit('a', true, { seconds: 20 }), habit('b', false, { seconds: 30 }), habit('c', false, { seconds: 600, requirements: 'x' })];
  assert.equal(breakSeconds(play), 50);
  assert.equal(formatBreakLength(45), '45 sec');
  assert.equal(formatBreakLength(60), '1 min');
  assert.equal(formatBreakLength(190), '3 min 10 sec');
  assert.equal(warningTitle(50), 'Your 50 sec micro break starts in');
  assert.equal(warningTitle(0), 'Your micro break starts in');
  assert.equal(postponeLabel(30), 'Postpone for 30 minutes');
});

test('postpone offers the Windows choices and falls back to 30 minutes', () => {
  assert.equal(DEFAULT_POSTPONE_MINUTES, 30);
  assert.equal(normalisePostpone('45'), 45);
  assert.equal(normalisePostpone(7), 30);
  assert.equal(normalisePostpone(undefined), 30);
});

test('breaks run only when switched on and the account has break habits', () => {
  const on = normaliseBreakConfig({ enabled: true, minutes: 20, habitCount: 3, seconds: 50 });
  assert.equal(breaksActive(on), true);
  assert.equal(nextBreakAt(on, T0), T0 + 20 * MIN);
  assert.equal(nextBreakAt(on, T0, 5), T0 + 5 * MIN);
  assert.equal(breaksActive(normaliseBreakConfig({ enabled: false, minutes: 20, habitCount: 3 })), false);
  assert.equal(nextBreakAt(normaliseBreakConfig({ enabled: true, habitCount: 0 }), T0), null);
  assert.equal(normaliseBreakConfig(null).minutes, 15);
  assert.equal(normaliseBreakConfig({}).enabled, true); // "Enable Breaks" defaults to on
});

test('a settings change keeps the running countdown unless the interval or the switch changed', () => {
  const a = normaliseBreakConfig({ minutes: 20, habitCount: 2 });
  const sameInterval = normaliseBreakConfig({ minutes: 20, habitCount: 3 });
  const longer = normaliseBreakConfig({ minutes: 30, habitCount: 2 });
  const off = normaliseBreakConfig({ enabled: false, minutes: 20, habitCount: 2 });
  const due = T0 + 7 * MIN;
  assert.equal(rescheduleAt(a, sameInterval, due, T0), due);
  assert.equal(rescheduleAt(a, longer, due, T0), T0 + 30 * MIN);
  assert.equal(rescheduleAt(a, off, due, T0), null);
  assert.equal(rescheduleAt(off, a, null, T0), T0 + 20 * MIN);
  assert.equal(rescheduleAt(null, a, null, T0), T0 + 20 * MIN);
});

test('a due break is held during a focus session, a routine and outside the day', () => {
  const config = normaliseBreakConfig({ minutes: 15, habitCount: 1, startup: '07:00', shutdown: '20:30' });
  assert.equal(holdReason(config, { nowMinutes: 12 * 60 }), null);
  assert.equal(holdReason(config, { focusActive: true, nowMinutes: 12 * 60 }), 'focus');
  assert.equal(holdReason(config, { playing: true, nowMinutes: 12 * 60 }), 'routine');
  assert.equal(holdReason(config, { nowMinutes: 21 * 60 }), 'off-hours');
  assert.equal(holdReason(config, { nowMinutes: 6 * 60 }), 'off-hours');
  assert.equal(holdReason(config, { nowMinutes: 20 * 60 + 29 }), null);
  // A day that runs past midnight, and an account without times.
  const night = normaliseBreakConfig({ habitCount: 1, startup: '14:00', shutdown: '02:00' });
  assert.equal(holdReason(night, { nowMinutes: 60 }), null);
  assert.equal(holdReason(night, { nowMinutes: 3 * 60 }), 'off-hours');
  assert.equal(holdReason(normaliseBreakConfig({ habitCount: 1 }), { nowMinutes: 3 * 60 }), null);
});

test('the next break reads as minutes left', () => {
  assert.equal(nextBreakLabel(T0 + 12 * MIN, T0), 'Next break in 12 min');
  assert.equal(nextBreakLabel(T0 + 11 * MIN + 1, T0), 'Next break in 12 min');
  assert.equal(nextBreakLabel(T0 + 30000, T0), 'Next break in less than a minute');
  assert.equal(nextBreakLabel(null, T0), '');
});

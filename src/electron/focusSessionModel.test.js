import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODE_NAME,
  adjustSession,
  clampMinutes,
  createSession,
  defaultMinutes,
  defaultModeBody,
  elapsedMs,
  encodeText,
  endSession,
  findSummaryRow,
  finishBody,
  formatClock,
  formatDuration,
  formatLength,
  formatRange,
  isActive,
  isDue,
  lengthWords,
  parseLength,
  pauseSession,
  pickDefaultMode,
  progress,
  reflectionBody,
  remainingMs,
  restoreSession,
  resumeSession,
  scheduledFinishBody,
  selectableModes,
  sessionTitle,
  startBody,
  startLabel,
  stepMinutes,
  totalMs,
} from './focusSessionModel.js';

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 21, 9, 0, 0); // 2026-11-21T09:00:00Z
const session25 = (extra = {}) =>
  createSession({ modeId: 'mode-1', modeName: 'Deep Work', intention: ' Write the report ', minutes: 25, now: T0, synced: true, ...extra });

test('session length is a whole number of minutes between 1 and 480, 25 by default', () => {
  assert.equal(clampMinutes(25), 25);
  assert.equal(clampMinutes(0), 1);
  assert.equal(clampMinutes(-5), 1);
  assert.equal(clampMinutes(9999), 480);
  assert.equal(clampMinutes(12.6), 13);
  assert.equal(clampMinutes('abc'), 25);
  assert.equal(clampMinutes(undefined), 25);
});

test('−5 / +5 on the start screen', () => {
  assert.equal(stepMinutes(25, 1), 30);
  assert.equal(stepMinutes(25, -1), 20);
  assert.equal(stepMinutes(5, -1), 1);
  assert.equal(stepMinutes(3, -1), 1);
  assert.equal(stepMinutes(1, 1), 5);
  assert.equal(stepMinutes(480, 1), 480);
  assert.equal(stepMinutes(478, 1), 480);
});

test('the default length comes from the account (kPomodoroDurationMinutes), else 25', () => {
  assert.equal(defaultMinutes({ kPomodoroDurationMinutes: 50 }), 50);
  assert.equal(defaultMinutes({ kPomodoroDurationMinutes: '45' }), 45);
  assert.equal(defaultMinutes({ kPomodoroDurationMinutes: 0 }), 25);
  assert.equal(defaultMinutes({ kPomodoroDurationMinutes: 'x' }), 25);
  assert.equal(defaultMinutes({}), 25);
  assert.equal(defaultMinutes(null), 25);
});

test('a new session runs from now for its length', () => {
  const s = session25();
  assert.equal(s.status, 'running');
  assert.equal(s.intention, 'Write the report');
  assert.equal(s.finishTime - s.startTime, 25 * MIN);
  assert.equal(s.synced, true);
  assert.equal(isActive(s), true);
  assert.equal(remainingMs(s, T0), 25 * MIN);
  assert.equal(remainingMs(s, T0 + 10 * MIN), 15 * MIN);
  assert.equal(elapsedMs(s, T0 + 10 * MIN), 10 * MIN);
  assert.equal(totalMs(s), 25 * MIN);
  assert.equal(progress(s, T0 + 5 * MIN), 0.2);
  assert.equal(isDue(s, T0 + 25 * MIN - 1), false);
  assert.equal(isDue(s, T0 + 25 * MIN), true);
});

test('the clock never goes below zero or progress above 1', () => {
  const s = session25();
  assert.equal(remainingMs(s, T0 + 60 * MIN), 0);
  assert.equal(progress(s, T0 + 60 * MIN), 1);
  assert.equal(remainingMs(null, T0), 0);
  assert.equal(elapsedMs(null, T0), 0);
  assert.equal(isActive(null), false);
});

test('pausing freezes the clock; resuming pushes the finish back by the pause', () => {
  const paused = pauseSession(session25(), T0 + 10 * MIN);
  assert.equal(paused.status, 'paused');
  assert.equal(remainingMs(paused, T0 + 18 * MIN), 15 * MIN, 'frozen while paused');
  assert.equal(elapsedMs(paused, T0 + 18 * MIN), 10 * MIN);
  assert.equal(isDue(paused, T0 + 99 * MIN), false, 'a paused session does not run out');

  const resumed = resumeSession(paused, T0 + 18 * MIN);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.pausedTotalMs, 8 * MIN);
  assert.equal(resumed.finishTime, T0 + 33 * MIN);
  assert.equal(remainingMs(resumed, T0 + 18 * MIN), 15 * MIN);
  assert.equal(elapsedMs(resumed, T0 + 20 * MIN), 12 * MIN, 'paused time is not focus time');
  assert.equal(totalMs(resumed), 25 * MIN, 'the planned focus time is unchanged');
});

test('pause and resume ignore sessions in the wrong state', () => {
  const s = session25();
  assert.equal(resumeSession(s, T0), s);
  const paused = pauseSession(s, T0 + MIN);
  assert.equal(pauseSession(paused, T0 + 2 * MIN), paused);
  assert.equal(pauseSession(null, T0), null);
});

test('+5 adds time, −5 takes it off but always leaves a minute', () => {
  const s = session25();
  assert.equal(adjustSession(s, 5, T0 + MIN).finishTime, T0 + 30 * MIN);
  assert.equal(adjustSession(s, -5, T0 + MIN).finishTime, T0 + 20 * MIN);
  assert.equal(adjustSession(s, -5, T0 + 23 * MIN).finishTime, T0 + 24 * MIN, 'one minute left, not ended');
  const paused = pauseSession(s, T0 + 23 * MIN);
  assert.equal(remainingMs(adjustSession(paused, -5, T0 + 50 * MIN), T0 + 50 * MIN), MIN);
});

test('a session cannot be stretched past 8 hours of focus', () => {
  const s = createSession({ minutes: 478, now: T0 });
  assert.equal(totalMs(adjustSession(s, 5, T0 + MIN)), 480 * MIN);
});

test('ending early records when it stopped; running out ends at the finish time', () => {
  const early = endSession(session25(), T0 + 10 * MIN);
  assert.equal(early.status, 'ended');
  assert.equal(early.endedAt, T0 + 10 * MIN);
  assert.equal(early.endedEarly, true);
  assert.equal(elapsedMs(early, T0 + 99 * MIN), 10 * MIN);
  assert.equal(isActive(early), false);

  const full = endSession(session25(), T0 + 25 * MIN + 400);
  assert.equal(full.endedAt, T0 + 25 * MIN);
  assert.equal(full.endedEarly, false);
  assert.equal(elapsedMs(full, 0), 25 * MIN);
});

test('ending while paused counts focus time up to the pause', () => {
  const paused = pauseSession(session25(), T0 + 10 * MIN);
  const ended = endSession(paused, T0 + 40 * MIN);
  assert.equal(ended.endedAt, T0 + 10 * MIN);
  assert.equal(elapsedMs(ended, 0), 10 * MIN);
  assert.equal(endSession(ended, T0 + 50 * MIN), ended, 'ending twice changes nothing');
});

test('a saved session is restored on launch, and ends if its time ran out while the app was closed', () => {
  const s = session25();
  assert.equal(restoreSession(s, T0 + 5 * MIN), s);
  const expired = restoreSession(s, T0 + 3 * 60 * MIN);
  assert.equal(expired.status, 'ended');
  assert.equal(expired.endedAt, s.finishTime);
  assert.equal(expired.endedEarly, false);
  const paused = pauseSession(s, T0 + MIN);
  assert.equal(restoreSession(paused, T0 + 3 * 60 * MIN), paused, 'a paused session stays paused');
  assert.equal(restoreSession(null, T0), null);
  assert.equal(restoreSession({ status: 'weird' }, T0), null);
  assert.equal(restoreSession({ status: 'running' }, T0), null);
});

test('clock, duration and length text', () => {
  assert.equal(formatClock(25 * MIN), '25:00');
  assert.equal(formatClock(59_001), '01:00');
  assert.equal(formatClock(999), '00:01');
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(65 * MIN), '1:05:00');
  assert.equal(formatClock(-5), '00:00');
  assert.equal(formatDuration(27 * MIN + 59_000), '27m 59s');
  assert.equal(formatDuration(65 * MIN + 20_000), '1h 5m');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatLength(25), '00:25');
  assert.equal(formatLength(90), '01:30');
});

test('the length field accepts minutes or HH:MM', () => {
  assert.equal(parseLength('25'), 25);
  assert.equal(parseLength('1:30'), 90);
  assert.equal(parseLength('01:30'), 90);
  assert.equal(parseLength(' 00:45 '), 45);
  assert.equal(parseLength('9:00'), 480, 'capped at 8 hours');
  assert.equal(parseLength('0'), null);
  assert.equal(parseLength('00:00'), null);
  assert.equal(parseLength('1:75'), null);
  assert.equal(parseLength('soon'), null);
  assert.equal(parseLength(''), null);
});

test('the start button names the session length with the right article', () => {
  assert.equal(lengthWords(25), '25 minute');
  assert.equal(lengthWords(60), '1 hour');
  assert.equal(lengthWords(90), '1 hour 30 minute');
  assert.equal(startLabel(25), 'Start a 25 minute session');
  assert.equal(startLabel(8), 'Start an 8 minute session');
  assert.equal(startLabel(11), 'Start an 11 minute session');
  assert.equal(startLabel(18), 'Start an 18 minute session');
  assert.equal(startLabel(80), 'Start a 1 hour 20 minute session');
  assert.equal(startLabel(85 - 60 + 60), 'Start a 1 hour 25 minute session');
  assert.equal(startLabel(480), 'Start an 8 hour session');
  assert.equal(startLabel(10), 'Start a 10 minute session');
});

test('the end screen shows the date and time range', () => {
  assert.equal(formatRange(T0, T0 + 28 * MIN, 'en-US', 'UTC'), 'Nov 21, 2026 • 9:00 AM - 9:28 AM');
});

test('the end screen is titled with the goal, else the block list', () => {
  assert.equal(sessionTitle(session25()), 'Write the report');
  assert.equal(sessionTitle(session25({ intention: '' })), 'Deep Work');
  assert.equal(sessionTitle(session25({ intention: '', modeName: '' })), 'Focus session');
  assert.equal(sessionTitle(null), 'Focus session');
});

const MODES = [
  { id: 'a', name: 'Meetings', metadata: { isMeetings: true } },
  { id: 'b', name: DEFAULT_MODE_NAME, metadata: { isDefault: true } },
  { id: 'c', name: 'Deep Work', metadata: { isDeepWorkFocus: true } },
  { id: 'd', name: '  ', metadata: {} },
  null,
];

test('the default block list is preselected and listed first', () => {
  assert.equal(pickDefaultMode(MODES).id, 'b');
  assert.equal(pickDefaultMode([MODES[0], MODES[2]]).id, 'a', 'no default: the first one');
  assert.equal(pickDefaultMode([]), null);
  assert.equal(pickDefaultMode(undefined), null);
  assert.deepEqual(selectableModes(MODES).map((m) => m.id), ['b', 'a', 'c']);
  assert.deepEqual(selectableModes(null), []);
});

test('the default block list is created with the same shape the Windows app uses', () => {
  const body = defaultModeBody('uuid-1');
  assert.equal(body.id, 'uuid-1');
  assert.equal(body.name, 'Block super distracting sites/apps');
  assert.deepEqual(body.allowed_urls, []);
  assert.equal(body.metadata.isDefault, true);
  assert.equal(body.metadata.color, 'A3FFA1');
  for (const flag of ['isMeetings', 'isLockedFocus', 'isRelaxFocus', 'isDeepWorkFocus', 'isWorkFocus']) {
    assert.equal(body.metadata[flag], false, flag);
  }
});

test('POST /focus-mode/{id}/start body', () => {
  assert.deepEqual(startBody(session25()), {
    intention: 'Write the report',
    finish_time: '2026-11-21T09:25:00.000Z',
    start_time: '2026-11-21T09:00:00.000Z',
    to_dos: [],
  });
  assert.equal(startBody(session25({ intention: '' })).intention, '');
});

test('PATCH update_scheduled_finish body follows −5 / +5 and resume', () => {
  const s = adjustSession(session25(), 5, T0 + MIN);
  assert.deepEqual(scheduledFinishBody(s), { scheduled_finish_time: '2026-11-21T09:30:00.000Z' });
});

test('POST /focus-mode/{id}/finish body', () => {
  const ended = endSession(session25(), T0 + 10 * MIN);
  assert.deepEqual(finishBody(ended), {
    achievements: '',
    distractions: '',
    finish_time: '2026-11-21T09:10:00.000Z',
    metadata: {},
    to_dos: [],
  });
  const withText = finishBody(ended, { achievements: 'Wrote 2 pages & a plan', distractions: ' phone ' });
  assert.equal(withText.achievements, 'Wrote%202%20pages%20%26%20a%20plan');
  assert.equal(withText.distractions, 'phone');
});

test('free text is cut to the server limit before encoding', () => {
  assert.equal(decodeURIComponent(encodeText('x'.repeat(400))).length, 255);
  assert.equal(encodeText(null), '');
  assert.equal(encodeText('  hi  '), 'hi');
});

test('the reflection goes onto the newest finished row for the same block list', () => {
  const rows = [
    { id: 'r1', focus_mode: { id: 'other' } },
    { id: 'r2', focus_mode: { id: 'mode-1' }, metadata: { is_manual: true } },
    { id: 'r3', focus_mode: { id: 'mode-1' }, metadata: {} },
    { id: 'r4', focus_mode: { id: 'mode-1' } },
  ];
  assert.equal(findSummaryRow(rows, 'mode-1').id, 'r3');
  assert.equal(findSummaryRow(rows, 'missing'), null);
  assert.equal(findSummaryRow(null, 'mode-1'), null);
});

test('reflection body has only what the user filled in', () => {
  assert.deepEqual(reflectionBody({ achievements: 'Done it', stars: 4 }), { achievements: 'Done%20it', focus_stars: 4 });
  assert.deepEqual(reflectionBody({ achievements: '  ', stars: 5 }), { focus_stars: 5 });
  assert.deepEqual(reflectionBody({ achievements: 'x', stars: 0 }), { achievements: 'x' });
  assert.equal(reflectionBody({ achievements: '', stars: 0 }), null);
  assert.equal(reflectionBody({ stars: 9 }), null);
  assert.equal(reflectionBody(), null);
});

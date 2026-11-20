import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockTime, isTrayPage, normaliseTheme, trayFocusView, TRAY_PAGES } from './trayModel.js';
import { createSession, endSession, pauseSession } from './focusSessionModel.js';
import { allItems } from '../ui/navigation.js';

const MIN = 60 * 1000;
const T0 = new Date(2026, 10, 21, 9, 0, 0).getTime(); // local 09:00
const session = (extra = {}) => createSession({ modeId: 'm', modeName: 'Deep Work', intention: 'Write the report', minutes: 25, now: T0, ...extra });

test('with no session the tray offers to start one', () => {
  for (const none of [null, undefined, endSession(session(), T0 + MIN)]) {
    const view = trayFocusView(none, T0);
    assert.equal(view.state, 'idle');
    assert.equal(view.subtitle, 'Not running');
    assert.equal(view.primaryLabel, 'Start Focus Session');
    assert.equal(view.primaryAction, 'start');
    assert.equal(view.pauseLabel, null);
  }
});

test('a running session shows the time left, when it ends and the goal', () => {
  const view = trayFocusView(session(), T0 + 10 * MIN);
  assert.equal(view.state, 'running');
  assert.equal(view.title, 'Focusing · 15:00 left');
  assert.equal(view.subtitle, 'ends at 09:25 · Write the report');
  assert.equal(view.primaryLabel, 'Stop Focus Session');
  assert.equal(view.primaryAction, 'stop');
  assert.equal(view.pauseLabel, 'Pause Focus Session');
  assert.equal(view.pauseAction, 'pause');
});

test('a session without a goal shows only the end time', () => {
  assert.equal(trayFocusView(session({ intention: '' }), T0).subtitle, 'ends at 09:25');
});

test('a paused session keeps its time left and offers to resume', () => {
  const view = trayFocusView(pauseSession(session(), T0 + 10 * MIN), T0 + 40 * MIN);
  assert.equal(view.state, 'paused');
  assert.equal(view.title, 'Focus session paused');
  assert.equal(view.subtitle, '15:00 left · Write the report');
  assert.equal(view.pauseLabel, 'Resume Focus Session');
  assert.equal(view.pauseAction, 'resume');
  assert.equal(view.primaryAction, 'stop');
});

test('clock time is zero padded', () => {
  assert.equal(clockTime(new Date(2026, 0, 1, 7, 5).getTime()), '07:05');
});

test('the tray can only open pages that exist in the sidebar', () => {
  const ids = allItems().map((item) => item.id);
  for (const page of TRAY_PAGES) assert.ok(ids.includes(page), `${page} is not a sidebar page`);
  assert.equal(isTrayPage('day-plan'), true);
  assert.equal(isTrayPage('settings-uninstall'), false);
  assert.equal(isTrayPage(undefined), false);
});

test('theme values are reduced to light or dark', () => {
  assert.equal(normaliseTheme('dark'), 'dark');
  assert.equal(normaliseTheme('light'), 'light');
  assert.equal(normaliseTheme('DARK'), 'light');
  assert.equal(normaliseTheme(undefined), 'light');
});

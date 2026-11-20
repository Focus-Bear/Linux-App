import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allItems,
  DEFAULT_ITEM_ID,
  focusStateFromResult,
  isNavigable,
  itemLabel,
  NAV_SECTIONS,
  resolveDestination,
} from './navigation.js';
import { webViewConfigs } from '../electron/webview-ids.js';

test('sections follow the Windows left menu order', () => {
  assert.deepEqual(NAV_SECTIONS.map((s) => s.title), ['MAIN', 'TOOLS', 'PREFERENCES']);
});

test('item ids are unique', () => {
  const ids = allItems().flatMap((i) => [i.id, ...(i.children || []).map((c) => c.id)]);
  assert.equal(new Set(ids).size, ids.length);
});

test('every webview entry points at a configured dashboard page', () => {
  const webviews = allItems().flatMap((i) => [i.webview, ...(i.children || []).map((c) => c.webview)]).filter(Boolean);
  assert.ok(webviews.length > 0);
  for (const id of webviews) assert.ok(webViewConfigs[id], `no webViewConfigs entry for ${id}`);
});

test('the app opens on Blocking > Blocking Schedule (#48)', () => {
  assert.equal(DEFAULT_ITEM_ID, 'blocking');
  const dest = resolveDestination(undefined, undefined);
  assert.equal(dest.item.id, 'blocking');
  assert.equal(dest.page, 'blocking-schedule');
  assert.equal(dest.webview, null);
});

test('a remembered sub-page is used when it belongs to the item', () => {
  assert.equal(resolveDestination('settings', 'settings-account').page, 'settings-account');
  assert.equal(resolveDestination('settings', 'keyword-blocking').page, 'settings-ui');
});

test('webview items resolve to their webview', () => {
  const dest = resolveDestination('todo-list');
  assert.equal(dest.webview, 'todo-list');
  assert.equal(dest.page, null);
});

test('focus session label shows the session and its clock while one runs', () => {
  const item = allItems().find((i) => i.id === 'focus-session');
  assert.equal(itemLabel(item), 'Start Focus Session');
  assert.equal(itemLabel(item, { focusActive: true }), 'Focusing');
  assert.equal(itemLabel(item, { focusActive: true, focusClock: '24:10' }), 'Focusing · 24:10');
  assert.equal(itemLabel(item, { focusClock: '24:10' }), 'Start Focus Session');
});

test('Start Focus Session opens the focus page instead of toggling blocking (#141)', () => {
  const dest = resolveDestination('focus-session');
  assert.equal(dest.page, 'focus-session');
  assert.equal(dest.webview, null);
  assert.equal(dest.item.action, undefined);
});

test('the main process can only send the window to pages that exist', () => {
  assert.equal(isNavigable('focus-session'), true);
  assert.equal(isNavigable('blocking'), true);
  assert.equal(isNavigable('nope'), false);
  assert.equal(isNavigable(undefined), false);
});

test('focus-session-result messages map to focus state', () => {
  assert.equal(focusStateFromResult('Focus session started'), true);
  assert.equal(focusStateFromResult('Focus session already active'), true);
  assert.equal(focusStateFromResult('Focus session stopped'), false);
  assert.equal(focusStateFromResult('Focus session already inactive'), false);
  assert.equal(focusStateFromResult('Failed to apply blocks'), null);
  assert.equal(focusStateFromResult(undefined), null);
});

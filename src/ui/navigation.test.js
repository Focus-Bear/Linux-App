import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allItems,
  DEFAULT_ITEM_ID,
  focusStateFromResult,
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

test('focus session label flips while a session runs', () => {
  const item = allItems().find((i) => i.id === 'focus-session');
  assert.equal(itemLabel(item), 'Start Focus Session');
  assert.equal(itemLabel(item, { focusActive: true }), 'Stop Focus Session');
});

test('focus-session-result messages map to focus state', () => {
  assert.equal(focusStateFromResult('Focus session started'), true);
  assert.equal(focusStateFromResult('Focus session already active'), true);
  assert.equal(focusStateFromResult('Focus session stopped'), false);
  assert.equal(focusStateFromResult('Focus session already inactive'), false);
  assert.equal(focusStateFromResult('Failed to apply blocks'), null);
  assert.equal(focusStateFromResult(undefined), null);
});

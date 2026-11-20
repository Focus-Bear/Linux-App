import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLocalSettings, SETTINGS_VERSION } from './localSettings.js';

const NOW = new Date('2026-11-21T01:02:03.000Z');

test('saving synced settings keeps what the setup wizard saved', () => {
  const merged = mergeLocalSettings(
    { setupComplete: true, selectedBrowsers: ['firefox'], urlList: ['old.com'] },
    { urlList: ['facebook.com', 'celebrity'], immediatelyBlock: true },
    NOW,
  );
  assert.equal(merged.setupComplete, true);
  assert.deepEqual(merged.selectedBrowsers, ['firefox']);
  assert.deepEqual(merged.urlList, ['facebook.com', 'celebrity']);
  assert.equal(merged.immediatelyBlock, true);
});

test('finishing setup keeps the synced settings already on disk', () => {
  const merged = mergeLocalSettings(
    { urlList: ['a.com'] },
    { setupComplete: true, selectedBrowsers: ['chrome'] },
    NOW,
  );
  assert.deepEqual(merged.urlList, ['a.com']);
  assert.equal(merged.setupComplete, true);
});

test('every save is stamped', () => {
  const merged = mergeLocalSettings({ lastModified: 'old', version: '0.0.1' }, {}, NOW);
  assert.equal(merged.lastModified, '2026-11-21T01:02:03.000Z');
  assert.equal(merged.version, SETTINGS_VERSION);
});

test('a missing or broken file is treated as empty', () => {
  for (const existing of [null, undefined, 'text', 7, ['a']]) {
    const merged = mergeLocalSettings(existing, { setupComplete: true }, NOW);
    assert.deepEqual(Object.keys(merged).sort(), ['lastModified', 'setupComplete', 'version']);
  }
  assert.deepEqual(Object.keys(mergeLocalSettings({ a: 1 }, null, NOW)).sort(), ['a', 'lastModified', 'version']);
});

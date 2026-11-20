import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BLOCK_SETTINGS, blockSettingsMessage, normaliseBlockSettings } from './blockSettings.js';

test('immediate blocking is off by default', () => {
  assert.deepEqual(DEFAULT_BLOCK_SETTINGS, { immediatelyBlock: false });
  assert.deepEqual(normaliseBlockSettings(undefined), { immediatelyBlock: false });
  assert.deepEqual(normaliseBlockSettings(null), { immediatelyBlock: false });
});

test('only a real true switches immediate blocking on', () => {
  assert.deepEqual(normaliseBlockSettings({ immediatelyBlock: true }), { immediatelyBlock: true });
  assert.deepEqual(normaliseBlockSettings({ immediatelyBlock: 'true' }), { immediatelyBlock: false });
  assert.deepEqual(normaliseBlockSettings({ immediatelyBlock: 1 }), { immediatelyBlock: false });
});

test('other settings (a whole settings.json) are not passed on to the extensions', () => {
  assert.deepEqual(
    normaliseBlockSettings({ immediatelyBlock: true, urlList: ['a.com'], setupComplete: true }),
    { immediatelyBlock: true },
  );
});

test('the message for the native hosts is one line of JSON', () => {
  const line = blockSettingsMessage({ immediatelyBlock: true }, 1234);
  assert.ok(line.endsWith('\n'));
  assert.equal(line.trim().includes('\n'), false);
  assert.deepEqual(JSON.parse(line), {
    type: 'BLOCK_SETTINGS_UPDATE',
    data: { immediatelyBlock: true },
    timestamp: 1234,
  });
});

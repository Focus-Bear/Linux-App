import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePreference,
  readPreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  webviewTheme,
  writePreference,
} from './theme.js';

const memoryStorage = (initial = {}) => {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    data,
  };
};

test('unknown or missing preferences fall back to following the system', () => {
  assert.equal(normalizePreference(undefined), 'system');
  assert.equal(normalizePreference('purple'), 'system');
  assert.equal(normalizePreference('dark'), 'dark');
});

test('system preference follows the OS colour scheme', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});

test('an explicit choice wins over the OS colour scheme', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});

test('webviews get the LIGHT/DARK values the dashboard expects', () => {
  assert.equal(webviewTheme('dark'), 'DARK');
  assert.equal(webviewTheme('light'), 'LIGHT');
});

test('preference round-trips through storage and tolerates broken storage', () => {
  const storage = memoryStorage();
  assert.equal(readPreference(storage), 'system');
  writePreference(storage, 'dark');
  assert.equal(storage.data[THEME_STORAGE_KEY], 'dark');
  assert.equal(readPreference(storage), 'dark');

  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readPreference(throwing), 'system');
  assert.doesNotThrow(() => writePreference(throwing, 'light'));
});

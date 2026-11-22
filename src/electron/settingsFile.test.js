import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsFile } from './settingsFile.js';

async function temporaryFile() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'fb-settings-'));
  return { dir, path: join(dir, 'settings.json') };
}

test("saves that overlap each keep the other's keys", async () => {
  const { path } = await temporaryFile();
  await fs.writeFile(path, JSON.stringify({ setupComplete: true, selectedBrowsers: ['firefox'] }));
  const file = createSettingsFile({ path, fs });
  // Device registration, the settings sync and onboarding all save at start-up.
  await Promise.all([
    file.update({ devices: { 'auth0|a': 'device-1' } }),
    file.update({ urlList: ['facebook.com'], immediatelyBlock: true }),
    file.update({ onboardingDone: { 'auth0|a': true } }),
  ]);
  const saved = JSON.parse(await fs.readFile(path, 'utf8'));
  assert.equal(saved.setupComplete, true);
  assert.deepEqual(saved.devices, { 'auth0|a': 'device-1' });
  assert.deepEqual(saved.urlList, ['facebook.com']);
  assert.deepEqual(saved.onboardingDone, { 'auth0|a': true });
});

test('a write that fails is reported and leaves the old file whole', async () => {
  const { path } = await temporaryFile();
  await fs.writeFile(path, JSON.stringify({ setupComplete: true }));
  const broken = {
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    rename: async () => {
      throw new Error('disk full');
    },
  };
  const file = createSettingsFile({ path, fs: broken });
  await assert.rejects(() => file.update({ urlList: ['x.com'] }), /disk full/);
  assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), { setupComplete: true });
  // The next save still works.
  const working = createSettingsFile({ path, fs });
  await working.update({ urlList: ['x.com'] });
  assert.equal((await working.read()).setupComplete, true);
});

test('the file is replaced in one step and is readable by this user only', async () => {
  const { dir, path } = await temporaryFile();
  const file = createSettingsFile({ path, fs });
  await file.update({ setupComplete: true });
  assert.deepEqual((await fs.readdir(dir)).sort(), ['settings.json'], 'no temporary file left behind');
  assert.equal((await fs.stat(path)).mode & 0o077, 0);
});

test('keys can be removed with a function; a missing or broken file reads as null', async () => {
  const { path } = await temporaryFile();
  const file = createSettingsFile({ path, fs });
  assert.equal(await file.read(), null);
  await fs.writeFile(path, '{ half a fi');
  assert.equal(await file.read(), null);
  await file.update({ setupComplete: true, urlList: ['a.com'], settingsOwner: 'auth0|a' });
  await file.update((existing) => {
    const rest = { ...existing };
    delete rest.urlList;
    delete rest.settingsOwner;
    return rest;
  });
  const saved = await file.read();
  assert.equal(saved.setupComplete, true);
  assert.equal('urlList' in saved, false);
});

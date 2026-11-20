import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completedBody, createHabitApi, HabitApiError, skippedBody } from './habitApiCore.js';
import { DEVICE_OPERATING_SYSTEM, deviceBody, ensureDevice, isDeviceId, savedDeviceId, withDevice } from './deviceCore.js';

const DEVICE = '11e6ce07-689b-4e75-9b00-c9e3b448180f';
const OTHER = '22222222-689b-4e75-9b00-c9e3b448180f';
const HABIT = { id: 'habit-1', name: 'Stretch', seconds: 300, sequenceId: 'seq-1' };
const T0 = Date.UTC(2026, 10, 21, 6, 0, 0);

/** A fetch that answers from a queue of [status, body] and records the calls. */
function queuedFetch(answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const [status, body] = answers.shift() || [500, null];
    return { ok: status >= 200 && status < 300, status, text: async () => (body === null ? '' : JSON.stringify(body)) };
  };
  return { fetch, calls };
}

// --- device ------------------------------------------------------------------

test('the device registers as Web (the server has no Linux yet) and says Linux in metadata', () => {
  assert.equal(DEVICE_OPERATING_SYSTEM, 'Web');
  assert.deepEqual(deviceBody('0.1.0'), {
    operating_system: 'Web',
    metadata: { platform: 'Linux', app: 'Focus Bear Linux', app_version: '0.1.0' },
  });
  assert.deepEqual(deviceBody().metadata, { platform: 'Linux', app: 'Focus Bear Linux' });
});

test('a saved device id is per account and must be a UUID', () => {
  assert.equal(isDeviceId(DEVICE), true);
  assert.equal(isDeviceId('nope'), false);
  assert.equal(isDeviceId(undefined), false);
  const settings = { devices: { 'auth0|a': DEVICE, 'auth0|b': 'broken' } };
  assert.equal(savedDeviceId(settings, 'auth0|a'), DEVICE);
  assert.equal(savedDeviceId(settings, 'auth0|b'), null);
  assert.equal(savedDeviceId(settings, 'auth0|c'), null);
  assert.equal(savedDeviceId(null, 'auth0|a'), null);
  assert.deepEqual(withDevice(settings, 'auth0|c', OTHER), { 'auth0|a': DEVICE, 'auth0|b': 'broken', 'auth0|c': OTHER });
});

test('an install with a saved device id does not register again', async () => {
  const requests = [];
  const id = await ensureDevice({
    request: async (...args) => requests.push(args),
    loadSettings: async () => ({ devices: { 'auth0|a': DEVICE } }),
    saveSettings: async () => {},
    userId: 'auth0|a',
  });
  assert.equal(id, DEVICE);
  assert.equal(requests.length, 0);
});

test('a new install registers with POST /device and saves the id for the account', async () => {
  const requests = [];
  const saved = [];
  const id = await ensureDevice({
    request: async (method, path, body) => {
      requests.push({ method, path, body });
      return { id: DEVICE, operating_system: 'Web' };
    },
    loadSettings: async () => ({ setupComplete: true, devices: { 'auth0|other': OTHER } }),
    saveSettings: async (patch) => saved.push(patch),
    userId: 'auth0|a',
    appVersion: '0.1.0',
  });
  assert.equal(id, DEVICE);
  assert.deepEqual(requests, [{ method: 'POST', path: '/device', body: deviceBody('0.1.0') }]);
  assert.deepEqual(saved, [{ devices: { 'auth0|other': OTHER, 'auth0|a': DEVICE } }]);
});

test('force registers again even with a saved id, and a missing settings file is fine', async () => {
  let posts = 0;
  const request = async () => {
    posts += 1;
    return { id: OTHER };
  };
  const forced = await ensureDevice({
    request,
    loadSettings: async () => ({ devices: { u: DEVICE } }),
    saveSettings: async () => {},
    userId: 'u',
    force: true,
  });
  assert.equal(forced, OTHER);
  const fresh = await ensureDevice({
    request,
    loadSettings: async () => {
      throw new Error('no file');
    },
    saveSettings: async () => {
      throw new Error('read-only');
    },
    userId: 'u',
  });
  assert.equal(fresh, OTHER);
  assert.equal(posts, 2);
});

test('a registration answer without an id is an error', async () => {
  await assert.rejects(
    ensureDevice({ request: async () => ({}), loadSettings: async () => null, saveSettings: async () => {}, userId: 'u' }),
    /device id/,
  );
});

// --- habits ------------------------------------------------------------------

test('the completed body matches what the Windows app sends', () => {
  assert.deepEqual(completedBody(HABIT, DEVICE, { startMs: T0, finishMs: T0 + 300000, seconds: 300 }), {
    activity_id: 'habit-1',
    duration_logged: 300,
    device_id: DEVICE,
    activity_sequence_id: 'seq-1',
    start_time: '2026-11-21T06:00:00.000Z',
    finish_time: '2026-11-21T06:05:00.000Z',
    metadata: {},
  });
  const already = completedBody(HABIT, DEVICE, { startMs: T0, finishMs: T0 + 1000, seconds: 1, alreadyDid: true });
  assert.deepEqual(already.metadata, { skipped_did_complete: true });
  assert.equal(completedBody({ id: 'x' }, DEVICE, { startMs: T0, finishMs: T0, seconds: 12.6 }).duration_logged, 13);
  assert.equal(completedBody({ id: 'x' }, DEVICE, { startMs: T0, finishMs: T0, seconds: -4 }).activity_sequence_id, '');
});

test('the skip body carries the habit, its sequence and the device', () => {
  assert.deepEqual(skippedBody(HABIT, DEVICE), { activity_id: 'habit-1', device_id: DEVICE, activity_sequence_id: 'seq-1' });
});

const make = (answers, getDeviceId = async () => DEVICE) => {
  const { fetch, calls } = queuedFetch(answers);
  return { calls, api: createHabitApi({ fetch, getToken: async () => 'tok', getDeviceId, baseUrl: 'https://api.test' }) };
};

test('done posts to /completed-activity and skip to /completed-activity/skip, with the bearer token', async () => {
  const { api, calls } = make([[201, { id: 'c1' }], [201, null]]);
  await api.completeHabit(HABIT, { startMs: T0, finishMs: T0 + 300000, seconds: 300 });
  await api.skipHabit(HABIT);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    'POST https://api.test/completed-activity',
    'POST https://api.test/completed-activity/skip',
  ]);
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].body.device_id, DEVICE);
  assert.equal(calls[0].body.duration_logged, 300);
  assert.deepEqual(calls[1].body, skippedBody(HABIT, DEVICE));
});

test('a device the server no longer knows (404) is registered again and the call is retried once', async () => {
  const asked = [];
  const getDeviceId = async (request, force) => {
    asked.push(force);
    return force ? OTHER : DEVICE;
  };
  const { api, calls } = make([[404, { message: 'Device does not exist' }], [201, null]], getDeviceId);
  await api.completeHabit(HABIT, { startMs: T0, finishMs: T0 + 1000, seconds: 1 });
  assert.deepEqual(asked, [false, true]);
  assert.deepEqual(calls.map((c) => c.body.device_id), [DEVICE, OTHER]);
});

test('other failures are not retried and carry the status', async () => {
  const { api, calls } = make([[500, null]]);
  await assert.rejects(api.skipHabit(HABIT), (error) => error instanceof HabitApiError && error.status === 500);
  assert.equal(calls.length, 1);
});

test('nothing is sent when signed out', async () => {
  const { fetch, calls } = queuedFetch([]);
  const api = createHabitApi({ fetch, getToken: async () => null, getDeviceId: async (request) => request('POST', '/device', {}) });
  await assert.rejects(api.registerDevice(), (error) => error.status === 401);
  assert.equal(calls.length, 0);
});

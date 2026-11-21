import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completedBody, createHabitApi, HabitApiError, skippedBody } from './habitApiCore.js';
import {
  DEVICE_OPERATING_SYSTEM,
  FALLBACK_OPERATING_SYSTEM,
  MIGRATION_RETRY_MS,
  deviceBody,
  ensureDevice,
  isDeviceId,
  savedDeviceId,
  savedDeviceOs,
  withDevice,
  withDeviceOs,
} from './deviceCore.js';

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

/** A `request` that answers from a queue of bodies (or throws a queued error) and records the calls. */
function queuedRequest(answers) {
  const requests = [];
  const request = async (method, path, body) => {
    requests.push({ method, path, body });
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { request, requests };
}

const refused = (status = 400) => new HabitApiError(`refused: ${status}`, status);

test('the device registers as Linux and says so in metadata too', () => {
  assert.equal(DEVICE_OPERATING_SYSTEM, 'Linux');
  assert.equal(FALLBACK_OPERATING_SYSTEM, 'Web');
  assert.deepEqual(deviceBody('0.1.0'), {
    operating_system: 'Linux',
    metadata: { platform: 'Linux', app: 'Focus Bear Linux', app_version: '0.1.0' },
  });
  assert.deepEqual(deviceBody().metadata, { platform: 'Linux', app: 'Focus Bear Linux' });
  assert.deepEqual(deviceBody('0.1.0', 'Web'), {
    operating_system: 'Web',
    metadata: { platform: 'Linux', app: 'Focus Bear Linux', app_version: '0.1.0' },
  });
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

test('a device saved before the app could register as Linux counts as Web', () => {
  const settings = { devices: { 'auth0|a': DEVICE, 'auth0|b': OTHER }, deviceOs: { 'auth0|b': 'Linux', 'auth0|c': 'Solaris' } };
  assert.equal(savedDeviceOs(settings, 'auth0|a'), 'Web');
  assert.equal(savedDeviceOs(settings, 'auth0|b'), 'Linux');
  assert.equal(savedDeviceOs(settings, 'auth0|c'), 'Web');
  assert.equal(savedDeviceOs(null, 'auth0|a'), 'Web');
  assert.deepEqual(withDeviceOs(settings, 'auth0|a', 'Linux'), { 'auth0|a': 'Linux', 'auth0|b': 'Linux', 'auth0|c': 'Solaris' });
});

test('an install registered as Linux does not register or migrate again', async () => {
  const { request, requests } = queuedRequest([]);
  const id = await ensureDevice({
    request,
    loadSettings: async () => ({ devices: { 'auth0|a': DEVICE }, deviceOs: { 'auth0|a': 'Linux' } }),
    saveSettings: async () => {},
    userId: 'auth0|a',
    attempts: new Map(),
  });
  assert.equal(id, DEVICE);
  assert.equal(requests.length, 0);
});

test('a new install registers as Linux with POST /device and saves the id and the operating system', async () => {
  const { request, requests } = queuedRequest([{ id: DEVICE, operating_system: 'Linux' }]);
  const saved = [];
  const id = await ensureDevice({
    request,
    loadSettings: async () => ({ setupComplete: true, devices: { 'auth0|other': OTHER } }),
    saveSettings: async (patch) => saved.push(patch),
    userId: 'auth0|a',
    appVersion: '0.1.0',
    attempts: new Map(),
  });
  assert.equal(id, DEVICE);
  assert.deepEqual(requests, [{ method: 'POST', path: '/device', body: deviceBody('0.1.0') }]);
  assert.deepEqual(saved, [{ devices: { 'auth0|other': OTHER, 'auth0|a': DEVICE }, deviceOs: { 'auth0|a': 'Linux' } }]);
});

for (const status of [400, 409, 422]) {
  test(`a server without Linux (${status}) gets the Web registration, as before`, async () => {
    const { request, requests } = queuedRequest([refused(status), { id: DEVICE, operating_system: 'Web' }]);
    const saved = [];
    const attempts = new Map();
    const id = await ensureDevice({
      request,
      loadSettings: async () => ({}),
      saveSettings: async (patch) => saved.push(patch),
      userId: 'auth0|a',
      appVersion: '0.1.0',
      now: T0,
      attempts,
    });
    assert.equal(id, DEVICE);
    assert.deepEqual(requests, [
      { method: 'POST', path: '/device', body: deviceBody('0.1.0') },
      { method: 'POST', path: '/device', body: deviceBody('0.1.0', 'Web') },
    ]);
    assert.deepEqual(saved, [{ devices: { 'auth0|a': DEVICE }, deviceOs: { 'auth0|a': 'Web' } }]);
    // It was refused a moment ago: the next call uses the Web id without asking again.
    const again = await ensureDevice({
      request,
      loadSettings: async () => ({ devices: { 'auth0|a': DEVICE }, deviceOs: { 'auth0|a': 'Web' } }),
      saveSettings: async (patch) => saved.push(patch),
      userId: 'auth0|a',
      now: T0 + 60000,
      attempts,
    });
    assert.equal(again, DEVICE);
    assert.equal(requests.length, 2);
  });
}

test('registering fails when the server is down or the user is signed out: no Web fallback', async () => {
  for (const status of [401, 500]) {
    const { request, requests } = queuedRequest([refused(status)]);
    await assert.rejects(
      ensureDevice({ request, loadSettings: async () => ({}), saveSettings: async () => {}, userId: 'u', attempts: new Map() }),
      (error) => error.status === status,
    );
    assert.equal(requests.length, 1);
  }
});

test('a saved Web registration becomes Linux with PATCH /device/{id}, keeping the id', async () => {
  for (const settings of [{ devices: { 'auth0|a': DEVICE } }, { devices: { 'auth0|a': DEVICE }, deviceOs: { 'auth0|a': 'Web' } }]) {
    const { request, requests } = queuedRequest([{ id: DEVICE, operating_system: 'Linux' }]);
    const saved = [];
    const id = await ensureDevice({
      request,
      loadSettings: async () => settings,
      saveSettings: async (patch) => saved.push(patch),
      userId: 'auth0|a',
      attempts: new Map(),
    });
    assert.equal(id, DEVICE);
    assert.deepEqual(requests, [{ method: 'PATCH', path: `/device/${DEVICE}`, body: { operating_system: 'Linux' } }]);
    assert.deepEqual(saved, [{ deviceOs: { 'auth0|a': 'Linux' } }]);
  }
});

test('while the server refuses Linux the Web id is kept, and it is asked again only after a while', async () => {
  const { request, requests } = queuedRequest([refused(400), refused(500), { id: DEVICE }]);
  const saved = [];
  const attempts = new Map();
  const call = (now) =>
    ensureDevice({
      request,
      loadSettings: async () => ({ devices: { 'auth0|a': DEVICE } }),
      saveSettings: async (patch) => saved.push(patch),
      userId: 'auth0|a',
      now,
      attempts,
    });
  assert.equal(await call(T0), DEVICE); // refused
  assert.equal(await call(T0 + 1000), DEVICE); // not asked
  assert.equal(await call(T0 + MIGRATION_RETRY_MS - 1), DEVICE); // not asked
  assert.equal(requests.length, 1);
  assert.equal(await call(T0 + MIGRATION_RETRY_MS), DEVICE); // asked: server error, still Web
  assert.equal(requests.length, 2);
  assert.deepEqual(saved, []);
  assert.equal(await call(T0 + 2 * MIGRATION_RETRY_MS), DEVICE); // asked: accepted
  assert.equal(requests.length, 3);
  assert.deepEqual(saved, [{ deviceOs: { 'auth0|a': 'Linux' } }]);
  assert.equal(requests.every((r) => r.method === 'PATCH'), true);
});

test('one account being refused does not hold back another', async () => {
  const { request, requests } = queuedRequest([refused(400), { id: OTHER }]);
  const attempts = new Map();
  const settings = { devices: { a: DEVICE, b: OTHER } };
  const call = (userId) =>
    ensureDevice({ request, loadSettings: async () => settings, saveSettings: async () => {}, userId, now: T0, attempts });
  assert.equal(await call('a'), DEVICE);
  assert.equal(await call('b'), OTHER);
  assert.deepEqual(requests.map((r) => r.path), [`/device/${DEVICE}`, `/device/${OTHER}`]);
});

test('a saved Web device the account no longer has is registered again, as Linux', async () => {
  const { request, requests } = queuedRequest([refused(404), { id: OTHER, operating_system: 'Linux' }]);
  const saved = [];
  const id = await ensureDevice({
    request,
    loadSettings: async () => ({ devices: { 'auth0|a': DEVICE } }),
    saveSettings: async (patch) => saved.push(patch),
    userId: 'auth0|a',
    appVersion: '0.1.0',
    attempts: new Map(),
  });
  assert.equal(id, OTHER);
  assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), [`PATCH /device/${DEVICE}`, 'POST /device']);
  assert.deepEqual(saved, [{ devices: { 'auth0|a': OTHER }, deviceOs: { 'auth0|a': 'Linux' } }]);
});

test('force registers again even with a saved id, and a missing settings file is fine', async () => {
  let posts = 0;
  const request = async (method) => {
    assert.equal(method, 'POST');
    posts += 1;
    return { id: OTHER };
  };
  const forced = await ensureDevice({
    request,
    loadSettings: async () => ({ devices: { u: DEVICE } }),
    saveSettings: async () => {},
    userId: 'u',
    force: true,
    attempts: new Map(),
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
    attempts: new Map(),
  });
  assert.equal(fresh, OTHER);
  assert.equal(posts, 2);
});

test('a registration answer without an id is an error', async () => {
  await assert.rejects(
    ensureDevice({ request: async () => ({}), loadSettings: async () => null, saveSettings: async () => {}, userId: 'u', attempts: new Map() }),
    /device id/,
  );
});

test('through the real request: 400 for Linux, then Web is accepted', async () => {
  const { fetch, calls } = queuedFetch([[400, { message: ['operating_system must be one of the following values'] }], [201, { id: DEVICE }]]);
  const saved = [];
  const api = createHabitApi({
    fetch,
    getToken: async () => 'token',
    getDeviceId: (request, force) =>
      ensureDevice({ request, loadSettings: async () => ({}), saveSettings: async (patch) => saved.push(patch), userId: 'u', force, attempts: new Map() }),
  });
  assert.equal(await api.registerDevice(), DEVICE);
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.body.operating_system]), [
    ['POST', 'https://api.focusbear.io/device', 'Linux'],
    ['POST', 'https://api.focusbear.io/device', 'Web'],
  ]);
  assert.deepEqual(saved, [{ devices: { u: DEVICE }, deviceOs: { u: 'Web' } }]);
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

test('a request without a body does not announce JSON (the server refuses such a DELETE)', async () => {
  const { api, calls } = make([[204, null], [200, []]]);
  await api.request('DELETE', '/blocking-schedules/s1');
  await api.request('PUT', '/focus-mode', []);
  assert.equal('Content-Type' in calls[0].headers, false);
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[1].headers['Content-Type'], 'application/json');
});

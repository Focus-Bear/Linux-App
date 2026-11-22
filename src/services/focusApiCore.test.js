import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFocusApi, FocusApiError } from './focusApiCore.js';
import { createSession, endSession } from '../electron/focusSessionModel.js';

const T0 = Date.UTC(2026, 10, 21, 9, 0, 0);
const MIN = 60 * 1000;

/** A fetch that records calls and answers from a list of [status, body] replies. */
function fakeFetch(replies) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const [status, body] = replies.shift() || [200, null];
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === null || body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  return { fetch, calls };
}

const api = (replies, extra = {}) => {
  const { fetch, calls } = fakeFetch(replies);
  return { calls, api: createFocusApi({ fetch, getToken: async () => 'tok', baseUrl: 'https://api.test', newId: () => 'new-id', ...extra }) };
};

const session = () => createSession({ modeId: 'mode 1', modeName: 'Deep Work', intention: 'Report', minutes: 25, now: T0, synced: true });

test('block lists come from GET /user/focus-modes with the bearer token', async () => {
  const { api: focusApi, calls } = api([[200, [{ id: 'a', name: 'Work' }]]]);
  assert.deepEqual(await focusApi.getFocusModes(), [{ id: 'a', name: 'Work' }]);
  assert.equal(calls[0].url, 'https://api.test/user/focus-modes');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].body, undefined);
});

test('an unexpected block-list response is treated as none', async () => {
  const { api: focusApi } = api([[200, { message: 'hm' }]]);
  assert.deepEqual(await focusApi.getFocusModes(), []);
});

test('starting posts to the chosen block list', async () => {
  const { api: focusApi, calls } = api([[201, {}]]);
  await focusApi.startSession(session());
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.test/focus-mode/mode%201/start');
  assert.deepEqual(calls[0].body, {
    intention: 'Report',
    finish_time: '2026-11-21T09:25:00.000Z',
    start_time: '2026-11-21T09:00:00.000Z',
    to_dos: [],
  });
});

test('finishing posts the time the session actually ended', async () => {
  const { api: focusApi, calls } = api([[201, '']]);
  await focusApi.finishSession(endSession(session(), T0 + 10 * MIN));
  assert.equal(calls[0].url, 'https://api.test/focus-mode/mode%201/finish');
  assert.equal(calls[0].body.finish_time, '2026-11-21T09:10:00.000Z');
  assert.deepEqual(calls[0].body.metadata, { focus_duration_seconds: 600 });
});

test('a changed finish time is PATCHed', async () => {
  const { api: focusApi, calls } = api([[200, {}]]);
  await focusApi.updateScheduledFinish(session());
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].url, 'https://api.test/focus-mode/mode%201/update_scheduled_finish');
  assert.deepEqual(calls[0].body, { scheduled_finish_time: '2026-11-21T09:25:00.000Z' });
});

test('an account without a default block list gets one created', async () => {
  const { api: focusApi, calls } = api([[201, {}]]);
  const mode = await focusApi.ensureDefaultMode([{ id: 'm', name: 'Meetings', metadata: { isMeetings: true } }]);
  assert.equal(mode.id, 'new-id');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.test/focus-mode');
  assert.equal(calls[0].body.metadata.isDefault, true);
});

test('an existing default block list is reused, with no request', async () => {
  const { api: focusApi, calls } = api([]);
  const existing = { id: 'd', name: 'Block super distracting sites/apps', metadata: { isDefault: true } };
  assert.equal(await focusApi.ensureDefaultMode([existing]), existing);
  assert.equal(calls.length, 0);
});

test('the reflection is attached to the finished row', async () => {
  const { api: focusApi, calls } = api([
    [200, [
      { id: 'row-8', focus_mode: { id: 'mode 1' }, start_time: '2026-11-20T09:00:00.000Z' }, // yesterday, same block list
      { id: 'row-9', focus_mode: { id: 'mode 1' }, start_time: '2026-11-21T09:00:00.000Z' },
    ]],
    [200, {}],
  ]);
  assert.equal(await focusApi.saveReflection(session(), { achievements: 'Two pages', stars: 4 }), true);
  assert.equal(calls[0].url, 'https://api.test/user/weekly-focus-block-summary?limit=5&offset=0');
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].url, 'https://api.test/user/weekly-focus-block-summary/row-9');
  assert.deepEqual(calls[1].body, { achievements: 'Two%20pages', focus_stars: 4 });
});

test('nothing is sent for an empty reflection, and a missing row is reported', async () => {
  const empty = api([]);
  assert.equal(await empty.api.saveReflection(session(), { achievements: '', stars: 0 }), false);
  assert.equal(empty.calls.length, 0);

  const missing = api([[200, []]]);
  assert.equal(await missing.api.saveReflection(session(), { stars: 3 }), false);
  assert.equal(missing.calls.length, 1);
});

test("a reflection is not put on the previous session's row when this one never reached the server", async () => {
  const { api: focusApi, calls } = api([[200, [{ id: 'row-8', focus_mode: { id: 'mode 1' }, start_time: '2026-11-20T09:00:00.000Z' }]]]);
  assert.equal(await focusApi.saveReflection(session(), { achievements: 'Wrong row', stars: 5 }), false);
  assert.equal(calls.length, 1, 'no PATCH');
});

test('a failed load of the block lists never creates a second default list', async () => {
  const existing = { id: 'd', name: 'Block super distracting sites/apps', metadata: { isDefault: true } };
  // The start screen's GET failed (modes: null). Start reads the lists again: the default is there.
  const retry = api([[200, [existing]]]);
  assert.equal((await retry.api.resolveMode({ modes: null, modeId: '' })).id, 'd');
  assert.deepEqual(retry.calls.map((call) => call.method), ['GET'], 'no POST /focus-mode');

  // Still unreachable: it throws and nothing is created (the session starts unsynced).
  const down = api([[502, 'bad gateway']]);
  await assert.rejects(down.api.resolveMode({ modes: null, modeId: '' }), (error) => error.status === 502);
  assert.deepEqual(down.calls.map((call) => call.method), ['GET']);

  // A load that worked and found no default list: only then is one created.
  const fresh = api([[201, {}]]);
  assert.equal((await fresh.api.resolveMode({ modes: [], modeId: '' })).id, 'new-id');
  assert.deepEqual(fresh.calls.map((call) => call.method), ['POST']);

  // The chosen list is used as it is.
  const chosen = api([]);
  assert.equal((await chosen.api.resolveMode({ modes: [existing, { id: 'w', name: 'Work' }], modeId: 'w' })).id, 'w');
  assert.equal(chosen.calls.length, 0);
});

test('a server error is thrown with its status', async () => {
  const { api: focusApi } = api([[500, 'boom']]);
  await assert.rejects(focusApi.startSession(session()), (error) => error instanceof FocusApiError && error.status === 500);
});

test('without a token nothing is sent', async () => {
  const { api: focusApi, calls } = api([], { getToken: async () => null });
  await assert.rejects(focusApi.getFocusModes(), (error) => error instanceof FocusApiError && error.status === 401);
  assert.equal(calls.length, 0);
});

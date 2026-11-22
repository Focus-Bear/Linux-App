import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDayLoader } from './dayPlanLoader.js';

/** A loadDay whose answers are given by hand, in any order: answer(day, data) / fail(day). */
function manualApi() {
  const waiting = [];
  return {
    loadDay: (day) => new Promise((resolve, reject) => waiting.push({ day, resolve, reject })),
    answer(day, extra = {}) {
      const at = waiting.findIndex((item) => item.day === day);
      waiting.splice(at, 1)[0].resolve({ day, ...extra });
    },
    fail(day) {
      const at = waiting.findIndex((item) => item.day === day);
      waiting.splice(at, 1)[0].reject(new Error('offline'));
    },
  };
}

test('a day loads and is shown', async () => {
  const api = manualApi();
  const loader = createDayLoader({ loadDay: api.loadDay });
  const done = loader.show('2026-11-21');
  assert.deepEqual(loader.get(), { day: '2026-11-21', data: null, status: 'loading' });
  api.answer('2026-11-21', { tasks: ['t'] });
  assert.equal(await done, true);
  assert.deepEqual(loader.get(), { day: '2026-11-21', data: { day: '2026-11-21', tasks: ['t'] }, status: 'ready' });
});

test('a late answer for a day already left is ignored', async () => {
  const api = manualApi();
  const loader = createDayLoader({ loadDay: api.loadDay });
  // › pressed twice quickly: the 22nd is asked for, then the 23rd.
  const first = loader.show('2026-11-22');
  const second = loader.show('2026-11-23');
  // The 23rd answers first, the 22nd afterwards.
  api.answer('2026-11-23');
  assert.equal(await second, true);
  api.answer('2026-11-22');
  assert.equal(await first, false);
  const state = loader.get();
  assert.equal(state.day, '2026-11-23');
  assert.equal(state.data.day, '2026-11-23', 'the page keeps the day it is on');
  assert.equal(state.status, 'ready');
});

test('a late failure for a day already left does not turn the page into an error', async () => {
  const api = manualApi();
  const loader = createDayLoader({ loadDay: api.loadDay });
  const first = loader.show('2026-11-22');
  const second = loader.show('2026-11-23');
  // The 22nd fails while the 23rd is still on its way.
  api.fail('2026-11-22');
  assert.equal(await first, false);
  assert.deepEqual(loader.get(), { day: '2026-11-23', data: null, status: 'loading' });
  api.answer('2026-11-23');
  assert.equal(await second, true);
  assert.equal(loader.get().status, 'ready');
});

test('of two loads of the same day, only the later answer counts', async () => {
  const api = manualApi();
  const loader = createDayLoader({ loadDay: api.loadDay });
  const first = loader.show('2026-11-21');
  const second = loader.show('2026-11-21');
  api.answer('2026-11-21', { n: 1 }); // the first request
  api.answer('2026-11-21', { n: 2 }); // the second
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(loader.get().data.n, 2);
});

test('going to another day clears the page; a reload of the same day keeps it, also when it fails', async () => {
  const api = manualApi();
  const errors = [];
  const loader = createDayLoader({ loadDay: api.loadDay, onError: (error) => errors.push(error.message) });
  const first = loader.show('2026-11-21');
  api.answer('2026-11-21');
  await first;

  const reload = loader.show('2026-11-21');
  assert.equal(loader.get().status, 'ready', 'no spinner over a day that is already shown');
  assert.equal(loader.get().data.day, '2026-11-21');
  api.fail('2026-11-21');
  assert.equal(await reload, false);
  assert.equal(loader.get().status, 'ready', 'the last plan stays when a refresh fails');
  assert.deepEqual(errors, ['offline']);

  // Midnight: the day changes and its load fails. Yesterday must not stay on screen as "ready".
  const next = loader.show('2026-11-22');
  assert.deepEqual(loader.get(), { day: '2026-11-22', data: null, status: 'loading' });
  api.fail('2026-11-22');
  await next;
  assert.deepEqual(loader.get(), { day: '2026-11-22', data: null, status: 'error' });
});

test('listeners hear every change, and the page can edit the loaded data', async () => {
  const api = manualApi();
  const loader = createDayLoader({ loadDay: api.loadDay });
  let heard = 0;
  const off = loader.subscribe(() => {
    heard += 1;
  });
  loader.update(() => ({ never: true }));
  assert.equal(heard, 0, 'nothing to edit before a day is loaded');
  const done = loader.show('2026-11-21');
  api.answer('2026-11-21', { planEvents: [{ id: 'a' }] });
  await done;
  assert.equal(heard, 2);
  loader.update((data) => ({ ...data, planEvents: [] }));
  assert.deepEqual(loader.get().data.planEvents, []);
  off();
  loader.update((data) => data);
  assert.equal(heard, 3);
});

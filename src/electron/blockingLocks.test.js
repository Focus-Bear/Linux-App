// Strict blocking can't be edited away while it is in force; a finished break
// gives way to the next one; Grizzly Bear mode blocks outright.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIST_LOCKED, SCHEDULE_LOCKED, blockingLocks } from './blockingModel.js';
import { blocksNextBreak } from './breakModel.js';
import { effectiveImmediateBlock } from './blockSettings.js';
import { createBlockingStore } from '../services/blockingStoreCore.js';

const ID = (n) => `00000000-0000-4000-8000-00000000000${n}`;
// Monday 23 Nov 2026, local time.
const at = (time) => new Date(`2026-11-23T${time}:00`);
const schedule = (over = {}) => ({
  id: 's1',
  name: 'Work hours',
  start_time: '09:00:00',
  end_time: '17:00:00',
  days_of_week: [1, 2, 3, 4, 5],
  focus_mode_id: ID(1),
  block_level: 'strict',
  ...over,
});

test('a strict or super-strict schedule that is running locks itself and its block list', () => {
  const strict = schedule();
  const superStrict = schedule({ id: 's2', block_level: 'super-strict', focus_mode_id: ID(2) });
  const gentle = schedule({ id: 's3', block_level: 'gentle', focus_mode_id: ID(3) });
  const locks = blockingLocks({ schedules: [strict, superStrict, gentle], date: at('10:00') });
  assert.deepEqual([...locks.scheduleIds].sort(), ['s1', 's2']);
  assert.deepEqual([...locks.listIds].sort(), [ID(1), ID(2)]);

  // Outside its hours it can be edited like any other.
  const evening = blockingLocks({ schedules: [strict, superStrict, gentle], date: at('20:00') });
  assert.equal(evening.scheduleIds.size, 0);
  assert.equal(evening.listIds.size, 0);
  assert.equal(blockingLocks({ schedules: null, date: at('10:00') }).scheduleIds.size, 0);
});

test("a Captain or Pawfessor session locks the list it uses; a Junior session doesn't", () => {
  const lockedFor = (session) => [...blockingLocks({ schedules: [], session, date: at('10:00') }).listIds];
  assert.deepEqual(lockedFor({ status: 'running', strictness: 'pawfessor', modeId: ID(4) }), [ID(4)]);
  assert.deepEqual(lockedFor({ status: 'paused', strictness: 'captain', modeId: ID(4) }), [ID(4)]);
  assert.deepEqual(lockedFor({ status: 'running', strictness: 'junior', modeId: ID(4) }), []);
  assert.deepEqual(lockedFor({ status: 'ended', strictness: 'pawfessor', modeId: ID(4) }), []);
  assert.deepEqual(lockedFor(null), []);
});

function storeSetup(locks) {
  const calls = [];
  const lists = [{ id: ID(1), name: 'Study', allowed_urls: ['wikipedia.org'], metadata: { isAllowedListApproach: true } }];
  const schedules = [schedule()];
  const api = {
    getLists: async () => lists,
    getSchedules: async () => schedules,
    updateList: async (id, change) => {
      calls.push(`updateList ${id}`);
      const saved = change(lists[0]);
      return { saved, modes: [saved] };
    },
    deleteList: async (id) => calls.push(`deleteList ${id}`),
    saveSchedule: async (draft, existing) => {
      calls.push(`saveSchedule ${existing ? existing.id : 'new'}`);
      return { ...(existing || { id: 'new' }), name: draft.name };
    },
    deleteSchedule: async (id) => calls.push(`deleteSchedule ${id}`),
  };
  const store = createBlockingStore({ api, getLocks: () => locks, saveDelayMs: 0, log: { error() {} } });
  return { store, calls };
}

test('the store refuses to edit or delete a running strict schedule, whatever the page offers', async () => {
  const { store, calls } = storeSetup({ scheduleIds: new Set(['s1']), listIds: new Set([ID(1)]) });
  await store.load();
  assert.equal(await store.saveSchedule({ name: 'Free for all', days: [], start: '09:00', end: '09:01', modeId: ID(1) }, schedule()), false);
  assert.equal(store.get().error, SCHEDULE_LOCKED);
  assert.equal(await store.deleteSchedule('s1'), false);
  assert.equal(store.get().schedules.length, 1, 'still there');
  // A new schedule can still be added.
  assert.equal(await store.saveSchedule({ name: 'Evenings', days: [1], start: '18:00', end: '20:00', modeId: ID(1) }), true);
  assert.deepEqual(calls, ['saveSchedule new']);
});

test('the store refuses to empty, retype, rename or delete the list strict blocking is using', async () => {
  const { store, calls } = storeSetup({ scheduleIds: new Set(), listIds: new Set([ID(1)]) });
  await store.load();
  store.setListKind(ID(1), 'block'); // allow list -> block list would open every site
  store.editListEntries(ID(1), { add: ['youtube.com'] });
  store.setListEntries(ID(1), []);
  store.renameList(ID(1), 'Anything');
  assert.equal(await store.deleteList(ID(1)), false);
  await store.settled();
  assert.deepEqual(calls, [], 'nothing was sent');
  assert.equal(store.get().error, LIST_LOCKED);
  assert.deepEqual(store.get().modes[0].allowed_urls, ['wikipedia.org']);
  assert.equal(store.get().modes[0].metadata.isAllowedListApproach, true);
});

test('when the strict blocking ends the same edits go through', async () => {
  const locks = { scheduleIds: new Set(['s1']), listIds: new Set([ID(1)]) };
  const { store, calls } = storeSetup(locks);
  await store.load();
  store.renameList(ID(1), 'Blocked');
  await store.settled();
  assert.deepEqual(calls, []);
  store.setLocks(() => ({ scheduleIds: new Set(), listIds: new Set() }));
  store.renameList(ID(1), 'Reading');
  await store.settled();
  assert.equal(await store.deleteSchedule('s1'), true);
  assert.deepEqual(calls, [`updateList ${ID(1)}`, 'deleteSchedule s1']);
});

test('a finished break left on screen does not block the next break; one being played does', () => {
  assert.equal(blocksNextBreak({ phase: 'finished' }), false);
  assert.equal(blocksNextBreak({ phase: 'playing' }), true);
  assert.equal(blocksNextBreak({ phase: 'between' }), true);
  assert.equal(blocksNextBreak(null), false);
});

test('Grizzly Bear mode blocks outright, like "Immediately block", as in the Mac and Windows apps', () => {
  assert.equal(effectiveImmediateBlock({ immediatelyBlock: false, selectedBearMode: 'grizzly' }), true);
  assert.equal(effectiveImmediateBlock({ immediatelyBlock: true, selectedBearMode: 'cuddly' }), true);
  assert.equal(effectiveImmediateBlock({ immediatelyBlock: false, selectedBearMode: 'cuddly' }), false);
  assert.equal(effectiveImmediateBlock({ selectedBearMode: 'grizzly' }), true, 'a settings.json without the checkbox');
  assert.equal(effectiveImmediateBlock({ immediatelyBlock: 'true' }), false);
  assert.equal(effectiveImmediateBlock(null), false);
});

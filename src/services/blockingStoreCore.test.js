import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBlockingApi } from './blockingApiCore.js';
import { LIST_GONE, SAVE_FAILED, createBlockingStore } from './blockingStoreCore.js';

const ID = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const list = (n, name, blocked) => ({
  id: ID(n),
  name,
  allowed_urls: [],
  metadata: { isAllowedListApproach: false, blockUrlsArray: blocked, color: 'A3FFA1' },
});

/** A stand-in for the account: PUT /focus-mode updates the lists it is sent and leaves the others alone. */
function fakeAccount() {
  const account = {
    lists: [list(1, 'Social', ['reddit.com']), list(2, 'News', ['bbc.com']), { ...list(3, 'Meetings', []), metadata: { isMeetings: true } }],
    online: true,
    calls: [],
    async request(method, path, body) {
      account.calls.push({ method, path, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
      if (!account.online) throw Object.assign(new Error('offline'), { status: 0 });
      if (method === 'GET' && path === '/user/focus-modes') return JSON.parse(JSON.stringify(account.lists));
      if (method === 'GET' && path === '/blocking-schedules') return [];
      if (method === 'PUT' && path === '/focus-mode') {
        for (const sent of body) {
          const index = account.lists.findIndex((mode) => mode.id === sent.id);
          if (index < 0) throw Object.assign(new Error('not found'), { status: 404 });
          account.lists[index] = { ...account.lists[index], ...sent };
        }
        return account.lists;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    puts: () => account.calls.filter((call) => call.method === 'PUT'),
    byId: (n) => account.lists.find((mode) => mode.id === ID(n)),
  };
  return account;
}

function setup() {
  const account = fakeAccount();
  const api = createBlockingApi({ request: (...args) => account.request(...args), getDeviceId: async () => 'dev-1' });
  const store = createBlockingStore({ api, saveDelayMs: 0, log: { error() {} } });
  return { account, store };
}

test('editing one list sends only that list, read from the account just before', async () => {
  const { account, store } = setup();
  await store.load(); // the window's copy
  // Meanwhile, on the phone: a site is added to another list and to this one.
  account.byId(2).metadata.blockUrlsArray.push('added-on-phone.example');
  account.byId(1).metadata.blockUrlsArray.push('also-on-phone.example');
  account.byId(3).metadata.hiddenThing = 'keep';

  store.renameList(ID(1), 'Social media');
  assert.equal(store.get().modes[0].name, 'Social media', 'shown at once');
  await store.settled();

  assert.equal(account.puts().length, 1);
  assert.deepEqual(account.puts()[0].body.map((mode) => mode.id), [ID(1)], 'not every list of the account');
  const methods = account.calls.map((call) => `${call.method} ${call.path}`);
  assert.deepEqual(methods.slice(-2), ['GET /user/focus-modes', 'PUT /focus-mode']);
  assert.equal(account.byId(1).name, 'Social media');
  assert.deepEqual(account.byId(1).metadata.blockUrlsArray, ['reddit.com', 'also-on-phone.example'], "the phone's edit to this list survives");
  assert.deepEqual(account.byId(2).metadata.blockUrlsArray, ['bbc.com', 'added-on-phone.example'], 'the other list was not written back');
  assert.equal(account.byId(3).metadata.hiddenThing, 'keep', 'a hidden list is left alone');
  // The window now shows what the account has.
  assert.deepEqual(store.get().modes[1].metadata.blockUrlsArray, ['bbc.com', 'added-on-phone.example']);
});

test('adding and removing sites is applied to the fresh list, not to the old copy', async () => {
  const { account, store } = setup();
  await store.load();
  account.byId(1).metadata.blockUrlsArray.push('added-elsewhere.example');
  store.editListEntries(ID(1), { add: ['x.com'] });
  store.editListEntries(ID(1), { remove: ['reddit.com'] });
  await store.settled();
  assert.equal(account.puts().length, 1, 'two quick edits, one save');
  assert.deepEqual(account.byId(1).metadata.blockUrlsArray, ['added-elsewhere.example', 'x.com']);
});

test('a reload that lands while an edit is waiting does not undo it on screen', async () => {
  const { store } = setup();
  await store.load();
  store.renameList(ID(2), 'Newspapers');
  await store.load(); // the 15-minute reload arrives inside the save delay
  assert.equal(store.get().modes[1].name, 'Newspapers');
  await store.settled();
  assert.equal(store.get().modes[1].name, 'Newspapers');
});

test('a failed save is reported, nothing is half-written, and the window goes back to the account', async () => {
  const { account, store } = setup();
  await store.load();
  account.online = false;
  store.renameList(ID(1), 'Offline name');
  await store.settled();
  assert.equal(store.get().error, SAVE_FAILED);
  assert.equal(account.puts().length, 0);
  account.online = true;
  await store.load();
  assert.equal(store.get().modes[0].name, 'Social');
  assert.equal(store.get().stale, false);
});

test('a list deleted on another device is not recreated or written to', async () => {
  const { account, store } = setup();
  await store.load();
  account.lists = account.lists.filter((mode) => mode.id !== ID(1));
  store.renameList(ID(1), 'Ghost');
  await store.settled();
  assert.equal(store.get().error, LIST_GONE);
  assert.equal(account.puts().length, 0);
  assert.equal(store.get().modes.some((mode) => mode.id === ID(1)), false);
});

test('a reload that fails keeps the lists but marks them as an older copy', async () => {
  const { account, store } = setup();
  await store.load();
  account.online = false;
  await store.load();
  assert.equal(store.get().status, 'ready');
  assert.equal(store.get().stale, true);
});

test('after sign-out a queued edit is not sent and the lists are gone', async () => {
  const { account, store } = setup();
  await store.load();
  store.renameList(ID(1), 'Too late');
  store.reset();
  await store.settled();
  assert.equal(account.puts().length, 0);
  assert.deepEqual(store.get().modes, []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYNC, createSettingsSync, mergeList } from './settingsSyncCore.js';

const DEFAULTS = {
  selectedBearMode: 'cuddly',
  urlList: ['facebook.com', 'x.com'],
  immediatelyBlock: false,
  reducedMotion: false,
  pomodoroMinutes: 25,
};

// The account as the Mac and Windows apps left it: 15 blocked sites, Grizzly,
// immediate blocking, and keys the Linux app knows nothing about.
const FIFTEEN = Array.from({ length: 15 }, (_, i) => `site${i + 1}.example`);
const account = () => ({
  MacOS: {
    kArrBlockedUrls: [...FIFTEEN],
    kCuddlyModeEnabled: false,
    kImmediatelyBlockDistractingSites: true,
    kMacOnlyThing: { nested: [1, 2, 3] },
    has_edited_blocked_urls: true,
  },
  Windows: { kWindowsOnly: 'keep me' },
  Android: { phone: true },
  iOS: null,
  Web: { hasEditedSettings: true },
});

/** A stand-in for GET / PUT /user-local-device-settings with the server's merge (replace per platform). */
function fakeServer(initial = account()) {
  const server = {
    document: initial,
    online: true,
    getStatus: 200,
    calls: [],
    async request(method, body) {
      server.calls.push({ method, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
      if (!server.online) throw new TypeError('Failed to fetch');
      if (method === 'GET') {
        if (server.getStatus !== 200) return { status: server.getStatus, data: null };
        if (server.beforeGetAnswer) await server.beforeGetAnswer();
        return { status: 200, data: JSON.parse(JSON.stringify(server.document)) };
      }
      if (server.beforePut) await server.beforePut();
      server.document = Object.assign({ ...server.document }, body);
      return { status: 200, data: null };
    },
    puts: () => server.calls.filter((call) => call.method === 'PUT'),
  };
  return server;
}

function setup({ server = fakeServer(), local = null, userId = 'auth0|a' } = {}) {
  const timers = [];
  const applied = [];
  const disk = { value: local };
  const sync = createSettingsSync({
    defaults: DEFAULTS,
    request: (...args) => server.request(...args),
    loadLocal: async () => disk.value,
    saveLocal: async (copy) => {
      disk.value = { ...(disk.value || {}), ...copy };
    },
    getUserId: () => userId,
    onApply: (key, value) => applied.push([key, value]),
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: (id) => {
      timers[id - 1] = null;
    },
    log: { error() {} },
  });
  /** Runs the timers that are due (the save delay, the retries) until none is left. */
  const runTimers = async () => {
    for (let guard = 0; guard < 20; guard += 1) {
      const due = timers.splice(0).filter(Boolean);
      if (due.length === 0) return;
      for (const fn of due) await fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { sync, server, applied, disk, runTimers };
}

test('a list is merged three ways: local additions and removals, plus what another device added', () => {
  assert.deepEqual(mergeList(['a', 'b'], ['a', 'c'], ['a', 'b', 'd']), ['a', 'd', 'c']);
  assert.deepEqual(mergeList(['a'], ['a'], ['z']), ['z']);
  assert.deepEqual(mergeList(undefined, ['a'], undefined), ['a']);
});

test('the reviewer\'s scenario: a failed first load followed by a save does not overwrite the account', async () => {
  const { sync, server, runTimers } = setup();
  server.online = false; // the app starts before the network is up
  await sync.initialize();
  assert.equal(sync.status(), SYNC.OFFLINE, 'a failed load is not shown as "Synced"');
  assert.equal(sync.hasLoaded(), false);

  server.online = true; // the network returns; the person ticks one unrelated box
  await sync.setValue('reducedMotion', true);
  await runTimers();

  assert.equal(server.puts().length, 1);
  const sent = server.puts()[0].body;
  assert.deepEqual(Object.keys(sent), ['MacOS'], 'only the MacOS object is sent');
  assert.deepEqual(server.document.MacOS.kArrBlockedUrls, FIFTEEN, 'the 15 blocked sites are still there');
  assert.equal(server.document.MacOS.kCuddlyModeEnabled, false, 'Grizzly was not switched to Cuddly');
  assert.equal(server.document.MacOS.kImmediatelyBlockDistractingSites, true);
  assert.deepEqual(server.document.MacOS.kMacOnlyThing, { nested: [1, 2, 3] }, "keys this app doesn't know are kept");
  assert.equal(server.document.MacOS.kIsReducedMotion, true, 'the change itself is saved');
  assert.deepEqual(server.document.Windows, { kWindowsOnly: 'keep me' });
  assert.deepEqual(server.document.Android, { phone: true });
  // And the app now shows what the account has, not the defaults.
  assert.deepEqual(sync.getValue('urlList'), FIFTEEN);
  assert.equal(sync.getValue('selectedBearMode'), 'grizzly');
  assert.equal(sync.status(), SYNC.SYNCED);
});

test('nothing is written while the account cannot be read', async () => {
  const { sync, server, runTimers } = setup();
  server.online = false;
  await sync.initialize();
  await sync.setValue('reducedMotion', true);
  await runTimers();
  assert.equal(server.puts().length, 0);
  assert.equal(sync.status(), SYNC.OFFLINE);

  // A 5xx is not "no settings on the server" either.
  server.online = true;
  server.getStatus = 503;
  await sync.retry();
  assert.equal(server.puts().length, 0);
  assert.equal(sync.hasLoaded(), false);

  server.getStatus = 200;
  await sync.retry();
  assert.equal(server.puts().length, 1);
  assert.deepEqual(server.document.MacOS.kArrBlockedUrls, FIFTEEN);
  assert.equal(server.document.MacOS.kIsReducedMotion, true);
});

test('a save never throws out what cannot be saved: flush rejects and the change stays pending', async () => {
  const { sync, server } = setup();
  await sync.initialize();
  server.online = false;
  await sync.setValue('immediatelyBlock', false);
  await assert.rejects(() => sync.flush());
  assert.equal(sync.status(), SYNC.PENDING);
  assert.deepEqual(sync.unsavedKeys(), ['immediatelyBlock']);
  server.online = true;
  await sync.flush();
  assert.equal(server.document.MacOS.kImmediatelyBlockDistractingSites, false);
  assert.equal(sync.status(), SYNC.SYNCED);
});

test('a change made on another device since launch is kept: the document is read again before each save', async () => {
  const { sync, server, runTimers } = setup();
  await sync.initialize(); // Linux has been open since morning
  // Noon, on the Mac: a site is added, Cuddly is chosen, a Mac-only key changes.
  server.document.MacOS.kArrBlockedUrls.push('added-on-mac.example');
  server.document.MacOS.kCuddlyModeEnabled = true;
  server.document.MacOS.kMacOnlyThing = 'changed at noon';
  // 3 pm, on Linux: "Immediately block" is switched off.
  await sync.setValue('immediatelyBlock', false);
  await runTimers();

  const methods = server.calls.map((call) => call.method);
  assert.deepEqual(methods.slice(-2), ['GET', 'PUT'], 'GET right before the PUT');
  assert.deepEqual(server.document.MacOS.kArrBlockedUrls, [...FIFTEEN, 'added-on-mac.example']);
  assert.equal(server.document.MacOS.kCuddlyModeEnabled, true);
  assert.equal(server.document.MacOS.kMacOnlyThing, 'changed at noon');
  assert.equal(server.document.MacOS.kImmediatelyBlockDistractingSites, false);
  // The window follows what the other device did.
  assert.equal(sync.getValue('selectedBearMode'), 'cuddly');
  assert.ok(sync.getValue('urlList').includes('added-on-mac.example'));
});

test('editing the block list here keeps a site another device added meanwhile', async () => {
  const { sync, server, runTimers } = setup();
  await sync.initialize();
  server.document.MacOS.kArrBlockedUrls.push('added-on-windows.example');
  const mine = sync.getValue('urlList').filter((site) => site !== 'site3.example');
  await sync.setValue('urlList', [...mine, 'gossip']);
  await runTimers();
  const saved = server.document.MacOS.kArrBlockedUrls;
  assert.ok(saved.includes('added-on-windows.example'));
  assert.ok(saved.includes('gossip'));
  assert.ok(!saved.includes('site3.example'));
  assert.equal(saved.length, 16);
});

test('a block list edited before the account could be read is merged, not written over it', async () => {
  const { sync, server, runTimers } = setup();
  server.online = false;
  await sync.initialize(); // nothing saved on this computer: the page shows the two defaults
  await sync.setValue('urlList', ['facebook.com', 'x.com', 'gossip']);
  server.online = true;
  await runTimers();
  assert.deepEqual(server.document.MacOS.kArrBlockedUrls, [...FIFTEEN, 'gossip']);
});

test('an offline start uses the copy saved on this computer, never the defaults', async () => {
  const local = { setupComplete: true, settingsOwner: 'auth0|a', urlList: ['mine.example', 'celebrity'], immediatelyBlock: true };
  const { sync, server, applied } = setup({ local });
  server.online = false;
  await sync.initialize();
  assert.deepEqual(sync.getValue('urlList'), ['mine.example', 'celebrity']);
  assert.equal(sync.getValue('immediatelyBlock'), true);
  // What the extensions are sent:
  assert.deepEqual(applied, [['urlList', ['mine.example', 'celebrity']], ['immediatelyBlock', true]]);
});

test('an offline start with no saved copy sends the extensions nothing', async () => {
  const { sync, server, applied, disk } = setup({ local: { setupComplete: true } });
  server.online = false;
  await sync.initialize();
  assert.deepEqual(applied, []);
  assert.deepEqual(sync.getValue('urlList'), DEFAULTS.urlList); // shown, but not pushed or saved
  await sync.setValue('reducedMotion', true);
  assert.equal(disk.value.urlList, undefined, 'the defaults are not written down as the account\'s list');
});

test("another account's saved copy is not used", async () => {
  const local = { settingsOwner: 'auth0|someone-else', urlList: ['theirs.example'], immediatelyBlock: true };
  const { sync, server, applied } = setup({ local });
  server.online = false;
  await sync.initialize();
  assert.deepEqual(applied, []);
  assert.deepEqual(sync.getValue('urlList'), DEFAULTS.urlList);
});

test('a change made offline is saved locally at once and reaches the account after a restart', async () => {
  const first = setup();
  await first.sync.initialize();
  first.server.online = false;
  await first.sync.setValue('immediatelyBlock', false);
  assert.equal(first.disk.value.immediatelyBlock, false, 'on disk before the account has it');
  assert.deepEqual(Object.keys(first.disk.value.unsyncedSettings), ['immediatelyBlock']);

  // The app is quit and started again, online this time.
  first.server.online = true;
  const second = setup({ server: first.server, local: first.disk.value });
  await second.sync.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  await second.sync.flush();
  assert.equal(first.server.document.MacOS.kImmediatelyBlockDistractingSites, false);
  assert.deepEqual(first.server.document.MacOS.kArrBlockedUrls, FIFTEEN);
  assert.deepEqual(second.disk.value.unsyncedSettings, {});
});

test('an account with nothing saved (404 or no MacOS object) loads as empty and can be saved to', async () => {
  const server = fakeServer({ iOS: null, Windows: null, MacOS: null, Android: null, Web: { hasEditedSettings: false } });
  const { sync, runTimers } = setup({ server });
  await sync.initialize();
  assert.equal(sync.status(), SYNC.SYNCED);
  assert.deepEqual(sync.getDocument().MacOS, null);
  await sync.setValue('pomodoroMinutes', 50);
  await runTimers();
  assert.deepEqual(server.document.MacOS, { kPomodoroDurationMinutes: '50' }, 'only the changed key, no defaults');
  assert.deepEqual(server.document.Web, { hasEditedSettings: false });

  const missing = fakeServer();
  missing.getStatus = 404;
  const other = setup({ server: missing });
  await other.sync.initialize();
  assert.equal(other.sync.hasLoaded(), true);
  assert.deepEqual(other.sync.getDocument(), {});
});

test('saves are sent one at a time, and an edit made during a save goes out in the next one', async () => {
  const { sync, server, runTimers } = setup();
  await sync.initialize();
  let release;
  server.beforePut = () => new Promise((resolve) => { release = resolve; });
  await sync.setValue('pomodoroMinutes', 30);
  const first = sync.flush();
  await new Promise((resolve) => setImmediate(resolve));
  await sync.setValue('pomodoroMinutes', 45); // typed while the first save is on its way
  server.beforePut = null;
  release();
  await first;
  await runTimers();
  await sync.flush();
  assert.equal(server.document.MacOS.kPomodoroDurationMinutes, '45');
  assert.equal(sync.getValue('pomodoroMinutes'), 45);
  assert.equal(sync.status(), SYNC.SYNCED);
});

test('after sign-out nothing more is sent, and a late answer is not applied', async () => {
  const { sync, server, runTimers } = setup();
  await sync.initialize();
  await sync.setValue('reducedMotion', true);
  sync.reset();
  await runTimers();
  assert.equal(server.puts().length, 0);
  assert.equal(sync.hasLoaded(), false);
  assert.equal(sync.getDocument(), null);
  assert.deepEqual(sync.getValue('urlList'), DEFAULTS.urlList);
});

test('Sync now reports a failed read instead of saying "synced"', async () => {
  const { sync, server } = setup();
  await sync.initialize();
  server.online = false;
  await assert.rejects(() => sync.forceSync());
  server.online = true;
  server.document.MacOS.kIsReducedMotion = true;
  await sync.forceSync();
  assert.equal(sync.getValue('reducedMotion'), true);
});

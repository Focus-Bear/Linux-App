// Sign-out, at the level of the main-process state and the window's sign-out
// sequence (fakes for the clock, the timers, the file and the socket).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFocusSessionController } from './focusSessionController.js';
import { MODE_STALE_MS, createBlockingState } from './blockingState.js';
import { runSignOut, withoutAccountCopy } from './accountState.js';
import { reuseDecision, signInOf } from './webviewReuse.js';
import { performSignOut } from '../services/signOutCore.js';

const T0 = Date.UTC(2026, 10, 22, 9, 0, 0);
const MINUTE = 60000;

function clock(start = T0) {
  const c = { t: start, timers: [] };
  c.now = () => c.t;
  c.setTimer = (fn, ms) => {
    const timer = { fn, at: c.t + ms, cancelled: false };
    c.timers.push(timer);
    return timer;
  };
  c.clearTimer = (timer) => {
    if (timer) timer.cancelled = true;
  };
  /** Moves the clock, running the timers that come due. */
  c.advance = (ms) => {
    const until = c.t + ms;
    for (;;) {
      const due = c.timers.filter((timer) => !timer.cancelled && timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.cancelled = true;
      c.t = due.at;
      due.fn();
    }
    c.t = until;
  };
  return c;
}

function sessionSetup({ saved = null } = {}) {
  const c = clock();
  const disk = { value: saved };
  const changes = [];
  const controller = createFocusSessionController({
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    load: async () => disk.value,
    save: async (session) => {
      disk.value = session;
    },
    remove: async () => {
      disk.value = null;
    },
    onChange: (session) => changes.push(session),
  });
  return { c, disk, changes, controller };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const START = { modeId: 'mode-1', modeName: 'Study', intention: 'Write the report', minutes: 25, synced: true, strictness: 'pawfessor' };

// --- focus session ------------------------------------------------------------

test('signing out clears the running session, its timer and its file', async () => {
  const { c, disk, changes, controller } = sessionSetup();
  controller.signedIn('auth0|a');
  controller.start(START);
  await flush();
  assert.equal(disk.value.userId, 'auth0|a', 'the session is saved with its owner');

  const dropped = controller.signedOut();
  await flush();
  assert.equal(dropped.intention, 'Write the report');
  assert.equal(controller.get(), null);
  assert.equal(controller.isActive(), false);
  assert.equal(disk.value, null);
  assert.equal(changes.at(-1), null, 'the windows are told there is no session');

  // Its end-of-session timer does nothing later.
  c.advance(30 * MINUTE);
  assert.equal(controller.get(), null);
});

test("the next account is not shown the previous account's session or end screen", async () => {
  // Account A's session ended while nobody was signed in (the app was killed, then restarted).
  const ended = { status: 'ended', startTime: T0 - 30 * MINUTE, finishTime: T0 - 5 * MINUTE, endedAt: T0 - 5 * MINUTE, pausedTotalMs: 0, intention: 'A secret goal', modeId: 'm', userId: 'auth0|a' };
  const { controller, disk } = sessionSetup({ saved: ended });
  await controller.restore();
  assert.equal(controller.get().intention, 'A secret goal');

  controller.signedIn('auth0|b');
  await flush();
  assert.equal(controller.get(), null);
  assert.equal(disk.value, null);
});

test('the same account gets its session back after a restart; a file from before owners is adopted', async () => {
  const running = { status: 'running', startTime: T0 - 5 * MINUTE, finishTime: T0 + 20 * MINUTE, pausedTotalMs: 0, pausedAt: null, intention: 'Mine', modeId: 'm', userId: 'auth0|a' };
  const mine = sessionSetup({ saved: running });
  await mine.controller.restore();
  mine.controller.signedIn('auth0|a');
  assert.equal(mine.controller.get().intention, 'Mine');
  assert.equal(mine.controller.isActive(), true);

  const legacy = sessionSetup({ saved: { ...running, userId: undefined } });
  await legacy.controller.restore();
  legacy.controller.signedIn('auth0|a');
  assert.equal(legacy.controller.get().userId, 'auth0|a');
});

test('a file read after sign-out is not brought back', async () => {
  const running = { status: 'running', startTime: T0, finishTime: T0 + 20 * MINUTE, pausedTotalMs: 0, pausedAt: null, userId: 'auth0|a' };
  const { controller } = sessionSetup({ saved: running });
  controller.signedOut();
  assert.equal(await controller.restore(), null);
  assert.equal(controller.get(), null);
});

test('a session still runs out by itself and tells the window', async () => {
  const c = clock();
  let timeUp = 0;
  const controller = createFocusSessionController({ now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, onTimeUp: () => { timeUp += 1; } });
  controller.signedIn('auth0|a');
  controller.start({ ...START, minutes: 5, strictness: 'junior' });
  c.advance(5 * MINUTE + 100);
  assert.equal(controller.get().status, 'ended');
  assert.equal(timeUp, 1);
});

// --- what the extensions are told ---------------------------------------------

function blockingSetup() {
  const c = clock();
  const sent = [];
  const blocking = createBlockingState({ send: (line) => sent.push(JSON.parse(line)), now: c.now });
  const last = (type) => sent.filter((message) => message.type === type).at(-1);
  return { c, sent, blocking, last };
}

test('signing out lifts the allow list and the block list at once', () => {
  const { blocking, sent, last, c } = blockingSetup();
  blocking.setAlways(['facebook.com', 'gossip']);
  blocking.setSettings({ immediatelyBlock: true });
  blocking.setMode({ blocklist: ['reddit.com'], allowOnly: ['wikipedia.org', 'docs.google.com'] });
  assert.deepEqual(last('BLOCK_SETTINGS_UPDATE').data.allowOnly, ['wikipedia.org', 'docs.google.com']);
  assert.deepEqual(last('BLOCKLIST_UPDATE').data, ['facebook.com', 'gossip', 'reddit.com']);

  blocking.signedOut();
  assert.deepEqual(last('BLOCKLIST_UPDATE').data, []);
  assert.deepEqual(last('BLOCK_SETTINGS_UPDATE').data, { immediatelyBlock: false });

  // And it is not renewed afterwards: the reviewer saw it re-sent every minute, into the next account.
  const before = sent.length;
  for (let i = 0; i < 10; i += 1) {
    c.advance(MINUTE);
    blocking.renew();
  }
  assert.equal(sent.length, before);
  // A host that connects now is told nothing is blocked.
  assert.deepEqual(blocking.greeting().map((line) => JSON.parse(line).data), [{ immediatelyBlock: false }]);
});

test('an allow list is renewed only while the window keeps confirming it', () => {
  const { blocking, sent, last, c } = blockingSetup();
  const mode = { blocklist: [], allowOnly: ['wikipedia.org'] };
  blocking.setMode(mode);
  // The window confirms every minute: renewed, with a fresh expiry.
  for (let i = 0; i < 5; i += 1) {
    c.advance(MINUTE);
    assert.equal(blocking.setMode(mode), false);
    blocking.renew();
    assert.deepEqual(last('BLOCK_SETTINGS_UPDATE').data.allowOnly, ['wikipedia.org']);
    assert.equal(last('BLOCK_SETTINGS_UPDATE').data.allowOnlyUntil, c.t + 3 * MINUTE);
  }
  // The window crashes, hangs or is on the sign-in screen: no more confirmations.
  c.advance(MODE_STALE_MS + MINUTE);
  blocking.renew();
  assert.equal(last('BLOCK_SETTINGS_UPDATE').data.allowOnly, undefined, 'lifted, not renewed');
  const count = sent.length;
  c.advance(MINUTE);
  blocking.renew();
  assert.equal(sent.length, count);
  // When the window comes back it says the list again and it applies again.
  assert.equal(blocking.setMode(mode), true);
  assert.deepEqual(last('BLOCK_SETTINGS_UPDATE').data.allowOnly, ['wikipedia.org']);
});

test('quitting lifts the list in force but keeps the always-blocked sites', () => {
  const { blocking, last } = blockingSetup();
  blocking.setAlways(['facebook.com']);
  blocking.setMode({ blocklist: ['reddit.com'], allowOnly: ['wikipedia.org'] });
  assert.equal(blocking.clearMode(), true);
  assert.deepEqual(last('BLOCKLIST_UPDATE').data, ['facebook.com']);
  assert.equal(last('BLOCK_SETTINGS_UPDATE').data.allowOnly, undefined);
  assert.equal(blocking.clearMode(), false);
});

// --- settings.json and the sign-out sequence ----------------------------------

test("sign-out removes the saved copy of the account's settings and keeps this computer's", () => {
  const file = {
    setupComplete: true,
    selectedBrowsers: ['firefox'],
    urlList: ['facebook.com'],
    immediatelyBlock: true,
    breaksEnabled: true,
    settingsOwner: 'auth0|a',
    unsyncedSettings: { reducedMotion: false },
    devices: { 'auth0|a': 'device-a', 'auth0|b': 'device-b' },
    deviceOs: { 'auth0|a': 'Web' },
    onboardingDone: { 'auth0|a': true, 'auth0|b': true },
  };
  const signedOut = withoutAccountCopy(file);
  assert.deepEqual(Object.keys(signedOut).sort(), ['deviceOs', 'devices', 'onboardingDone', 'selectedBrowsers', 'setupComplete']);
  assert.deepEqual(signedOut.devices, file.devices, 'a normal sign-out keeps the device registration');

  // Delete account: that account's device id and "onboarding done" go too.
  const deleted = withoutAccountCopy(file, { forgetUserId: 'auth0|a' });
  assert.deepEqual(deleted.devices, { 'auth0|b': 'device-b' });
  assert.deepEqual(deleted.deviceOs, {});
  assert.deepEqual(deleted.onboardingDone, { 'auth0|b': true });
  assert.deepEqual(withoutAccountCopy(null), {});
});

test('every sign-out step runs even when one fails', async () => {
  const ran = [];
  const failed = await runSignOut([
    ['focus session', () => ran.push('session')],
    ['dashboard pages', () => { throw new Error('view already destroyed'); }],
    ['blocking', async () => ran.push('blocking')],
    ['breaks', () => ran.push('breaks')],
  ]);
  assert.deepEqual(ran, ['session', 'blocking', 'breaks']);
  assert.deepEqual(failed, ['dashboard pages']);
});

test('the window signs out in order: report the session, forget the account, tell main, then clear the tokens', async () => {
  const steps = [];
  const running = { status: 'running', synced: true, modeId: 'mode-1', startTime: T0, finishTime: T0 + 25 * MINUTE, pausedTotalMs: 0, pausedAt: null };
  await performSignOut({
    getSession: async () => running,
    reportFinish: async (session) => steps.push(`finish:${session.status}:${session.endedAt}`),
    resetStores: () => steps.push('reset'),
    tellMain: async (options) => steps.push(`main:${JSON.stringify(options)}`),
    clearTokens: async () => steps.push('tokens'),
    now: () => T0 + 10 * MINUTE,
  });
  assert.deepEqual(steps, [`finish:ended:${T0 + 10 * MINUTE}`, 'reset', 'main:{}', 'tokens']);
});

test('the main process is told and the tokens are cleared even when reporting fails or hangs', async () => {
  const steps = [];
  const running = { status: 'running', synced: true, modeId: 'mode-1', startTime: T0, finishTime: T0 + 25 * MINUTE, pausedTotalMs: 0, pausedAt: null };
  const base = {
    getSession: async () => running,
    resetStores: () => { throw new Error('store broke'); },
    tellMain: async (options) => steps.push(`main:${JSON.stringify(options)}`),
    clearTokens: async () => steps.push('tokens'),
    log: { error() {} },
  };
  await performSignOut({ ...base, reportFinish: async () => { throw new Error('offline'); } });
  await performSignOut({ ...base, reportFinish: () => new Promise(() => {}), reportTimeoutMs: 20, forgetUserId: 'auth0|a' });
  assert.deepEqual(steps, ['main:{}', 'tokens', 'main:{"forgetUserId":"auth0|a"}', 'tokens']);
});

test('no session, or one the server never knew about, is not reported', async () => {
  let reported = 0;
  const run = (session) => performSignOut({ getSession: async () => session, reportFinish: async () => { reported += 1; } });
  await run(null);
  await run({ status: 'ended', synced: true, modeId: 'm' });
  await run({ status: 'running', synced: false, modeId: 'm', startTime: T0, finishTime: T0 + MINUTE, pausedTotalMs: 0 });
  assert.equal(reported, 0);
});

// --- embedded dashboard pages --------------------------------------------------

test("a dashboard page loaded for another account, or with a replaced token, is loaded again", () => {
  const a = { user: { sub: 'auth0|a' }, access_token: 'token-a1' };
  const loaded = signInOf(a);
  assert.equal(reuseDecision(loaded, a), 'reuse');
  assert.equal(reuseDecision(loaded, { ...a, theme: 'DARK' }), 'reuse');
  assert.equal(reuseDecision(loaded, { user: { sub: 'auth0|b' }, access_token: 'token-b' }), 'reload');
  assert.equal(reuseDecision(loaded, { ...a, access_token: 'token-a2' }), 'reload', 'a refreshed token reaches the page');
  assert.equal(reuseDecision(loaded, null), 'reuse');
  assert.equal(reuseDecision(undefined, a), 'reuse');
});

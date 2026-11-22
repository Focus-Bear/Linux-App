// The two background scripts as they ship, run with fake chrome.* / browser.*
// objects (see harness.js): what the app sends in, what gets blocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDnr, settle, startChromeBackground, startFirefoxBackground } from './harness.js';

const MIN = 60 * 1000;
const BLOCK_ALL = '^https?://.*';
const blockAll = (dnr) => [...dnr.rules.dynamic, ...dnr.rules.session]
  .filter((rule) => rule.condition.regexFilter === BLOCK_ALL);
const settings = (data) => ({ type: 'BLOCK_SETTINGS_UPDATE', data });
const allowList = (sites) => settings({ immediatelyBlock: false, allowOnly: sites, allowOnlyUntil: Date.now() + 3 * MIN });

// ── Chrome ───────────────────────────────────────────────────────────────────

test('Chrome: a rule Chrome refuses does not leave "block every page" behind when the allow list ends', async () => {
  const bg = await startChromeBackground();
  bg.port.deliver(allowList(['wikipedia.org']));
  await settle();
  assert.equal(blockAll(bg.dnr).length, 1, 'the allow list is in force');
  assert.equal(bg.dnr.rules.dynamic.filter((rule) => rule.condition.regexFilter === BLOCK_ALL).length, 0,
    'and not in the rules that survive a browser restart');

  // A site Chrome cannot take as written, then the session ends.
  bg.port.deliver({ type: 'BLOCKLIST_UPDATE', data: ['café.fr', 'facebook.com'] });
  bg.port.deliver(settings({ immediatelyBlock: false, allowOnly: null }));
  await settle();

  assert.equal(blockAll(bg.dnr).length, 0, 'every page would still go to the block page');
  assert.equal(bg.dnr.rules.dynamic.length, 2, 'and the block list still applies, café.fr included');
});

test('Chrome: the block list and the settings sent back to back both apply', async () => {
  const bg = await startChromeBackground({ stored: { blocklist: ['x.com'] } });
  bg.port.deliver({ type: 'BLOCKLIST_UPDATE', data: ['facebook.com', 'x.com'] });
  bg.port.deliver(allowList(['wikipedia.org']));
  await settle();

  assert.equal(blockAll(bg.dnr).length, 1, 'the allow list applies now, not at the next renewal');
  assert.equal(bg.dnr.rules.dynamic.length, 2);
});

test('Chrome: allow-list rules left by an older version are removed at start', async () => {
  const dnr = createFakeDnr();
  dnr.rules.dynamic = [
    { id: 1, priority: 2, action: { type: 'allow' }, condition: { regexFilter: '.*wikipedia\\.org.*' } },
    { id: 2, priority: 1, action: { type: 'redirect' }, condition: { regexFilter: BLOCK_ALL } },
  ];
  // The stored allow list lapsed long ago (the app was closed).
  await startChromeBackground({ dnr, stored: { allowOnly: ['wikipedia.org'], allowOnlyUntil: Date.now() - MIN } });
  assert.equal(dnr.rules.dynamic.length, 0);
  assert.equal(dnr.rules.session.length, 0);
});

test('Chrome: an expiry far in the future is cut to 3 minutes, then the allow list lapses', async () => {
  const clock = { aheadMs: 0 };
  const bg = await startChromeBackground({ clock });
  bg.port.deliver(settings({ immediatelyBlock: false, allowOnly: ['wikipedia.org'], allowOnlyUntil: Date.now() + 24 * 60 * MIN }));
  await settle();
  assert.ok(bg.storage.stored.allowOnlyUntil <= Date.now() + 3 * MIN);
  assert.equal(blockAll(bg.dnr).length, 1);

  // The app stops renewing. Four minutes later the one-minute alarm lifts the list.
  clock.aheadMs = 4 * MIN;
  await bg.alarm('ping');
  assert.equal(blockAll(bg.dnr).length, 0);
  assert.equal(bg.storage.stored.allowOnly, null);
});

test('Chrome: a stored expiry from when the clock was ahead is capped when read back', async () => {
  const clock = { aheadMs: 0 };
  const bg = await startChromeBackground({ clock, stored: { allowOnly: ['wikipedia.org'], allowOnlyUntil: Date.now() + 24 * 60 * MIN } });
  assert.equal(blockAll(bg.dnr).length, 1, 'restored: still in force for now');
  clock.aheadMs = 4 * MIN;
  await bg.alarm('ping');
  assert.equal(blockAll(bg.dnr).length, 0);
});

test('Chrome: every tab is re-checked, and a page that only mentions an allowed site is blocked', async () => {
  const tabs = [
    { id: 1, windowId: 1, active: true, url: 'https://en.wikipedia.org/wiki/Bear' },
    { id: 2, windowId: 1, active: false, url: 'https://youtube.com/?wikipedia.org' },
    { id: 3, windowId: 2, active: true, url: 'https://www.Facebook.com/' },
  ];
  const bg = await startChromeBackground({ tabs });
  bg.port.deliver({ type: 'BLOCKLIST_UPDATE', data: ['Facebook.com'] });
  bg.port.deliver(allowList(['wikipedia.org']));
  await settle();

  const blocked = new Map(bg.tabs.updates.map((update) => [update.id, update.url]));
  assert.equal(blocked.has(1), false);
  assert.match(blocked.get(2), /blocked\.html\?reason=allow_list#https:\/\/youtube\.com/);
  assert.match(blocked.get(3), /blocked\.html#https:\/\/www\.Facebook\.com/);
});

test('Chrome: a temporary unblock is at most 90 minutes, and refused while "Immediately block" is on', async () => {
  const bg = await startChromeBackground();
  const answer = await bg.message({ type: 'ADD_WHITELIST', pattern: 'facebook.com', patternType: 'domain', durationMs: 1000 * 24 * 60 * MIN });
  assert.equal(answer.success, true);
  await settle();
  assert.equal(bg.storage.stored.whitelist.length, 1);
  assert.ok(bg.storage.stored.whitelist[0].expiresAt <= Date.now() + 90 * MIN);

  // What the app pushes (whitelist.json) is cut the same way.
  bg.port.deliver({ type: 'WHITELIST_UPDATE', data: [{ pattern: 'x.com', type: 'domain', expiresAt: 9999999999999 }] });
  await settle();
  assert.ok(bg.storage.stored.whitelist[0].expiresAt <= Date.now() + 90 * MIN);

  bg.port.deliver(settings({ immediatelyBlock: true }));
  await settle();
  const refused = await bg.message({ type: 'ADD_WHITELIST', pattern: 'y.com', patternType: 'domain' });
  assert.equal(refused.success, false);
});

// ── Firefox ──────────────────────────────────────────────────────────────────

test('Firefox: an allow-list entry in the query does not open another site', async () => {
  const bg = await startFirefoxBackground();
  bg.port.deliver(allowList(['wikipedia.org', 'github.com/focus-bear']));
  await settle();

  assert.equal(bg.request({ url: 'https://en.wikipedia.org/wiki/Bear' }).redirectUrl, undefined);
  assert.equal(bg.request({ url: 'https://github.com/Focus-Bear/app' }).redirectUrl, undefined);
  assert.equal(bg.request({ url: 'https://dashboard.focusbear.io/' }).redirectUrl, undefined);
  assert.match(bg.request({ url: 'https://youtube.com/?wikipedia.org' }).redirectUrl, /reason=allow_list/);
  assert.match(bg.request({ url: 'https://youtube.com/#docs.google.com' }).redirectUrl, /reason=allow_list/);
  assert.match(bg.request({ url: 'https://github.com/other' }).redirectUrl, /reason=allow_list/);
  // Only the page itself is checked, not what an allowed page loads.
  assert.equal(bg.request({ url: 'https://cdn.example.com/a.js', type: 'script' }).redirectUrl, undefined);
});

test('Firefox: an expiry far in the future is cut to 3 minutes', async () => {
  const bg = await startFirefoxBackground();
  bg.port.deliver(settings({ immediatelyBlock: false, allowOnly: ['wikipedia.org'], allowOnlyUntil: Date.now() + 24 * 60 * MIN }));
  await settle();
  assert.ok(bg.storage.stored.allowOnlyUntil <= Date.now() + 3 * MIN);
  assert.match(bg.request({ url: 'https://youtube.com/' }).redirectUrl, /reason=allow_list/);
});

test('Firefox: sites block in any case; "com", "www", "http", "https" block nothing', async () => {
  const bg = await startFirefoxBackground();
  bg.port.deliver({ type: 'BLOCKLIST_UPDATE', data: ['Facebook.com', 'https://Reddit.com', 'com', 'www', 'http', 'https'] });
  await settle();

  assert.match(bg.request({ url: 'https://www.facebook.com/' }).redirectUrl, /reason=domain/);
  assert.match(bg.request({ url: 'https://old.reddit.com/r/all' }).redirectUrl, /reason=domain/);
  assert.equal(bg.request({ url: 'https://www.example.com/' }).redirectUrl, undefined);
  assert.equal(bg.request({ url: 'http://example.org/' }).redirectUrl, undefined);
});

test('Firefox: switching "Immediately block" on re-checks every tab, not only the one in front', async () => {
  const tabs = [
    { id: 1, windowId: 1, active: true, url: 'https://example.org/' },
    { id: 2, windowId: 1, active: false, url: 'https://www.facebook.com/feed' },
    { id: 3, windowId: 2, active: true, url: 'https://facebook.com/' },
  ];
  const bg = await startFirefoxBackground({
    tabs,
    stored: {
      blocklist: ['facebook.com'],
      whitelist: [{ pattern: 'facebook.com', type: 'domain', expiresAt: Date.now() + 30 * MIN }],
    },
  });
  assert.equal(bg.request({ url: 'https://facebook.com/' }).redirectUrl, undefined, 'temporarily unblocked');

  bg.port.deliver(settings({ immediatelyBlock: true }));
  await settle();

  assert.deepEqual(bg.tabs.updates.map((update) => update.id).sort(), [2, 3]);
  assert.match(bg.request({ url: 'https://facebook.com/' }).redirectUrl, /blocked\.html/);
});

test('Firefox: a temporary unblock is at most 90 minutes', async () => {
  const bg = await startFirefoxBackground();
  await bg.message({ type: 'ADD_WHITELIST', pattern: 'facebook.com', patternType: 'domain', durationMs: 1000 * 24 * 60 * MIN });
  assert.ok(bg.storage.stored.whitelist[0].expiresAt <= Date.now() + 90 * MIN);
  bg.port.deliver({ type: 'WHITELIST_UPDATE', data: [{ pattern: 'x.com', type: 'domain', expiresAt: 9999999999999 }] });
  await settle();
  assert.ok(bg.storage.stored.whitelist[0].expiresAt <= Date.now() + 90 * MIN);
});

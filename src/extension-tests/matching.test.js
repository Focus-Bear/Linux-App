import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CHROME_DIR, FIREFOX_DIR, loadMatching, plain } from './harness.js';

const M = loadMatching();
const MIN = 60 * 1000;

test('both extensions carry the same matching.js', () => {
  assert.equal(
    readFileSync(join(FIREFOX_DIR, 'matching.js'), 'utf8'),
    readFileSync(join(CHROME_DIR, 'matching.js'), 'utf8'),
  );
});

test('the extensions load the files they need, and every file gets packaged', () => {
  const firefox = JSON.parse(readFileSync(join(FIREFOX_DIR, 'manifest.json'), 'utf8'));
  assert.deepEqual(firefox.background.scripts, ['matching.js', 'background.js']);

  const chrome = JSON.parse(readFileSync(join(CHROME_DIR, 'manifest.json'), 'utf8'));
  assert.equal(chrome.background.service_worker, 'background.js');
  assert.equal(chrome.background.type, undefined, 'importScripts() needs a classic service worker');
  const worker = readFileSync(join(CHROME_DIR, 'background.js'), 'utf8');
  assert.match(worker, /importScripts\('matching\.js', 'dnr\.js'\)/);

  // The app copies the extension folders file by file (installNativeMessaging
  // in main.js): a file in a sub-folder would be left behind.
  for (const dir of [CHROME_DIR, FIREFOX_DIR]) {
    for (const name of readdirSync(dir)) {
      assert.equal(statSync(join(dir, name)).isFile(), true, `${name} must be a file at the top of ${dir}`);
    }
  }
  for (const name of ['matching.js', 'dnr.js']) assert.ok(readdirSync(CHROME_DIR).includes(name));
  assert.ok(readdirSync(FIREFOX_DIR).includes('matching.js'));
});

test('an allow-list entry matches the host, never the query or the fragment', () => {
  assert.equal(M.matchesEntry('https://wikipedia.org/wiki/Bear', 'wikipedia.org'), true);
  assert.equal(M.matchesEntry('https://en.wikipedia.org/', 'wikipedia.org'), true);
  assert.equal(M.matchesEntry('https://www.wikipedia.org/', 'https://www.Wikipedia.org/'), true);

  assert.equal(M.matchesEntry('https://youtube.com/?wikipedia.org', 'wikipedia.org'), false);
  assert.equal(M.matchesEntry('https://youtube.com/watch?v=1&x=wikipedia.org', 'wikipedia.org'), false);
  assert.equal(M.matchesEntry('https://youtube.com/#docs.google.com', 'docs.google.com'), false);
  // A site name in someone else's path is not that site either.
  assert.equal(M.matchesEntry('https://youtube.com/watch/wikipedia.org', 'wikipedia.org'), false);
  // Nor in the "user@" part of an address.
  assert.equal(M.matchesEntry('https://wikipedia.org@youtube.com/', 'wikipedia.org'), false);
});

test('an allow-list entry with a path matches host + path', () => {
  assert.equal(M.matchesEntry('https://github.com/Focus-Bear/app', 'github.com/focus-bear'), true);
  assert.equal(M.matchesEntry('https://github.com/other', 'github.com/focus-bear'), false);
  assert.equal(M.matchesEntry('https://evil.com/?github.com/focus-bear', 'github.com/focus-bear'), false);
  // What comes after "?" in an entry is not matched; the page itself still is.
  assert.equal(M.matchesEntry('https://site.com/page?id=2', 'site.com/page?id=1'), true);
});

test('"*" in an allow-list entry is a wildcard', () => {
  assert.equal(M.matchesEntry('https://docs.google.com/document/d/1', '*.google.com'), true);
  assert.equal(M.matchesEntry('https://docs.google.com/document/d/1', 'docs.google.com/*/d'), true);
  assert.equal(M.matchesEntry('https://youtube.com/?a.google.com', '*.google.com'), false);
});

test('an international domain is matched as the browser writes it', () => {
  assert.equal(M.allowPattern('Café.fr'), 'xn--caf-dma.fr');
  assert.equal(M.matchesEntry('https://xn--caf-dma.fr/menu', 'café.fr'), true);
  assert.equal(M.matchesEntry('https://café.fr/menu', 'café.fr'), true);
  assert.equal(M.matchesEntry('https://cafe.fr/', 'café.fr'), false);
  assert.equal(M.allowPattern('exa mple é.fr'), '', 'an entry that is not an address matches nothing');
});

test('outside the allow list: everything but its sites and Focus Bear sign-in', () => {
  const allowOnly = ['wikipedia.org'];
  assert.equal(M.isOutsideAllowList('https://en.wikipedia.org/wiki/Bear', allowOnly), false);
  assert.equal(M.isOutsideAllowList('https://youtube.com/?wikipedia.org', allowOnly), true);
  assert.equal(M.isOutsideAllowList('https://dashboard.focusbear.io/', allowOnly), false);
  assert.equal(M.isOutsideAllowList('http://localhost:5173/', allowOnly), false);
  assert.equal(M.isOutsideAllowList('https://accounts.google.com/o/oauth2/auth', allowOnly), false);
  assert.equal(M.isOutsideAllowList('https://appleid.apple.com/auth/authorize', allowOnly), false);
  assert.equal(M.isOutsideAllowList('https://evil.com/focusbear.io', allowOnly), true);
  assert.equal(M.isOutsideAllowList('about:blank', allowOnly), false);
  assert.equal(M.isOutsideAllowList('https://youtube.com/', null), false, 'no allow list in force');
  assert.equal(M.isOutsideAllowList('https://youtube.com/', []), true, 'an empty allow list blocks every site');
});

test('an allow list never lasts more than 3 minutes without renewal', () => {
  const now = 1_000_000;
  assert.equal(M.capAllowOnlyUntil(now + 60 * MIN, now), now + 3 * MIN);
  assert.equal(M.capAllowOnlyUntil(now + MIN, now), now + MIN);
  assert.equal(M.capAllowOnlyUntil('soon', now), 0);
  assert.equal(M.capAllowOnlyUntil(undefined, now), 0);

  assert.deepEqual(plain(M.readAllowOnly(['a.com', '', 7], now + 24 * 60 * MIN, now)),
    { allowOnly: ['a.com'], allowOnlyUntil: now + 3 * MIN });
  assert.deepEqual(plain(M.readAllowOnly(['a.com'], now - 1, now)), { allowOnly: null, allowOnlyUntil: now - 1 });
  assert.deepEqual(plain(M.readAllowOnly(null, now + MIN, now)), { allowOnly: null, allowOnlyUntil: now + MIN });
});

test('blocked sites match in any case, with or without a scheme', () => {
  const list = M.compileBlocklist(['Facebook.com', 'https://Reddit.com', 'celebrity']);
  assert.equal(M.findBlocked('https://www.facebook.com/home', list).pattern, 'Facebook.com');
  assert.equal(M.findBlocked('https://old.reddit.com/r/all', list).pattern, 'https://Reddit.com');
  assert.equal(M.findBlocked('https://news.example/Celebrity-gossip', list).pattern, 'celebrity');
  assert.equal(M.findBlocked('https://example.org/', list), null);
});

test('"com", "www", "http" and "https" block nothing', () => {
  const list = M.compileBlocklist(['com', 'WWW', 'http', ' https ', '', null]);
  assert.equal(list.length, 0);
  assert.equal(M.findBlocked('https://www.example.com/', list), null);
});

test('a non-ASCII blocked site or keyword matches the address the browser shows', () => {
  const list = M.compileBlocklist(['café.fr', 'señor']);
  assert.equal(M.findBlocked('https://xn--caf-dma.fr/', list).pattern, 'café.fr');
  assert.equal(M.findBlocked('https://example.com/se%C3%B1or', list).pattern, 'señor');
});

test('regex block-list entries still work, and a broken one does not throw', () => {
  const list = M.compileBlocklist(['.*\\.tiktok\\..*', 'bad\\(']);
  assert.equal(M.findBlocked('https://www.tiktok.com/', list).kind, 'regex');
  assert.equal(M.findBlocked('https://example.org/', list), null);
});

test('temporary unblocks are well-formed, not expired and at most 90 minutes long', () => {
  const now = 5_000_000;
  const kept = plain(M.readWhitelist([
    { pattern: 'facebook.com', type: 'domain', expiresAt: 9999999999999 },
    { pattern: 'x.com', type: 'domain', expiresAt: now + MIN },
    { pattern: 'old.com', type: 'domain', expiresAt: now - 1 },
    { pattern: 'odd.com', type: 'forever', expiresAt: now + MIN },
    { pattern: 7, type: 'domain', expiresAt: now + MIN },
    null,
  ], now));
  assert.deepEqual(kept, [
    { pattern: 'facebook.com', type: 'domain', expiresAt: now + 90 * MIN },
    { pattern: 'x.com', type: 'domain', expiresAt: now + MIN },
  ]);
  assert.deepEqual(plain(M.readWhitelist('nope', now)), []);

  assert.equal(M.unblockDuration(undefined), 30 * MIN);
  assert.equal(M.unblockDuration(5 * MIN), 5 * MIN);
  assert.equal(M.unblockDuration(100 * 24 * 60 * MIN), 90 * MIN);
});

test('a temporary unblock covers its domain or its exact address', () => {
  const now = 1000;
  const list = [
    { pattern: 'facebook.com', type: 'domain', expiresAt: now + 1 },
    { pattern: 'https://x.com/home', type: 'exact', expiresAt: now + 1 },
    { pattern: 'gone.com', type: 'domain', expiresAt: now - 1 },
  ];
  assert.equal(M.isWhitelisted('https://m.facebook.com/a', list, now), true);
  assert.equal(M.isWhitelisted('http://x.com/home', list, now), true);
  assert.equal(M.isWhitelisted('https://x.com/other', list, now), false);
  assert.equal(M.isWhitelisted('https://gone.com/', list, now), false);
  assert.equal(M.isWhitelisted('https://notfacebook.com/', list, now), false);
});

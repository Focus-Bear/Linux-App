import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection, createServer } from 'net';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  AUTH_GRACE_MS,
  MAX_UNBLOCK_MS,
  REFUSAL,
  createLineReader,
  createSocketAuth,
  findSocket,
  prepareSocket,
  restrictSocket,
  socketDirs,
  stopNativeHosts,
  tokenMatches,
  validateWhitelistUpdate,
  watchLegacySocket,
} from './socketAuth.js';

const MIN = 60 * 1000;
const mode = (path) => statSync(path).mode & 0o777;
const tempHome = () => mkdtempSync(join(tmpdir(), 'fb-sock-'));

// A socket that records what is done to it.
function fakeSocket() {
  return {
    written: [],
    ended: false,
    destroyed: false,
    end(line) { if (line) this.written.push(line); this.ended = true; },
    write(line) { this.written.push(line); },
    destroy() { this.destroyed = true; },
  };
}

// Timers that run when the test says so.
function fakeTimers() {
  const pending = [];
  return {
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; pending.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.cleared = true; },
    run(ms) {
      for (const timer of pending.splice(0)) {
        if (timer.cleared) continue;
        if (ms === undefined || timer.ms <= ms) timer.fn();
        else pending.push(timer);
      }
    },
    active: () => pending.filter((timer) => !timer.cleared),
  };
}

// ── Where the socket lives ───────────────────────────────────────────────────

test('the socket is in the runtime directory, or under the home directory without one', () => {
  assert.deepEqual(socketDirs({ env: { XDG_RUNTIME_DIR: '/run/user/1000' }, home: '/home/a' }),
    ['/run/user/1000/focusbear', '/home/a/.local/share/focusbear/run']);
  assert.deepEqual(socketDirs({ env: {}, home: '/home/a' }), ['/home/a/.local/share/focusbear/run']);
  for (const dir of socketDirs({ env: { XDG_RUNTIME_DIR: '/run/user/1000' }, home: '/home/a' })) {
    assert.equal(dir.startsWith('/tmp'), false);
  }
});

test('prepareSocket makes a private directory and a fresh private token', async () => {
  const home = tempHome();
  try {
    const env = { XDG_RUNTIME_DIR: join(home, 'runtime') };
    mkdirSync(env.XDG_RUNTIME_DIR);
    const first = await prepareSocket({ env, home });

    assert.equal(first.dir, join(env.XDG_RUNTIME_DIR, 'focusbear'));
    assert.equal(first.socketPath, join(first.dir, 'focusbear.sock'));
    assert.equal(mode(first.dir), 0o700);
    assert.equal(mode(first.tokenPath), 0o600);
    assert.match(first.token, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(first.tokenPath, 'utf8').trim(), first.token);

    // A socket left by a crash is removed; the next start has another token.
    writeFileSync(first.socketPath, '');
    const second = await prepareSocket({ env, home });
    assert.equal(existsSync(second.socketPath), false);
    assert.notEqual(second.token, first.token);
    assert.equal(readFileSync(second.tokenPath, 'utf8').trim(), second.token);

    // Without a runtime directory: under the home directory, just as private.
    const fallback = await prepareSocket({ env: {}, home });
    assert.equal(fallback.dir, join(home, '.local', 'share', 'focusbear', 'run'));
    assert.equal(mode(fallback.dir), 0o700);
    assert.equal(mode(fallback.tokenPath), 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('prepareSocket tightens a directory that was open, and skips one that is not ours', async () => {
  const home = tempHome();
  try {
    const env = { XDG_RUNTIME_DIR: join(home, 'runtime') };
    mkdirSync(join(env.XDG_RUNTIME_DIR, 'focusbear'), { recursive: true, mode: 0o777 });
    const prepared = await prepareSocket({ env, home });
    assert.equal(mode(prepared.dir), 0o700);

    // Every candidate belongs to someone else (uid differs).
    const other = await prepareSocket({ env, home, uid: statSync(home).uid + 1 }).catch((error) => error);
    assert.ok(other instanceof Error, 'no directory of ours at all is an error, not a silent fallback to /tmp');

    // A file where the directory should be: fall back to the home directory.
    const blocked = { XDG_RUNTIME_DIR: join(home, 'file') };
    writeFileSync(blocked.XDG_RUNTIME_DIR, '');
    const viaHome = await prepareSocket({ env: blocked, home });
    assert.equal(viaHome.dir, join(home, '.local', 'share', 'focusbear', 'run'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the socket itself is only for this user, and a helper of the same user finds it', async () => {
  const home = tempHome();
  const env = {};
  try {
    assert.equal(await findSocket({ env, home }), null, 'the app is not running');
    const prepared = await prepareSocket({ env, home });
    assert.equal(await findSocket({ env, home }), null, 'a token without a socket is not a running app');

    const server = createServer(() => {});
    await new Promise((resolve) => server.listen(prepared.socketPath, resolve));
    try {
      await restrictSocket(prepared.socketPath);
      assert.equal(mode(prepared.socketPath), 0o600);
      const found = await findSocket({ env, home });
      assert.deepEqual(found, { dir: prepared.dir, socketPath: prepared.socketPath, tokenPath: prepared.tokenPath, token: prepared.token });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── Who may talk ─────────────────────────────────────────────────────────────

test('tokens are compared whole', () => {
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abc', 'abd'), false);
  assert.equal(tokenMatches('abc', 'abcd'), false);
  assert.equal(tokenMatches('abc', ''), false);
  assert.equal(tokenMatches('', ''), false, 'no token set never matches');
  assert.equal(tokenMatches('abc', 123), false);
  assert.equal(tokenMatches('abc', undefined), false);
});

test('nothing is listened to before the right token; after it, everything', () => {
  const timers = fakeTimers();
  const auth = createSocketAuth({ token: 'secret', ...timers });
  const socket = fakeSocket();
  let authenticated = 0;
  const guard = auth.guard(socket, { onAuthenticated: () => authenticated++ });

  // The reviewer's one-liner, and a PING posing as a browser: ignored.
  assert.equal(guard.accept({ type: 'WHITELIST_UPDATE', data: [{ pattern: 'facebook.com', type: 'domain', expiresAt: 9999999999999 }] }), false);
  assert.equal(guard.accept({ type: 'PING', browser: 'firefox' }), false);
  assert.equal(guard.accept(null), false);
  assert.equal(guard.authenticated(), false);
  assert.equal(socket.ended, false, 'still inside the grace time');

  assert.equal(guard.accept({ type: 'NATIVE_HOST_CONNECTED', browser: 'firefox', token: 'secret' }), true);
  assert.equal(authenticated, 1);
  assert.equal(guard.authenticated(), true);
  assert.equal(guard.accept({ type: 'PING', browser: 'firefox' }), true);
  assert.equal(guard.accept({ type: 'NATIVE_HOST_CONNECTED', browser: 'firefox', token: 'secret' }), true);
  assert.equal(authenticated, 1, 'only once');

  timers.run();
  assert.equal(socket.ended, false, 'the grace timer was cancelled');
  assert.equal(socket.destroyed, false);
});

test('a connection that never sends the token is closed after the grace time', () => {
  const timers = fakeTimers();
  const logged = [];
  const auth = createSocketAuth({ token: 'secret', log: (line) => logged.push(line), ...timers });
  const socket = fakeSocket();
  const guard = auth.guard(socket);
  assert.equal(timers.active()[0].ms, AUTH_GRACE_MS);

  guard.accept({ type: 'PING', browser: 'chrome' });
  timers.run(AUTH_GRACE_MS);

  assert.equal(socket.ended, true);
  assert.equal(JSON.parse(socket.written[0]).type, 'ERROR');
  assert.equal(JSON.parse(socket.written[0]).error, REFUSAL.SILENT);
  assert.equal(guard.accept({ type: 'NATIVE_HOST_CONNECTED', token: 'secret' }), false, 'too late');
  timers.run();
  assert.equal(socket.destroyed, true);
  assert.match(logged[0], /Refused a connection/);
});

test('an old host (no token) is refused at once with a clear reason, logged once a minute', () => {
  const timers = fakeTimers();
  const logged = [];
  let clock = 0;
  const auth = createSocketAuth({ token: 'secret', log: (line) => logged.push(line), now: () => clock, ...timers });

  const first = fakeSocket();
  const guard = auth.guard(first);
  assert.equal(guard.accept({ type: 'NATIVE_HOST_CONNECTED', browser: 'firefox' }), false);
  assert.equal(first.ended, true);
  assert.equal(JSON.parse(first.written[0]).error, REFUSAL.OLD_HOST);
  assert.equal(guard.accept({ type: 'WHITELIST_UPDATE', data: [] }), false, 'and nothing it sends afterwards counts');
  assert.match(logged[0], /older Focus Bear/);

  // It retries every 2 seconds: refused every time, logged once a minute.
  clock = 2000;
  const again = fakeSocket();
  auth.guard(again).accept({ type: 'NATIVE_HOST_CONNECTED', browser: 'firefox' });
  assert.equal(again.ended, true);
  assert.equal(logged.length, 1);
  clock = 61000;
  auth.guard(fakeSocket()).accept({ type: 'NATIVE_HOST_CONNECTED', browser: 'firefox' });
  assert.equal(logged.length, 2);
});

test('a wrong token is refused', () => {
  const timers = fakeTimers();
  const auth = createSocketAuth({ token: 'secret', ...timers });
  const socket = fakeSocket();
  const guard = auth.guard(socket);
  assert.equal(guard.accept({ type: 'NATIVE_HOST_CONNECTED', token: 'guess' }), false);
  assert.equal(JSON.parse(socket.written[0]).error, REFUSAL.WRONG_TOKEN);
  assert.equal(guard.accept({ type: 'NATIVE_HOST_CONNECTED', token: 'secret' }), false, 'one try per connection');

  const numeric = auth.guard(fakeSocket());
  assert.equal(numeric.accept({ type: 'NATIVE_HOST_CONNECTED', token: 12345 }), false);
});

test('dispose cancels the grace timer of a connection that went away', () => {
  const timers = fakeTimers();
  const auth = createSocketAuth({ token: 'secret', ...timers });
  const socket = fakeSocket();
  auth.guard(socket).dispose();
  timers.run();
  assert.equal(socket.ended, false);
});

test('over a real socket: an unauthenticated WHITELIST_UPDATE never reaches the app', async () => {
  const home = tempHome();
  try {
    const { socketPath, token } = await prepareSocket({ env: {}, home });
    const auth = createSocketAuth({ token, graceMs: 200 });
    const acted = [];
    const server = createServer((socket) => {
      const guard = auth.guard(socket);
      socket.on('data', createLineReader({ onLine: (line) => { const m = JSON.parse(line); if (guard.accept(m)) acted.push(m.type); } }));
      socket.on('close', () => guard.dispose());
      socket.on('error', () => {});
    });
    await new Promise((resolve) => server.listen(socketPath, resolve));
    try {
      const talk = (lines) => new Promise((resolve) => {
        let answer = '';
        const client = createConnection(socketPath, () => client.write(lines.map((l) => JSON.stringify(l) + '\n').join('')));
        client.on('data', (data) => { answer += data; });
        client.on('close', () => resolve(answer));
        client.on('error', () => resolve(answer));
        setTimeout(() => client.destroy(), 600);
      });
      const attack = { type: 'WHITELIST_UPDATE', data: [{ pattern: 'facebook.com', type: 'domain', expiresAt: 9999999999999 }] };

      const silent = await talk([attack]);
      assert.deepEqual(acted, []);
      assert.match(silent, /No token was sent in time/, 'closed after the grace time, with the reason');

      const old = await talk([{ type: 'NATIVE_HOST_CONNECTED', browser: 'firefox' }, attack]);
      assert.deepEqual(acted, []);
      assert.match(old, /older Focus Bear/);

      await talk([{ type: 'NATIVE_HOST_CONNECTED', browser: 'firefox', token }, { type: 'PING', browser: 'firefox' }]);
      assert.deepEqual(acted, ['NATIVE_HOST_CONNECTED', 'PING']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('lines are put together across pieces, and an endless line is cut off', () => {
  const lines = [];
  let overflow = 0;
  const feed = createLineReader({ onLine: (line) => lines.push(line), onOverflow: () => overflow++, maxBytes: 20 });
  feed(Buffer.from('{"a":'));
  feed(Buffer.from('1}\n{"b":2}\n\n{"c"'));
  feed(':3}\n');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);

  // A character split over two pieces survives.
  const euro = Buffer.from('é\n');
  feed(euro.subarray(0, 1));
  feed(euro.subarray(1));
  assert.equal(lines[3], 'é');

  feed('x'.repeat(30));
  assert.equal(overflow, 1);
  feed('more\n');
  assert.equal(lines.length, 4, 'nothing after the overflow is delivered');
});

// ── What the app accepts ─────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const entry = (pattern, minutes, type = 'domain') => ({ pattern, type, expiresAt: NOW + minutes * MIN });

test('a temporary unblock lasts at most what the block page offers (90 minutes)', () => {
  assert.equal(MAX_UNBLOCK_MS, 90 * MIN);
  const result = validateWhitelistUpdate([
    { pattern: 'facebook.com', type: 'domain', expiresAt: 9999999999999, extra: 'dropped' },
    entry('x.com', 30),
    entry('https://example.com/a?b=1', 5, 'exact'),
    entry('old.com', -1),
  ], { now: NOW });
  assert.equal(validateWhitelistUpdate([entry('xn--caf-dma.fr', 5), entry('[::1]', 5), entry('192.168.0.1', 5)], { now: NOW }).ok, true);
  assert.deepEqual(result, {
    ok: true,
    entries: [
      { pattern: 'facebook.com', type: 'domain', expiresAt: NOW + 90 * MIN },
      entry('x.com', 30),
      entry('https://example.com/a?b=1', 5, 'exact'),
    ],
  });
  assert.deepEqual(validateWhitelistUpdate([], { now: NOW }), { ok: true, entries: [] });
});

test('a malformed update is refused whole', () => {
  const refused = (data) => assert.equal(validateWhitelistUpdate(data, { now: NOW }).ok, false, JSON.stringify(data));
  refused(undefined);
  refused({ length: 1 });
  refused('facebook.com');
  refused([null]);
  refused([['facebook.com']]);
  refused([entry('x.com', 5), { pattern: 'facebook.com', type: 'domain' }]);
  refused([{ pattern: 'facebook.com', type: 'domain', expiresAt: '9999999999999' }]);
  refused([{ pattern: 'facebook.com', type: 'domain', expiresAt: Infinity }]);
  refused([{ pattern: 'facebook.com', type: 'forever', expiresAt: NOW + MIN }]);
  refused([{ pattern: '', type: 'domain', expiresAt: NOW + MIN }]);
  refused([{ pattern: 42, type: 'domain', expiresAt: NOW + MIN }]);
  refused([{ pattern: 'a.com/path', type: 'domain', expiresAt: NOW + MIN }]);
  refused([{ pattern: 'x'.repeat(5000), type: 'exact', expiresAt: NOW + MIN }]);
  refused(Array.from({ length: 201 }, (_, i) => entry(`site${i}.com`, 5)));
  assert.equal(validateWhitelistUpdate(Array.from({ length: 200 }, (_, i) => entry(`site${i}.com`, 5)), { now: NOW }).ok, true);
});

test('while "Immediately block" is on nothing is added or extended, only removed', () => {
  const current = [entry('facebook.com', 20), entry('x.com', 10)];
  const check = (data) => validateWhitelistUpdate(data, { now: NOW, current, immediatelyBlock: true });

  assert.equal(check([entry('facebook.com', 20), entry('x.com', 10), entry('reddit.com', 5)]).ok, false, 'a new site');
  assert.equal(check([entry('facebook.com', 60)]).ok, false, 'a longer unblock');
  assert.equal(check([entry('facebook.com', 20, 'exact')]).ok, false, 'another kind of entry');
  assert.match(check([entry('reddit.com', 5)]).reason, /Immediate blocking is on/);

  assert.deepEqual(check([entry('facebook.com', 20)]), { ok: true, entries: [entry('facebook.com', 20)] });
  assert.deepEqual(check([]), { ok: true, entries: [] });

  // With it off the same update is fine.
  assert.equal(validateWhitelistUpdate([entry('reddit.com', 5)], { now: NOW, current }).ok, true);
});

// ── Hosts from before this change ────────────────────────────────────────────

test('a host still looking at the old path is told why, read from never, and reported once', async () => {
  const home = tempHome();
  const path = join(home, 'legacy.sock');
  try {
    let outdated = 0;
    const logged = [];
    const watch = watchLegacySocket({ path, durationMs: 60000, onOutdatedHost: () => outdated++, log: (line) => logged.push(line) });
    for (let i = 0; i < 100 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 10));
    try {
      const connect = () => new Promise((resolve) => {
        let answer = '';
        const client = createConnection(path, () => client.write(JSON.stringify({ type: 'NATIVE_HOST_CONNECTED', browser: 'firefox' }) + '\n'));
        client.on('data', (data) => { answer += data; });
        client.on('close', () => resolve(answer));
        client.on('error', () => resolve(answer));
      });
      assert.match(await connect(), /older Focus Bear/);
      await connect();
      assert.equal(outdated, 1);
      assert.equal(logged.length, 1);
    } finally {
      watch.close();
    }
    for (let i = 0; i < 100 && existsSync(path); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(existsSync(path), false, 'the old path is closed again');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the old path being taken by someone else is only logged', async () => {
  const logged = [];
  const failing = {
    on(event, handler) { if (event === 'error') this.onError = handler; },
    listen() { this.onError(new Error('listen EADDRINUSE')); },
    close() {},
  };
  const watch = watchLegacySocket({
    path: '/nowhere/legacy.sock',
    createServer: () => failing,
    fs: { unlink: async () => { throw new Error('EPERM'); }, chmod: async () => {} },
    log: (line) => logged.push(line),
    setTimer: () => null,
    clearTimer: () => {},
  });
  await new Promise((r) => setTimeout(r, 10));
  watch.close();
  assert.match(logged[0], /Not watching the old socket path/);
});

test('stopNativeHosts stops this user\'s hosts and does not mind when there are none', async () => {
  const calls = [];
  const none = Object.assign(new Error('exit 1'), { code: 1 });
  const logged = [];
  assert.equal(await stopNativeHosts({ uid: 1000, log: (l) => logged.push(l), execFile: (cmd, args, cb) => { calls.push([cmd, ...args]); cb(null); } }), true);
  assert.deepEqual(calls[0], ['pkill', '-u', '1000', '-f', 'native-messaging/host\\.js']);
  assert.equal(await stopNativeHosts({ uid: 1000, log: (l) => logged.push(l), execFile: (cmd, args, cb) => cb(none) }), false);
  assert.deepEqual(logged, []);
  await stopNativeHosts({ uid: 1000, log: (l) => logged.push(l), execFile: (cmd, args, cb) => cb(new Error('no pkill')) });
  assert.match(logged[0], /Could not stop/);
});

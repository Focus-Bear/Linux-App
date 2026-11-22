// The native host as it ships (host.js run as its own process, the way a
// browser runs it), against an app-side socket built with socketAuth.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLineReader, createSocketAuth, prepareSocket, restrictSocket } from '../electron/socketAuth.js';

const HOST = join(dirname(fileURLToPath(import.meta.url)), 'host.js');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 10000) {
  for (let waited = 0; waited < ms; waited += 20) {
    if (check()) return true;
    await wait(20);
  }
  return false;
}

// What the browser does: length-prefixed JSON on stdin / stdout.
function startHost(env) {
  const child = spawn(process.execPath, [HOST], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [];
  let buffer = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const length = buffer.readUInt32LE(0);
      messages.push(JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')));
      buffer = buffer.subarray(4 + length);
    }
  });
  return {
    messages,
    send(message) {
      const body = Buffer.from(JSON.stringify(message));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length, 0);
      child.stdin.write(Buffer.concat([header, body]));
    },
    async stop() {
      child.stdin.end();
      await new Promise((resolve) => child.on('exit', resolve));
    },
  };
}

// The app side: the socket server as main.js sets it up.
async function startApp({ env, home, token }) {
  const prepared = await prepareSocket({ env, home, ...(token ? { newToken: () => token } : {}) });
  const auth = createSocketAuth({ token: prepared.token });
  const app = { ...prepared, received: [], ignored: [], sockets: [] };
  app.server = createServer((socket) => {
    app.sockets.push(socket);
    const guard = auth.guard(socket);
    socket.on('data', createLineReader({
      onLine: (line) => {
        const message = JSON.parse(line);
        (guard.accept(message) ? app.received : app.ignored).push(message);
      },
    }));
    socket.on('close', () => guard.dispose());
    socket.on('error', () => {});
  });
  await new Promise((resolve) => app.server.listen(prepared.socketPath, resolve));
  await restrictSocket(prepared.socketPath);
  app.close = () => new Promise((resolve) => {
    for (const socket of app.sockets) socket.destroy();
    app.server.close(resolve);
  });
  return app;
}

test('the host finds the socket in the runtime directory and sends the token first', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fb-host-'));
  const env = { HOME: home, XDG_RUNTIME_DIR: join(home, 'runtime') };
  const app = await startApp({ env, home });
  const host = startHost(env);
  try {
    assert.ok(await until(() => app.received.length >= 1), 'the host connected');
    assert.equal(app.received[0].type, 'NATIVE_HOST_CONNECTED');
    assert.equal(app.received[0].token, app.token);

    host.send({ type: 'PING', browser: 'firefox' });
    assert.ok(await until(() => app.received.some((m) => m.type === 'PING')));
    assert.equal(app.received.find((m) => m.type === 'PING').browser, 'firefox');
    assert.deepEqual(app.ignored, []);
    assert.ok(await until(() => host.messages.some((m) => m.type === 'PONG')));
    assert.equal(host.messages.find((m) => m.type === 'PONG').connectedToApp, true);

    // A long block list arrives in pieces; the extension gets it whole.
    const list = Array.from({ length: 3000 }, (_, i) => `secret-site-${i}.example`).concat('café.fr');
    const line = Buffer.from(JSON.stringify({ type: 'BLOCKLIST_UPDATE', data: list }) + '\n');
    const cut = line.length - 5; // inside "café"
    app.sockets[0].write(line.subarray(0, 1000));
    await wait(30);
    app.sockets[0].write(line.subarray(1000, cut));
    await wait(30);
    app.sockets[0].write(line.subarray(cut));
    assert.ok(await until(() => host.messages.some((m) => m.type === 'BLOCKLIST_UPDATE')));
    assert.deepEqual(host.messages.find((m) => m.type === 'BLOCKLIST_UPDATE').data, list);

    // The extension's temporary unblocks go to the app.
    host.send({ type: 'WHITELIST_UPDATE', data: [{ pattern: 'secret-unblock.example', type: 'domain', expiresAt: 1 }] });
    assert.ok(await until(() => app.received.some((m) => m.type === 'WHITELIST_UPDATE')));

    // The log is in the user's own directory, small, and holds no list.
    const logPath = join(home, '.local', 'share', 'focusbear', 'run', 'native-host.log');
    const log = readFileSync(logPath, 'utf8');
    assert.match(log, /Connected to Focus Bear/);
    assert.doesNotMatch(log, /secret-site|secret-unblock|café/);
    assert.ok(log.length < 2000, 'connection changes only, not every message');
  } finally {
    await host.stop();
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('without a runtime directory the host uses the one under the home directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fb-host-'));
  const env = { HOME: home };
  const app = await startApp({ env, home });
  const host = startHost(env);
  try {
    assert.equal(app.dir, join(home, '.local', 'share', 'focusbear', 'run'));
    assert.ok(await until(() => app.received.length >= 1));
    assert.equal(app.received[0].token, app.token);
  } finally {
    await host.stop();
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the host waits for the app, and reads the new token when the app restarts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fb-host-'));
  const env = { HOME: home, XDG_RUNTIME_DIR: join(home, 'runtime') };
  const host = startHost(env);
  let app = null;
  try {
    host.send({ type: 'PING', browser: 'chrome' });
    assert.ok(await until(() => host.messages.some((m) => m.type === 'PONG')));
    assert.equal(host.messages.find((m) => m.type === 'PONG').connectedToApp, false);

    app = await startApp({ env, home, token: 'first-token' });
    assert.ok(await until(() => app.received.length >= 1), 'connected once the app started');
    assert.equal(app.received[0].token, 'first-token');
    assert.equal(app.received[0].browser, 'chrome', 'it remembers which browser it serves');
    await app.close();

    app = await startApp({ env, home, token: 'second-token' });
    assert.ok(await until(() => app.received.length >= 1), 'reconnected');
    assert.equal(app.received[0].token, 'second-token');
    assert.deepEqual(app.ignored, []);
  } finally {
    await host.stop();
    if (app) await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the host has nothing to do with the shared temp folder any more', () => {
  const source = readFileSync(HOST, 'utf8');
  const code = source.split('\n').filter((line) => !/^\s*(\/\/|\*)/.test(line)).join('\n');
  assert.doesNotMatch(code, /\/tmp\b/);
  // It is copied on its own (installNativeMessaging in main.js): no local imports.
  assert.doesNotMatch(source, /from '\.{1,2}\//);
  assert.equal(existsSync(HOST), true);
});

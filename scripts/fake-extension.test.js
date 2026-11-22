import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildMessage, startFakeExtension } from './fake-extension.mjs';
import { createLineReader, createSocketAuth, findSocket, prepareSocket } from '../src/electron/socketAuth.js';

test('buildMessage writes one newline-terminated JSON line', () => {
  const line = buildMessage('PING', 'chrome', 123);
  assert.ok(line.endsWith('\n'));
  assert.deepEqual(JSON.parse(line), { type: 'PING', browser: 'chrome', timestamp: 123 });
  assert.equal(JSON.parse(buildMessage('NATIVE_HOST_CONNECTED', 'chrome', 1, { token: 't' })).token, 't');
});

test('finds the app socket, sends the token first and PINGs like the real native host', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fb-fake-ext-'));
  const env = { XDG_RUNTIME_DIR: join(home, 'runtime') };
  // The app side, as main.js sets it up.
  const { socketPath, token } = await prepareSocket({ env, home });
  const auth = createSocketAuth({ token });
  const received = [];
  const ignored = [];

  const server = createServer((socket) => {
    const guard = auth.guard(socket);
    socket.on('data', createLineReader({
      onLine: (line) => {
        const message = JSON.parse(line);
        (guard.accept(message) ? received : ignored).push(message);
      },
    }));
    socket.on('close', () => guard.dispose());
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const fake = startFakeExtension({ locate: () => findSocket({ env, home }), browser: 'brave', log: () => {} });
  try {
    for (let i = 0; i < 100 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(received[0]?.type, 'NATIVE_HOST_CONNECTED');
    assert.equal(received[0]?.token, token);
    assert.equal(received[1]?.type, 'PING');
    assert.ok(received.every((m) => m.browser === 'brave'));
    assert.deepEqual(ignored, [], 'the app listened to everything it sent');
  } finally {
    fake.stop();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});

test('waits when the app is not running', async () => {
  const logged = [];
  const fake = startFakeExtension({ locate: async () => null, retryMs: 60000, log: (line) => logged.push(line) });
  await new Promise((r) => setTimeout(r, 20));
  fake.stop();
  assert.match(logged.join('\n'), /Focus Bear is not running/);
});

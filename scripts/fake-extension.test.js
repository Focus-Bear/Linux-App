import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildMessage, startFakeExtension } from './fake-extension.mjs';

test('buildMessage writes one newline-terminated JSON line', () => {
  const line = buildMessage('PING', 'chrome', 123);
  assert.ok(line.endsWith('\n'));
  assert.deepEqual(JSON.parse(line), { type: 'PING', browser: 'chrome', timestamp: 123 });
});

test('identifies itself and PINGs like the real native host', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-fake-ext-'));
  const socketPath = join(dir, 'focusbear.sock');
  const received = [];

  const server = createServer((socket) => {
    socket.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(Boolean)) received.push(JSON.parse(line));
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const fake = startFakeExtension({ socketPath, browser: 'brave', log: () => {} });
  try {
    for (let i = 0; i < 50 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(received[0]?.type, 'NATIVE_HOST_CONNECTED');
    assert.equal(received[1]?.type, 'PING');
    assert.ok(received.every((m) => m.browser === 'brave'));
  } finally {
    fake.stop();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

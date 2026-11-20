#!/usr/bin/env node
// Dev helper: stands in for a browser extension's native-messaging host, so the
// first-run setup wizard and the "extension connected" checks pass without a real
// browser. Handy on WSL, VMs and CI where loading the extension isn't practical.
//
//   npm run dev:fake-extension            # pretends to be Firefox
//   npm run dev:fake-extension -- chrome  # or any id from Setup.jsx's BROWSERS
//
// It speaks the same newline-delimited JSON the real host sends over
// /tmp/focusbear.sock (see startSocketServer() in src/electron/main.js).
import { createConnection } from 'net';
import { fileURLToPath } from 'url';

export const DEFAULT_SOCKET_PATH = '/tmp/focusbear.sock';

export function buildMessage(type, browser, now = Date.now()) {
  return JSON.stringify({ type, browser, timestamp: now }) + '\n';
}

/**
 * Connects to the app's socket and keeps PINGing as `browser`.
 * Reconnects when the app restarts. Returns { stop }.
 */
export function startFakeExtension({
  socketPath = DEFAULT_SOCKET_PATH,
  browser = 'firefox',
  pingMs = 10000,
  log = console.log,
} = {}) {
  let socket = null;
  let pingTimer = null;
  let retryTimer = null;
  let stopped = false;

  const connect = () => {
    socket = createConnection(socketPath);
    socket.on('connect', () => {
      log(`[fake-extension] connected to ${socketPath} as ${browser}`);
      socket.write(buildMessage('NATIVE_HOST_CONNECTED', browser));
      socket.write(buildMessage('PING', browser));
      pingTimer = setInterval(() => socket.write(buildMessage('PING', browser)), pingMs);
    });
    socket.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        try {
          const message = JSON.parse(line);
          // FOCUSBEAR_FAKE_VERBOSE=1 also prints what the app sent (block list, allow list).
          const detail = process.env.FOCUSBEAR_FAKE_VERBOSE === '1' ? ` ${JSON.stringify(message.data)}` : '';
          log(`[fake-extension] <- ${message.type}${detail}`);
        } catch {
          // partial line; the next chunk completes it
        }
      }
    });
    socket.on('error', (error) => log(`[fake-extension] ${error.message}`));
    socket.on('close', () => {
      clearInterval(pingTimer);
      if (stopped) return;
      log('[fake-extension] disconnected; retrying in 2s');
      retryTimer = setTimeout(connect, 2000);
    });
  };

  connect();

  return {
    stop() {
      stopped = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      socket?.destroy();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startFakeExtension({
    browser: process.argv[2] || 'firefox',
    socketPath: process.env.FOCUSBEAR_SOCKET || DEFAULT_SOCKET_PATH,
  });
}

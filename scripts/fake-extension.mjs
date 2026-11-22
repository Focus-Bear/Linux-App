#!/usr/bin/env node
// Dev helper: stands in for a browser extension's native-messaging host, so the
// first-run setup wizard and the "extension connected" checks pass without a real
// browser. Handy on WSL, VMs and CI where loading the extension isn't practical.
//
//   npm run dev:fake-extension            # pretends to be Firefox
//   npm run dev:fake-extension -- chrome  # or any id from Setup.jsx's BROWSERS
//
// It speaks the same newline-delimited JSON the real host sends over the app's
// socket (see startSocketServer() in src/electron/main.js). Like the real host
// it finds the socket in the user's own directory and sends the token the app
// wrote next to it (src/electron/socketAuth.js); it must run as the same user.
import { createConnection } from 'net';
import { fileURLToPath } from 'url';
import { findSocket } from '../src/electron/socketAuth.js';

export function buildMessage(type, browser, now = Date.now(), extra = {}) {
  return JSON.stringify({ type, browser, timestamp: now, ...extra }) + '\n';
}

/**
 * Connects to the app's socket and keeps PINGing as `browser`.
 * Reconnects when the app restarts. Returns { stop }.
 *
 * `locate()` resolves to { socketPath, token } of the running app, or null
 * when it is not running. It is asked again before every connection, because
 * the app writes a new token each time it starts.
 */
export function startFakeExtension({
  locate = () => findSocket(),
  browser = 'firefox',
  pingMs = 10000,
  retryMs = 2000,
  log = console.log,
} = {}) {
  let socket = null;
  let pingTimer = null;
  let retryTimer = null;
  let stopped = false;

  const retry = (why) => {
    if (stopped) return;
    log(`[fake-extension] ${why}; retrying in ${retryMs / 1000}s`);
    retryTimer = setTimeout(connect, retryMs);
  };

  const connect = async () => {
    let target = null;
    try {
      target = await locate();
    } catch (error) {
      log(`[fake-extension] ${error.message}`);
    }
    if (stopped) return;
    if (!target) {
      retry('Focus Bear is not running (no socket found)');
      return;
    }
    const { socketPath, token } = target;
    let pending = '';
    socket = createConnection(socketPath);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      log(`[fake-extension] connected to ${socketPath} as ${browser}`);
      // The token goes in the first message; the app ignores everything before it.
      socket.write(buildMessage('NATIVE_HOST_CONNECTED', browser, Date.now(), { token }));
      socket.write(buildMessage('PING', browser));
      pingTimer = setInterval(() => socket.write(buildMessage('PING', browser)), pingMs);
    });
    socket.on('data', (data) => {
      // A long block list arrives in several pieces: wait for the whole line.
      pending += data;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines.filter(Boolean)) {
        try {
          const message = JSON.parse(line);
          // FOCUSBEAR_FAKE_VERBOSE=1 also prints what the app sent (block list, allow list).
          // A refusal (wrong token) is always printed.
          const detail = process.env.FOCUSBEAR_FAKE_VERBOSE === '1' || message.type === 'ERROR'
            ? ` ${JSON.stringify(message.data ?? message.error)}` : '';
          log(`[fake-extension] <- ${message.type}${detail}`);
        } catch {
          // not JSON; ignore
        }
      }
    });
    socket.on('error', (error) => log(`[fake-extension] ${error.message}`));
    socket.on('close', () => {
      clearInterval(pingTimer);
      retry('disconnected');
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
  startFakeExtension({ browser: process.argv[2] || 'firefox' });
}

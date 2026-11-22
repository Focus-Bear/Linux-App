#!/usr/bin/env node

/**
 * Native Messaging Host for Focus Bear
 * Connects to Electron app via Unix socket for bidirectional communication.
 * Must stay a single file without local imports: the app copies host.js alone.
 */

import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync } from 'fs';
import { createConnection } from 'net';
import { homedir } from 'os';
import { join } from 'path';

// Where the app's socket and its token are. The same rules as
// src/electron/socketAuth.js (this file is copied on its own into
// ~/.local/share/focusbear, so it cannot import that one).
//
// It used to be /tmp/focusbear.sock: on a shared computer another user could
// create that path first and send this host their own block lists. Now the
// socket is in a directory only this user can enter, and the host proves who
// it is with the token the app writes there at every start.
const UID = typeof process.getuid === 'function' ? process.getuid() : undefined;
const HOME_RUN_DIR = join(homedir(), '.local', 'share', 'focusbear', 'run');

function socketDirs() {
  const dirs = [];
  if (process.env.XDG_RUNTIME_DIR) dirs.push(join(process.env.XDG_RUNTIME_DIR, 'focusbear'));
  // A browser may run this host with another XDG_RUNTIME_DIR than the app has
  // (or none). The user's real runtime directory is tried as well.
  if (UID !== undefined) dirs.push(`/run/user/${UID}/focusbear`);
  dirs.push(HOME_RUN_DIR);
  return [...new Set(dirs)];
}

// The places where an app may be listening now: a directory that is ours alone,
// with a token and a socket in it.
function findSockets() {
  const found = [];
  for (const dir of socketDirs()) {
    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory()) continue;
      if (UID !== undefined && stat.uid !== UID) continue;
      if (stat.mode & 0o022) continue; // others could have put a socket here
      const socketPath = join(dir, 'focusbear.sock');
      if (!existsSync(socketPath)) continue;
      const token = readFileSync(join(dir, 'token'), 'utf8').trim();
      if (token) found.push({ socketPath, token });
    } catch {
      // not there
    }
  }
  return found;
}

// One message from the app is one line. Block lists are long, but not this long.
const MAX_LINE_LENGTH = 4 * 1024 * 1024;
const RETRY_MS = 2000;

let appSocket = null;
let isConnectedToApp = false;
let cachedBrowserId = null;
let pendingBlocklistCallback = null;
let pendingBlocklistTimeout = null;
// Which of the found sockets to try next (moves on after a failed attempt).
let attempt = 0;

// Native messaging uses length-prefixed JSON messages
function sendMessage(message) {
  const buffer = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buffer.length, 0);

  process.stdout.write(header);
  process.stdout.write(buffer);
}

function readMessage(callback) {
  let buffer = Buffer.alloc(0);

  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
      const msgLen = buffer.readUInt32LE(0);
      if (buffer.length < 4 + msgLen) break;
      try {
        callback(JSON.parse(buffer.slice(4, 4 + msgLen).toString('utf8')));
      } catch (error) {
        log(`Error parsing stdin message: ${error.message}`);
      }
      buffer = buffer.slice(4 + msgLen);
    }
  });
}

// A small log, since stdout is used for messaging. It is kept in the user's own
// directory (not in the shared temp folder, where everyone could read it and it
// grew without limit) and holds connection changes and errors only: never a
// message's content, so no block list or allow list ends up in it.
const LOG_PATH = join(HOME_RUN_DIR, 'native-host.log');
const MAX_LOG_BYTES = 256 * 1024;
let lastLogged = null;

function log(message) {
  // The same line over and over (the app is closed, retry every 2 s) is written once.
  if (message === lastLogged) return;
  lastLogged = message;
  try {
    mkdirSync(HOME_RUN_DIR, { recursive: true, mode: 0o700 });
    try {
      if (statSync(LOG_PATH).size > MAX_LOG_BYTES) renameSync(LOG_PATH, LOG_PATH + '.old');
    } catch {
      // no log yet
    }
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 });
  } catch {
    // Logging must never stop the host.
  }
}

function retryLater() {
  setTimeout(connectToApp, RETRY_MS);
}

// What the app sends is passed on to the extension as it is.
const FORWARDED = ['BLOCKLIST_UPDATE', 'WHITELIST_UPDATE', 'BLOCK_SETTINGS_UPDATE', 'WHITELIST_RESPONSE'];

function handleAppLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    log(`Error parsing socket message: ${error.message}`);
    return;
  }
  if (!message || typeof message.type !== 'string') return;

  if (FORWARDED.includes(message.type)) {
    sendMessage({ type: message.type, data: message.data, timestamp: Date.now() });
  } else if (message.type === 'BLOCKLIST_RESPONSE') {
    if (pendingBlocklistCallback) {
      const cb = pendingBlocklistCallback;
      pendingBlocklistCallback = null;
      clearTimeout(pendingBlocklistTimeout);
      pendingBlocklistTimeout = null;
      cb(null, message.data);
    }
  } else if (message.type === 'ERROR') {
    // The app refused this host (wrong or missing token) and closes the socket.
    log(`The app refused the connection: ${String(message.error).slice(0, 200)}`);
  }
}

// Connect to Electron app via Unix socket
function connectToApp() {
  const sockets = findSockets();
  if (sockets.length === 0) {
    log('Focus Bear is not running (no socket found). Will retry...');
    retryLater();
    return;
  }
  const { socketPath, token } = sockets[attempt % sockets.length];
  let pending = '';
  let connected = false;

  const socket = createConnection(socketPath);
  // Text, so a character split over two pieces is put together again.
  socket.setEncoding('utf8');
  appSocket = socket;

  socket.on('connect', () => {
    log(`Connected to Focus Bear at ${socketPath}`);
    connected = true;
    isConnectedToApp = true;

    // First message: who we are. Without the right token the app does not
    // listen. The cached browser ID covers reconnects.
    socket.write(JSON.stringify({ type: 'NATIVE_HOST_CONNECTED', browser: cachedBrowserId, token }) + '\n');
  });

  socket.on('data', (data) => {
    // A long block list arrives in several pieces: wait for the whole line.
    pending += data;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) handleAppLine(line);
      newline = pending.indexOf('\n');
    }
    if (pending.length > MAX_LINE_LENGTH) {
      log('A message from the app was too long. Reconnecting.');
      pending = '';
      socket.destroy();
    }
  });

  socket.on('error', (error) => {
    log(`Socket error: ${error.code || error.message}`);
  });

  socket.on('close', () => {
    if (connected) log('Socket connection closed. Will retry...');
    else attempt++; // never got through: try the next place, if there is one
    isConnectedToApp = false;
    if (appSocket === socket) appSocket = null;
    retryLater();
  });
}

// Request blocklist from app via socket
function requestBlocklist(callback) {
  if (!isConnectedToApp || !appSocket) {
    callback(new Error('Not connected to app'), []);
    return;
  }

  if (pendingBlocklistCallback) {
    callback(new Error('Request already pending'), []);
    return;
  }

  pendingBlocklistCallback = callback;
  pendingBlocklistTimeout = setTimeout(() => {
    log('Blocklist request timed out');
    pendingBlocklistCallback = null;
    pendingBlocklistTimeout = null;
    callback(new Error('Timeout'), []);
  }, 5000);

  appSocket.write(JSON.stringify({ type: 'GET_BLOCKLIST' }) + '\n');
}

log('Native messaging host started');

// When extension is disabled/removed, Firefox closes stdin — exit cleanly so
// Electron's socket close handler detects the disconnection immediately.
process.stdin.on('end', () => {
  log('stdin closed (extension disconnected), exiting');
  if (appSocket) appSocket.end();
  process.exit(0);
});

// Connect to Electron app
connectToApp();

// Handle messages from the extension
readMessage((message) => {
  if (!message || typeof message.type !== 'string') return;

  switch (message.type) {
    case 'GET_BLOCKLIST':
      requestBlocklist((error, blocklist) => {
        if (error) {
          log(`Error getting blocklist: ${error.message}`);
          sendMessage({
            type: 'ERROR',
            error: error.message
          });
        } else {
          sendMessage({
            type: 'BLOCKLIST_RESPONSE',
            data: blocklist,
            timestamp: Date.now()
          });
        }
      });
      break;

    case 'PING':
      if (message.browser) cachedBrowserId = message.browser;
      sendMessage({
        type: 'PONG',
        timestamp: Date.now(),
        connectedToApp: isConnectedToApp
      });
      if (isConnectedToApp && appSocket) {
        appSocket.write(JSON.stringify({ type: 'PING', browser: cachedBrowserId || 'unknown', timestamp: Date.now() }) + '\n');
      }
      break;

    case 'GET_WHITELIST':
      if (isConnectedToApp && appSocket) {
        appSocket.write(JSON.stringify({ type: 'GET_WHITELIST' }) + '\n');
      } else {
        sendMessage({ type: 'WHITELIST_RESPONSE', data: [] });
      }
      break;

    case 'WHITELIST_UPDATE':
      if (isConnectedToApp && appSocket) {
        appSocket.write(JSON.stringify({
          type: 'WHITELIST_UPDATE',
          data: message.data,
          timestamp: Date.now()
        }) + '\n');
      }
      break;

    default:
      log(`Unknown message type: ${String(message.type).slice(0, 50)}`);
      sendMessage({
        type: 'ERROR',
        error: `Unknown message type: ${message.type}`
      });
  }
});

// Handle process termination
process.on('SIGTERM', () => {
  log('Received SIGTERM, closing socket and exiting');
  if (appSocket) {
    appSocket.end();
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  log('Received SIGINT, closing socket and exiting');
  if (appSocket) {
    appSocket.end();
  }
  process.exit(0);
});

log('Native host ready, waiting for messages');

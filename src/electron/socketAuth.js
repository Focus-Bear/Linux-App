// The socket between the app and the browsers' native-messaging hosts: where
// it lives, who may talk on it, and what the app accepts from it.
//
// It used to be /tmp/focusbear.sock with no checks. Any process could PING as
// a browser or send WHITELIST_UPDATE with any expiry (an unlimited unblock,
// saved to whitelist.json), and on a shared computer another user could create
// the path first and feed the host their own block lists. Now:
//   - the socket is in a directory only this user can enter (mode 0700):
//     $XDG_RUNTIME_DIR/focusbear, or ~/.local/share/focusbear/run without one
//   - the app writes a random token there (mode 0600) at every start; a host
//     sends it in its first message (NATIVE_HOST_CONNECTED). A connection that
//     has not sent the right token is not listened to and is closed
//   - what a host sends is checked before it is used (validateWhitelistUpdate)
//
// The token stops other users and anything that cannot read this user's
// files. A program running as the same user can read the token, as it can read
// whitelist.json; the checks on WHITELIST_UPDATE limit what it gains.
//
// No Electron imports, so this is tested with `node --test`
// (socketAuth.test.js) and shared with scripts/fake-extension.mjs.
// src/native-messaging/host.js carries its own copy of the path rules: it is
// copied on its own into ~/.local/share/focusbear and cannot import this.
import { promises as fsp } from 'fs';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { createServer as netCreateServer } from 'net';
import { homedir } from 'os';
import { join } from 'path';
import { StringDecoder } from 'string_decoder';

export const SOCKET_FILE = 'focusbear.sock';
export const TOKEN_FILE = 'token';
// Where the app and the host met before. Never listened to for messages again.
export const LEGACY_SOCKET_PATH = '/tmp/focusbear.sock';

// A host must send its token within this time of connecting.
export const AUTH_GRACE_MS = 5000;
// The longest "Unblock temporarily" choice on the block page (blocked.html).
export const MAX_UNBLOCK_MS = 90 * 60 * 1000;
export const MAX_WHITELIST_ENTRIES = 200;
const MAX_PATTERN_LENGTH = 4096;
// One message is one line. Block lists are long, but not this long.
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

// ── Where the socket lives ───────────────────────────────────────────────────

/**
 * The directories the socket may be in, best first: the user's runtime
 * directory (gone at logout, never on a network drive), then the home
 * directory for systems without one.
 */
export function socketDirs({ env = process.env, home = homedir() } = {}) {
  const dirs = [];
  if (env.XDG_RUNTIME_DIR) dirs.push(join(env.XDG_RUNTIME_DIR, 'focusbear'));
  dirs.push(join(home, '.local', 'share', 'focusbear', 'run'));
  return dirs;
}

export const socketFiles = (dir) => ({
  dir,
  socketPath: join(dir, SOCKET_FILE),
  tokenPath: join(dir, TOKEN_FILE),
});

/** A directory of ours that nobody else can enter or write to. */
async function privateDir(dir, { fs, uid }) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${dir} belongs to another user`);
  await fs.chmod(dir, 0o700);
}

/**
 * Gets the socket directory ready for this run: creates it (0700), removes a
 * socket left by a crash, and writes a fresh token (0600).
 * Returns { dir, socketPath, tokenPath, token }. Call before listening.
 */
export async function prepareSocket({
  env = process.env,
  home = homedir(),
  fs = fsp,
  uid = typeof process.getuid === 'function' ? process.getuid() : undefined,
  newToken = () => randomBytes(32).toString('hex'),
} = {}) {
  let lastError = null;
  for (const dir of socketDirs({ env, home })) {
    try {
      await privateDir(dir, { fs, uid });
      const files = socketFiles(dir);
      await fs.unlink(files.socketPath).catch(() => {});
      const token = newToken();
      // Written next to the token and renamed: a host never reads half a token.
      const temp = files.tokenPath + '.new';
      await fs.unlink(temp).catch(() => {});
      await fs.writeFile(temp, token + '\n', { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, files.tokenPath);
      return { ...files, token };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No directory for the socket');
}

/** After listen(): only this user may connect. */
export async function restrictSocket(socketPath, { fs = fsp } = {}) {
  await fs.chmod(socketPath, 0o600);
}

/**
 * The running app's socket and token, for a helper run by the same user
 * (scripts/fake-extension.mjs). null when the app has not started.
 */
export async function findSocket({ env = process.env, home = homedir(), fs = fsp } = {}) {
  for (const dir of socketDirs({ env, home })) {
    const files = socketFiles(dir);
    try {
      const token = (await fs.readFile(files.tokenPath, 'utf8')).trim();
      await fs.lstat(files.socketPath);
      if (token) return { ...files, token };
    } catch { /* not here */ }
  }
  return null;
}

// ── Who may talk ─────────────────────────────────────────────────────────────

/** Compares two tokens without telling, through timing, where they differ. */
export function tokenMatches(expected, given) {
  if (typeof expected !== 'string' || typeof given !== 'string' || !expected) return false;
  const digest = (text) => createHash('sha256').update(text).digest();
  return timingSafeEqual(digest(expected), digest(given));
}

export const REFUSAL = {
  OLD_HOST: 'This native host did not send a token. It is from an older Focus Bear. Restart the browser to load the new one.',
  WRONG_TOKEN: 'Wrong token. Focus Bear was restarted; connect again.',
  SILENT: 'No token was sent in time.',
};

/**
 * Per-connection authentication.
 *
 *   const auth = createSocketAuth({ token, log });
 *   const guard = auth.guard(socket, { onAuthenticated });
 *   // for every message of that socket:
 *   if (!guard.accept(message)) return;   // not listened to
 *
 * A connection starts unauthenticated. Its first NATIVE_HOST_CONNECTED with
 * the right token authenticates it (`onAuthenticated` runs once; send the
 * block lists there, not on connect). Until then every message is ignored. A
 * host without a token (an older version) or with a wrong one is told why and
 * closed at once; one that stays silent is closed after `graceMs`.
 */
export function createSocketAuth({
  token,
  graceMs = AUTH_GRACE_MS,
  log = () => {},
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logEveryMs = 60 * 1000,
} = {}) {
  // An old host retries every 2 seconds; say it once a minute, not every time.
  const lastLogged = new Map();
  const logRefusal = (reason) => {
    const last = lastLogged.get(reason);
    if (last !== undefined && now() - last < logEveryMs) return;
    lastLogged.set(reason, now());
    log(`[Socket] Refused a connection: ${reason}`);
  };

  return {
    guard(socket, { onAuthenticated = () => {} } = {}) {
      let state = 'waiting'; // 'waiting' | 'authenticated' | 'refused'
      let timer = null;

      const refuse = (reason) => {
        if (state !== 'waiting') return;
        state = 'refused';
        if (timer !== null) clearTimer(timer);
        timer = null;
        logRefusal(reason);
        try {
          socket.end(JSON.stringify({ type: 'ERROR', error: reason }) + '\n');
        } catch { /* already gone */ }
        // end() waits for the other side; do not let it hold the connection open.
        const kill = setTimer(() => { try { socket.destroy(); } catch { /* gone */ } }, 1000);
        if (kill && typeof kill.unref === 'function') kill.unref();
      };

      timer = setTimer(() => { timer = null; refuse(REFUSAL.SILENT); }, graceMs);
      if (timer && typeof timer.unref === 'function') timer.unref();

      return {
        /** True when this message may be acted on. */
        accept(message) {
          if (state === 'authenticated') return true;
          if (state === 'refused') return false;
          if (!message || message.type !== 'NATIVE_HOST_CONNECTED') return false;
          if (message.token === undefined || message.token === null) {
            refuse(REFUSAL.OLD_HOST);
            return false;
          }
          if (!tokenMatches(token, message.token)) {
            refuse(REFUSAL.WRONG_TOKEN);
            return false;
          }
          state = 'authenticated';
          if (timer !== null) clearTimer(timer);
          timer = null;
          onAuthenticated();
          return true;
        },
        authenticated: () => state === 'authenticated',
        /** Call when the socket closes. */
        dispose() {
          if (timer !== null) clearTimer(timer);
          timer = null;
        },
      };
    },
  };
}

/**
 * Splits what arrives on a socket into lines, also when one message comes in
 * several pieces or several in one. `onLine(text)` gets each non-empty line.
 * A line longer than `maxBytes` is dropped whole and reported once through
 * `onOverflow` (close the connection there).
 */
export function createLineReader({ onLine, onOverflow = () => {}, maxBytes = MAX_LINE_BYTES }) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let overflowed = false;
  return function feed(chunk) {
    if (overflowed) return;
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) onLine(line);
      newline = pending.indexOf('\n');
    }
    if (pending.length > maxBytes) {
      overflowed = true;
      pending = '';
      onOverflow();
    }
  };
}

// ── What the app accepts ─────────────────────────────────────────────────────

const WHITELIST_TYPES = ['domain', 'exact'];

/**
 * Checks a WHITELIST_UPDATE (the extension's temporary unblocks) before the
 * app keeps it and saves it to whitelist.json.
 *
 *   data             what was sent: [{ pattern, type: 'domain'|'exact', expiresAt }]
 *   current          the app's list now
 *   immediatelyBlock "Immediately block" is on
 *
 * Returns { ok: true, entries } (expired entries dropped, expiry cut to 90
 * minutes from now, nothing but the three fields kept) or { ok: false, reason }.
 * One malformed entry refuses the whole update. While "Immediately block" is
 * on nothing can be added or extended: only an update that removes entries
 * (one expired, or the user blocked the site again) is taken.
 */
export function validateWhitelistUpdate(data, {
  now = Date.now(),
  current = [],
  immediatelyBlock = false,
  maxEntries = MAX_WHITELIST_ENTRIES,
  maxMs = MAX_UNBLOCK_MS,
} = {}) {
  if (!Array.isArray(data)) return { ok: false, reason: 'The list is not an array.' };
  if (data.length > maxEntries) return { ok: false, reason: `More than ${maxEntries} entries.` };

  const entries = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, reason: 'An entry is not an object.' };
    const { pattern, type, expiresAt } = entry;
    if (typeof pattern !== 'string' || !pattern.trim() || pattern.length > MAX_PATTERN_LENGTH) {
      return { ok: false, reason: 'An entry has no usable pattern.' };
    }
    if (!WHITELIST_TYPES.includes(type)) return { ok: false, reason: 'An entry has an unknown type.' };
    if (type === 'domain' && !/^[a-z0-9._:[\]-]+$/i.test(pattern)) return { ok: false, reason: 'A domain entry is not a host name.' };
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return { ok: false, reason: 'An entry has no expiry.' };
    if (expiresAt <= now) continue;
    entries.push({ pattern, type, expiresAt: Math.min(expiresAt, now + maxMs) });
  }

  if (immediatelyBlock) {
    const known = new Map();
    for (const entry of Array.isArray(current) ? current : []) {
      if (entry && entry.expiresAt > now) known.set(`${entry.type}:${entry.pattern}`, entry.expiresAt);
    }
    for (const entry of entries) {
      const existing = known.get(`${entry.type}:${entry.pattern}`);
      if (existing === undefined || entry.expiresAt > existing) {
        return { ok: false, reason: 'Immediate blocking is on: no new or longer unblocks.' };
      }
    }
  }
  return { ok: true, entries };
}

// ── Hosts from before this change ────────────────────────────────────────────

/**
 * A native host started by an older version keeps looking for the app at
 * /tmp/focusbear.sock (every 2 seconds, for as long as the browser runs) and
 * would never find the new socket. For a short while after start the app
 * answers on the old path, only to notice such a host: it reads nothing from
 * it, tells it why it is refused, closes it and calls `onOutdatedHost` once
 * (see stopNativeHosts). Then the old path is closed again.
 * Returns { close }.
 */
export function watchLegacySocket({
  path = LEGACY_SOCKET_PATH,
  durationMs = 15000,
  onOutdatedHost = () => {},
  log = () => {},
  createServer = netCreateServer,
  fs = fsp,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let closed = false;
  let noticed = false;
  let timer = null;
  const server = createServer((socket) => {
    socket.on('error', () => {});
    try {
      socket.end(JSON.stringify({ type: 'ERROR', error: REFUSAL.OLD_HOST }) + '\n');
    } catch { /* gone */ }
    const kill = setTimer(() => { try { socket.destroy(); } catch { /* gone */ } }, 1000);
    if (kill && typeof kill.unref === 'function') kill.unref();
    if (noticed) return;
    noticed = true;
    log('[Socket] A native host from an older Focus Bear is still running. It is refused; the browser will start the new one.');
    onOutdatedHost();
  });
  // Someone else may own the old path (the very problem with it): then leave it.
  server.on('error', (error) => log(`[Socket] Not watching the old socket path: ${error.message}`));

  const close = () => {
    if (closed) return;
    closed = true;
    if (timer !== null) clearTimer(timer);
    try { server.close(); } catch { /* never listened */ }
  };

  fs.unlink(path).catch(() => {}).then(() => {
    if (closed) return;
    server.listen(path, () => {
      fs.chmod(path, 0o600).catch(() => {});
    });
    timer = setTimer(close, durationMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });

  return { close };
}

/**
 * Stops this user's running native hosts. The browsers start a fresh one (the
 * current host.js) when the extension next connects: Firefox within 5 seconds,
 * Chrome at its next one-minute alarm. `execFile` is child_process.execFile.
 */
export function stopNativeHosts({
  execFile,
  uid = typeof process.getuid === 'function' ? process.getuid() : undefined,
  log = () => {},
} = {}) {
  return new Promise((resolve) => {
    const args = ['-f', 'native-messaging/host\\.js'];
    if (uid !== undefined) args.unshift('-u', String(uid));
    execFile('pkill', args, (error) => {
      // pkill exits 1 when nothing matched.
      if (error && error.code !== 1) log(`[Socket] Could not stop the old native hosts: ${error.message}`);
      resolve(!error);
    });
  });
}

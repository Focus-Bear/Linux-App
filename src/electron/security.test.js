import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isAllowedNavigation,
  isDashboardNavigation,
  isDashboardOrigin,
  isFocusBearLink,
  isReleaseDownload,
  isTrustedSender,
  redactUrl,
} from './security.js';
import { cleanTokens, createTokenVault } from './tokenVault.js';

const TENANT = 'dev-2hidr8ad.us.auth0.com';

test('the main window navigates by parsed host, not by "contains auth0.com"', () => {
  const rule = { dev: false, auth0Domain: TENANT };
  assert.equal(isAllowedNavigation(`https://${TENANT}/v2/logout?client_id=x`, rule), true);
  assert.equal(isAllowedNavigation('file:///opt/Focus%20Bear/resources/app.asar/dist-react/index.html', rule), true);
  // What the old rule let through:
  assert.equal(isAllowedNavigation('https://evil.example/?auth0.com', rule), false);
  assert.equal(isAllowedNavigation('https://auth0.com.evil.example/login', rule), false);
  assert.equal(isAllowedNavigation('https://evil.example/auth0.com', rule), false);
  assert.equal(isAllowedNavigation('https://other-tenant.auth0.com/', rule), false, 'only this tenant');
  assert.equal(isAllowedNavigation(`http://${TENANT}/`, rule), false, 'https only');
  assert.equal(isAllowedNavigation('javascript:alert(1)', rule), false);
  assert.equal(isAllowedNavigation('not a url', rule), false);
  // Development: the Vite server, and only that port.
  assert.equal(isAllowedNavigation('http://localhost:5173/callback?code=1', { dev: true }), true);
  assert.equal(isAllowedNavigation('http://localhost:5173/', { dev: false }), false);
  assert.equal(isAllowedNavigation('http://localhost:9999/', { dev: true }), false);
  // Without a configured tenant any Auth0 tenant host passes, still by host.
  assert.equal(isAllowedNavigation('https://x.auth0.com/', {}), true);
  assert.equal(isAllowedNavigation('https://evil.example/?x.auth0.com', {}), false);
});

test("IPC is only taken from the app's own pages", () => {
  const packaged = { dev: false, appPath: '/opt/Focus Bear/resources/app.asar' };
  assert.equal(isTrustedSender('file:///opt/Focus%20Bear/resources/app.asar/dist-react/index.html', packaged), true);
  assert.equal(isTrustedSender('file:///opt/Focus%20Bear/resources/app.asar/src/ui/tray.html', packaged), true);
  assert.equal(isTrustedSender('file:///home/user/Downloads/evil.html', packaged), false);
  assert.equal(isTrustedSender('file:///opt/Focus%20Bear/resources/app.asar.evil/x.html', packaged), false);
  assert.equal(isTrustedSender('https://dev-x.auth0.com/login', packaged), false);
  assert.equal(isTrustedSender('https://dashboard.focusbear.io/webview/settings', packaged), false);
  assert.equal(isTrustedSender('http://localhost:5173/', packaged), false, 'the dev server is nothing in an installed build');
  assert.equal(isTrustedSender('', packaged), false);
  const dev = { dev: true, appPath: '/home/me/Linux-App' };
  assert.equal(isTrustedSender('http://localhost:5173/', dev), true);
  assert.equal(isTrustedSender('file:///home/me/Linux-App/src/ui/break-warning.html', dev), true);
  assert.equal(isTrustedSender('http://localhost:5173.evil.example/', dev), false);
});

test('links, downloads and dashboard pages are checked by host', () => {
  assert.equal(isFocusBearLink('https://www.focusbear.io/terms-of-service'), true);
  assert.equal(isFocusBearLink('https://support.focusbear.io/'), true);
  assert.equal(isFocusBearLink('https://focusbear.io.evil.example/'), false);
  assert.equal(isFocusBearLink('http://focusbear.io/'), false);

  assert.equal(isReleaseDownload('https://github.com/Focus-Bear/Linux-App/releases/download/v1.0.0/focusbear.AppImage'), true);
  assert.equal(isReleaseDownload('https://github.com/Someone/Else/releases/download/v1/x.AppImage'), false);
  assert.equal(isReleaseDownload('http://127.0.0.1:8765/x.AppImage'), false);
  assert.equal(isReleaseDownload('https://github.com.evil.example/Focus-Bear/Linux-App/releases/x'), false);

  assert.equal(isDashboardNavigation('https://dashboard.focusbear.io/webview/settings'), true);
  assert.equal(isDashboardNavigation('https://checkout.stripe.com/c/pay/x'), true, 'the subscription page pays through Stripe');
  assert.equal(isDashboardNavigation('https://evil.example/?dashboard.focusbear.io'), false);
  assert.equal(isDashboardOrigin('https://dashboard.focusbear.io/webview/stats'), true);
  assert.equal(isDashboardOrigin('https://evil.focusbear.io.example/'), false);
  assert.equal(isDashboardOrigin('https://checkout.stripe.com/'), false, 'only the dashboard itself may message the app');
});

test('addresses are logged without their query (sign-in codes) and fragment', () => {
  assert.equal(redactUrl('http://localhost/callback?code=SECRET&state=abc'), 'http://localhost/callback?…');
  assert.equal(redactUrl('focusbear://callback?code=SECRET'), 'focusbear://callback?…');
  assert.equal(redactUrl('https://x.auth0.com/authorize#token=SECRET'), 'https://x.auth0.com/authorize');
  assert.ok(!redactUrl('http://localhost/callback?code=SECRET').includes('SECRET'));
  assert.equal(redactUrl('nonsense'), '(unreadable address)');
});

// --- the token vault -------------------------------------------------------------

/** safeStorage stand-in: "encrypts" by reversing and tagging, and can be switched off. */
function fakeSafeStorage({ available = true, backend = 'gnome_libsecret' } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (text) => Buffer.from(`enc:${[...text].reverse().join('')}`),
    decryptString: (buffer) => {
      const text = buffer.toString();
      if (!text.startsWith('enc:')) throw new Error('not ours');
      return [...text.slice(4)].reverse().join('');
    },
  };
}

const TOKENS = { accessToken: 'ACCESS-TOKEN', refreshToken: 'REFRESH-TOKEN', idToken: 'ID-TOKEN', user: { sub: 'auth0|a', email: 'a@example.com' }, tokenExpiry: 1795400000000 };

test('the sign-in is written encrypted, for this user only, and read back', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'fb-vault-'));
  const path = join(dir, 'sign-in.bin');
  const vault = createTokenVault({ safeStorage: fakeSafeStorage(), fs, path });
  assert.equal(await vault.save({ ...TOKENS, somethingElse: 'dropped' }), true);
  const onDisk = await fs.readFile(path, 'utf8');
  assert.ok(!onDisk.includes('ACCESS-TOKEN') && !onDisk.includes('REFRESH-TOKEN'), 'no plain token on disk');
  assert.equal((await fs.stat(path)).mode & 0o077, 0);
  assert.deepEqual(await vault.load(), TOKENS);
  assert.equal(vault.protection(), 'keyring');
  await vault.clear();
  assert.equal(await vault.load(), null);
  await vault.clear(); // nothing to clear is fine
});

test('without a keyring API nothing is written; a fixed-key fallback is reported as such', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'fb-vault-'));
  const path = join(dir, 'sign-in.bin');
  const none = createTokenVault({ safeStorage: fakeSafeStorage({ available: false }), fs, path });
  assert.equal(await none.save(TOKENS), false);
  assert.deepEqual(await fs.readdir(dir), []);
  assert.equal(await none.load(), null);
  assert.equal(none.protection(), 'none');
  assert.equal(createTokenVault({ safeStorage: fakeSafeStorage({ backend: 'basic_text' }), fs, path }).protection(), 'obscured');
});

test('a damaged file, or one from another keyring, reads as signed out', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'fb-vault-'));
  const path = join(dir, 'sign-in.bin');
  await fs.writeFile(path, 'garbage');
  const vault = createTokenVault({ safeStorage: fakeSafeStorage(), fs, path });
  assert.equal(await vault.load(), null);
  assert.equal(await vault.save({ refreshToken: 'only' }), false, 'nothing to keep without an access token');
  assert.equal(cleanTokens({ accessToken: 5 }), null);
  assert.deepEqual(cleanTokens({ accessToken: 'a', user: 'nope', tokenExpiry: 'x' }), { accessToken: 'a' });
});

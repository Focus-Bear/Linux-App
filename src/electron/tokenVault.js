// Where the sign-in tokens are kept: one file in the app's data folder,
// encrypted with the desktop's keyring (Electron safeStorage: libsecret /
// KWallet), readable by this user only.
//
// They used to sit in the window's localStorage as plain text (access token,
// refresh token, id token). `safeStorage` and `fs` are passed in (tokenVault.test.js).
//
// When the desktop has no keyring, safeStorage on Linux falls back to a fixed
// key ("basic_text"): the file is then obscured, not protected, which
// `protection()` reports so the app can say so in its log. When safeStorage
// can't be used at all, nothing is written and the window keeps the tokens
// for the session only.

const FIELDS = ['accessToken', 'refreshToken', 'idToken', 'user', 'tokenExpiry'];

/** Only the known fields, with the right types. */
export function cleanTokens(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const key of ['accessToken', 'refreshToken', 'idToken']) {
    if (typeof input[key] === 'string' && input[key]) out[key] = input[key];
  }
  if (input.user && typeof input.user === 'object' && !Array.isArray(input.user)) out.user = input.user;
  if (Number.isFinite(Number(input.tokenExpiry))) out.tokenExpiry = Number(input.tokenExpiry);
  return out.accessToken ? out : null;
}

export function createTokenVault({ safeStorage, fs, path, log = () => {} }) {
  const usable = () => {
    try {
      return Boolean(safeStorage && safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  };

  return {
    /** 'keyring' | 'obscured' | 'none' */
    protection() {
      if (!usable()) return 'none';
      let backend = '';
      try {
        backend = safeStorage.getSelectedStorageBackend ? safeStorage.getSelectedStorageBackend() : '';
      } catch {
        backend = '';
      }
      return backend === 'basic_text' ? 'obscured' : 'keyring';
    },

    /** The saved tokens, or null (no file, another keyring, a damaged file). */
    async load() {
      if (!usable()) return null;
      try {
        const encrypted = await fs.readFile(path);
        return cleanTokens(JSON.parse(safeStorage.decryptString(encrypted)));
      } catch {
        return null;
      }
    },

    /** Saves the tokens. False when they could not be kept (the window then holds them for this run only). */
    async save(tokens) {
      const clean = cleanTokens(tokens);
      if (!clean) return false;
      if (!usable()) return false;
      try {
        const temporary = `${path}.tmp`;
        await fs.writeFile(temporary, safeStorage.encryptString(JSON.stringify(clean)), { mode: 0o600 });
        await fs.rename(temporary, path);
        return true;
      } catch (error) {
        log(`[Auth] The sign-in could not be saved: ${error?.message || error}`);
        return false;
      }
    },

    async clear() {
      try {
        await fs.unlink(path);
      } catch {
        // nothing saved
      }
      return true;
    },
  };
}

export { FIELDS as TOKEN_FIELDS };

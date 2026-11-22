// Reading and writing ~/.config/Focus Bear/settings.json.
//
// Several parts of the app save to this file at the same moment (the settings
// sync, device registration, onboarding), each with its own keys. So saves run
// one after another (each reads the file as the one before left it), and the
// file is replaced in one step (written to a temporary file, then renamed): a
// crash mid-write used to leave half a file, which was then read as "no
// settings" and brought the setup wizard back.
//
// `fs` (fs/promises) is passed in, so this can be tested on a temporary folder.
import { mergeLocalSettings } from './localSettings.js';

export function createSettingsFile({ path, fs, merge = mergeLocalSettings, pid = process.pid }) {
  let chain = Promise.resolve();

  /** The file's contents, or null when there is no (readable) file. */
  async function read() {
    try {
      const parsed = JSON.parse(await fs.readFile(path, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async function write(next) {
    const temporary = `${path}.${pid}.tmp`;
    // Only this user may read it: it holds the account's block list.
    await fs.writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fs.rename(temporary, path);
    return next;
  }

  /**
   * Saves `patch` on top of the file. `patch` is an object (merged in, see
   * localSettings.js) or a function `(existing) => next` for removing keys.
   * Rejects when the file could not be written.
   */
  function update(patch) {
    const run = chain.then(async () => {
      const existing = await read();
      return write(typeof patch === 'function' ? patch(existing || {}) : merge(existing, patch));
    });
    chain = run.catch(() => {});
    return run;
  }

  return { read: () => chain.then(read), update };
}

// What "signed out" means for the main process: one message from the window
// (`auth:signed-out`), and everything that belonged to the account stops.
//
// Before, sign-out only cleared the tokens in the window. The main process
// kept the focus session (the next account saw its end screen), the block list
// and allow list (renewed to the extensions every minute, for good), the break
// timer (reminders on the sign-in screen) and the embedded dashboard pages
// with the previous account's token.
//
// No Electron imports: main.js passes the steps in (accountState.test.js).

/** Keys of settings.json that are a copy of the account's synced settings. */
export const ACCOUNT_COPY_KEYS = [
  'urlList',
  'immediatelyBlock',
  'selectedBearMode',
  'selectedBlockMode',
  'selectedBlockMethod',
  'pomodoroMinutes',
  'breaksEnabled',
  'breakAutoStart',
  'reducedMotion',
  'focusMusicAutoStart',
  'settingsOwner',
  'unsyncedSettings',
  'lastRotatedBreakActivityId',
];

/** Per-account maps in settings.json, keyed by the account's `sub`. */
export const PER_ACCOUNT_MAPS = ['devices', 'deviceOs', 'onboardingDone'];

/**
 * settings.json after a sign-out: the copy of the account's settings is gone
 * (so a later start doesn't block the last account's list for whoever signs in
 * next), this computer's own values stay (setupComplete, selectedBrowsers).
 * `forgetUserId`: the account was deleted, so its device id and
 * "onboarding done" mark go too (a Google / Apple account that signs up again
 * has the same `sub`).
 */
export function withoutAccountCopy(settings, { forgetUserId = null } = {}) {
  const next = { ...(settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {}) };
  for (const key of ACCOUNT_COPY_KEYS) delete next[key];
  if (forgetUserId !== null && forgetUserId !== undefined) {
    for (const name of PER_ACCOUNT_MAPS) {
      if (!next[name] || typeof next[name] !== 'object') continue;
      const map = { ...next[name] };
      delete map[forgetUserId];
      next[name] = map;
    }
  }
  return next;
}

/**
 * Runs every step, also when one fails (a page that won't close must not keep
 * the allow list in force). Returns the names of the steps that failed.
 * `steps`: [name, fn] pairs; each fn may be async.
 */
export async function runSignOut(steps, log = () => {}) {
  const failed = [];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
      failed.push(name);
      log(`[Account] Sign-out step "${name}" failed: ${error?.message || error}`);
    }
  }
  return failed;
}

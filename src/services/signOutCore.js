// Signing out, in order. Everything is passed in (signOutCore.test.js).
//
//   1. A running focus session is reported to the server as finished now,
//      while there still is a token (best effort, with a time limit).
//   2. The window forgets the account: settings sync, block lists, a
//      postponed routine, the last-used session choices.
//   3. The main process is told (`auth:signed-out`): it drops the session,
//      stops blocking and the break timer, and closes the dashboard pages.
//   4. Only then are the tokens cleared and the sign-in page shown.
//
// Step 3 happens even when 1 or 2 fail: an allow list must never stay in force
// because a request timed out.
import { endSession, isActive } from '../electron/focusSessionModel.js';

/** localStorage keys that belong to the signed-in account, not to this computer. */
export const ACCOUNT_STORAGE_KEYS = ['fb_routine_postponed', 'fb_last_focus_strictness', 'fb_last_focus_mode'];

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);

export async function performSignOut({
  getSession = async () => null,
  reportFinish = async () => {},
  resetStores = () => {},
  tellMain = async () => {},
  clearTokens = async () => {},
  forgetUserId = null, // the account was deleted: also drop its device id and "onboarding done"
  now = () => Date.now(),
  reportTimeoutMs = 4000,
  log = console,
}) {
  try {
    const session = await getSession();
    if (isActive(session) && session.synced && session.modeId) {
      await withTimeout(Promise.resolve(reportFinish(endSession(session, now()))), reportTimeoutMs);
    }
  } catch (error) {
    log.error('[Sign-out] The running focus session could not be reported:', error?.message || error);
  }
  try {
    resetStores();
  } catch (error) {
    log.error('[Sign-out] Could not reset the window state:', error?.message || error);
  }
  try {
    await tellMain(forgetUserId ? { forgetUserId } : {});
  } catch (error) {
    log.error('[Sign-out] The main process could not be told:', error?.message || error);
  }
  await clearTokens();
}

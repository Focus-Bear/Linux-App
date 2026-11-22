// What the browser extensions are told to block, as the main process holds it:
//   always   the account's Super Distracting Sites and keywords
//   mode     the block list in force (a focus session's or a blocking
//            schedule's): extra entries, and for an allow list the only sites
//            that may be opened
//   settings "Immediately block" (plus the allow list, added here)
//
// Taken out of main.js so the rules can be tested without Electron
// (blockingState.test.js). `send(line)` writes one message to every connected
// native-messaging host.
//
// The list in force is decided by the signed-in window (src/ui/useBlocking.js)
// and renewed here every minute. So it must not outlive that window's say-so:
//   - signing out clears everything that came from the account
//   - the window confirms the list every minute; when it has been silent for
//     MODE_STALE_MS (it crashed, hung or is on the sign-in screen), an allow
//     list is lifted instead of renewed. It used to be renewed for as long as
//     the app ran, also after sign-out and into the next account's session.
import { DEFAULT_BLOCK_SETTINGS, blockSettingsMessage, normaliseBlockSettings } from './blockSettings.js';

export const MODE_STALE_MS = 3 * 60 * 1000;

const NO_MODE = Object.freeze({ blocklist: [], allowOnly: null });
const strings = (list) => (Array.isArray(list) ? list.filter((entry) => typeof entry === 'string' && entry.trim()) : []);

export function blocklistMessage(type, list, now) {
  return JSON.stringify({ type, data: list, timestamp: now }) + '\n';
}

export function createBlockingState({ send, now = () => Date.now(), log = () => {} }) {
  let always = [];
  let mode = NO_MODE;
  let settings = { ...DEFAULT_BLOCK_SETTINGS };
  let confirmedAt = 0;

  const blocklist = () => [...new Set([...always, ...mode.blocklist])];
  const current = () => normaliseBlockSettings({ ...settings, allowOnly: mode.allowOnly });

  const sendBlocklist = () => send(blocklistMessage('BLOCKLIST_UPDATE', blocklist(), now()));
  const sendSettings = () => send(blockSettingsMessage(current(), now()));

  const state = {
    /** What the extensions block now: always-blocked plus the list in force. */
    blocklist,
    /** { immediatelyBlock, allowOnly? } as the extensions get it. */
    settings: current,
    always: () => always,
    mode: () => mode,

    /** The messages a host gets when it connects. */
    greeting() {
      const lines = [];
      if (blocklist().length > 0) lines.push(blocklistMessage('BLOCKLIST_UPDATE', blocklist(), now()));
      lines.push(blockSettingsMessage(current(), now()));
      return lines;
    },

    setAlways(list) {
      always = strings(list);
      sendBlocklist();
    },

    setSettings(input) {
      settings = { immediatelyBlock: Boolean(input && input.immediatelyBlock === true) };
      sendSettings();
    },

    /** The window says which list is in force (also called every minute to confirm it). Returns whether it changed. */
    setMode(input) {
      confirmedAt = now();
      const next = {
        blocklist: strings(input && input.blocklist),
        allowOnly: input && Array.isArray(input.allowOnly) ? strings(input.allowOnly) : null,
      };
      if (JSON.stringify(next) === JSON.stringify(mode)) return false;
      mode = next;
      log(`[Blocking] List in force: ${next.blocklist.length} extra blocked, ` +
        (next.allowOnly ? `allow list of ${next.allowOnly.length}` : 'no allow list'));
      sendBlocklist();
      sendSettings();
      return true;
    },

    /** Every minute: renew an allow list the window still stands behind; lift one it stopped confirming. */
    renew() {
      if (!mode.allowOnly && mode.blocklist.length === 0) return;
      if (now() - confirmedAt > MODE_STALE_MS) {
        log('[Blocking] The window stopped confirming the list in force; lifting it');
        state.clearMode();
        return;
      }
      if (mode.allowOnly) sendSettings();
    },

    /** Nothing is in force any more (the app quits, the window is gone). */
    clearMode() {
      if (!mode.allowOnly && mode.blocklist.length === 0) return false;
      mode = NO_MODE;
      sendBlocklist();
      sendSettings();
      return true;
    },

    /** Signed out: nothing that came from the account is blocked or allowed any more. */
    signedOut() {
      always = [];
      mode = NO_MODE;
      settings = { ...DEFAULT_BLOCK_SETTINGS };
      sendBlocklist();
      sendSettings();
    },
  };

  return state;
}

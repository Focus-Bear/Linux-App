// Blocking options the browser extensions need besides the block list.
// Kept free of Electron imports so it can be unit tested.
//
// immediatelyBlock: "Immediately block super distracting sites". When true the
// extensions drop the "Unblock temporarily" option and ignore earlier unblocks.
//
// allowOnly: only present while an allow list is in force (a focus session or
// blocking schedule whose block list is "block everything except ..."). The
// extensions then block every page that is not on it. See blockingModel.js.

export const MAX_ALLOW_ONLY = 500;
// The app renews an allow list every minute; the extensions drop one that is
// older than this, so a crashed app can't leave the whole web blocked.
export const ALLOW_ONLY_RENEW_MS = 60 * 1000;
export const ALLOW_ONLY_LIFETIME_MS = 3 * 60 * 1000;

export const DEFAULT_BLOCK_SETTINGS = Object.freeze({ immediatelyBlock: false });

/** Accepts anything (IPC payload, settings.json) and returns a clean settings object. */
export function normaliseBlockSettings(input) {
  const settings = { immediatelyBlock: Boolean(input && input.immediatelyBlock === true) };
  if (input && Array.isArray(input.allowOnly)) {
    settings.allowOnly = input.allowOnly.filter((entry) => typeof entry === 'string' && entry.trim()).slice(0, MAX_ALLOW_ONLY);
  }
  return settings;
}

/** Newline-delimited JSON message for the native-messaging hosts. */
export function blockSettingsMessage(settings, now = Date.now()) {
  const data = normaliseBlockSettings(settings);
  if (data.allowOnly) data.allowOnlyUntil = now + ALLOW_ONLY_LIFETIME_MS;
  return JSON.stringify({
    type: 'BLOCK_SETTINGS_UPDATE',
    data,
    timestamp: now,
  }) + '\n';
}

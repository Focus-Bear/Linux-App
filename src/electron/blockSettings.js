// Blocking options the browser extensions need besides the block list.
// Kept free of Electron imports so it can be unit tested.
//
// immediatelyBlock: "Immediately block super distracting sites". When true the
// extensions drop the "Unblock temporarily" option and ignore earlier unblocks.

export const DEFAULT_BLOCK_SETTINGS = Object.freeze({ immediatelyBlock: false });

/** Accepts anything (IPC payload, settings.json) and returns a clean settings object. */
export function normaliseBlockSettings(input) {
  return { immediatelyBlock: Boolean(input && input.immediatelyBlock === true) };
}

/** Newline-delimited JSON message for the native-messaging hosts. */
export function blockSettingsMessage(settings, now = Date.now()) {
  return JSON.stringify({
    type: 'BLOCK_SETTINGS_UPDATE',
    data: normaliseBlockSettings(settings),
    timestamp: now,
  }) + '\n';
}

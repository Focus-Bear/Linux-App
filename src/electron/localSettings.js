// The local settings file (~/.config/Focus Bear/settings.json) holds two kinds
// of values: what the setup wizard saved for this computer (setupComplete,
// selectedBrowsers) and a copy of the synced settings (block list, ...).
// Each save sends only one kind, so a save must be merged into the file.
// Replacing the file dropped `setupComplete`, and the setup wizard came back on
// the next launch after any settings change.
//
// No Electron imports, so this can be unit tested.

export const SETTINGS_VERSION = '1.0.0';

/** What to write to settings.json for a save of `incoming` on top of `existing`. */
export function mergeLocalSettings(existing, incoming, now = new Date()) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const next = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {};
  return {
    ...base,
    ...next,
    lastModified: now.toISOString(),
    version: SETTINGS_VERSION,
  };
}

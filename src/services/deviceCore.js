// Registering this install as one of the account's devices, as the Windows and
// Mac apps do at sign-in (Windows: FocusBearAPIClient.PostDeviceID):
//
//   POST /device  { operating_system, metadata }  ->  201 { id, ... }
//
// The id is needed to complete or skip a habit (POST /completed-activity
// answers 404 for a device the account doesn't have) and for the calls that
// take ?device_id=. It is kept in the local settings file, per account, so an
// install registers once.
//
// The server's operating_system list is MacOS, Windows, Android, iOS, Web (no
// Linux yet), so the app registers as 'Web' and says it is Linux in metadata.
//
// No browser or Electron imports: everything is passed in, for node --test.

export const DEVICE_OPERATING_SYSTEM = 'Web';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDeviceId(value) {
  return typeof value === 'string' && UUID.test(value);
}

/** Body of POST /device. */
export function deviceBody(appVersion) {
  const metadata = { platform: 'Linux', app: 'Focus Bear Linux' };
  if (appVersion) metadata.app_version = String(appVersion);
  return { operating_system: DEVICE_OPERATING_SYSTEM, metadata };
}

/** The device id saved for this account in the local settings, or null. */
export function savedDeviceId(settings, userId) {
  const devices = settings && typeof settings.devices === 'object' && settings.devices ? settings.devices : {};
  const id = devices[userId || ''];
  return isDeviceId(id) ? id : null;
}

/** The `devices` value to save after registering `id` for `userId` (other accounts are kept). */
export function withDevice(settings, userId, id) {
  const devices = settings && typeof settings.devices === 'object' && settings.devices ? settings.devices : {};
  return { ...devices, [userId || '']: id };
}

/**
 * Returns the device id for the signed-in account, registering the install
 * first when it has none (or when `force` is set, because the server no longer
 * knows the saved one).
 *
 * request(method, path, body) -> parsed JSON; loadSettings() / saveSettings(patch)
 * read and merge the local settings file.
 */
export async function ensureDevice({ request, loadSettings, saveSettings, userId, appVersion, force = false }) {
  const settings = (await loadSettings().catch(() => null)) || {};
  if (!force) {
    const saved = savedDeviceId(settings, userId);
    if (saved) return saved;
  }
  const created = await request('POST', '/device', deviceBody(appVersion));
  if (!isDeviceId(created?.id)) throw new Error('The server did not return a device id');
  await saveSettings({ devices: withDevice(settings, userId, created.id) }).catch(() => {});
  return created.id;
}

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
// The app registers as 'Linux' (#159). A server that doesn't have that
// operating system yet refuses it, and the app then registers as 'Web' and
// says it is Linux in metadata, as it did before. An install that holds such a
// 'Web' registration asks the server to change it to 'Linux'
// (PATCH /device/{id}), which keeps the same id, and asks again later while
// the server still refuses.
//
// No browser or Electron imports: everything is passed in, for node --test.

export const DEVICE_OPERATING_SYSTEM = 'Linux';
export const FALLBACK_OPERATING_SYSTEM = 'Web';
/** How long to wait before asking a server that refused 'Linux' again. */
export const MIGRATION_RETRY_MS = 6 * 60 * 60 * 1000;

// What a server without 'Linux' answers: 400 from validation, 409 when only the database refuses the value.
const REFUSED = [400, 409, 422];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** When each account last asked for its 'Web' registration to become 'Linux' (this run of the app). */
const migrationAttempts = new Map();

export function isDeviceId(value) {
  return typeof value === 'string' && UUID.test(value);
}

/** Body of POST /device. */
export function deviceBody(appVersion, operatingSystem = DEVICE_OPERATING_SYSTEM) {
  const metadata = { platform: 'Linux', app: 'Focus Bear Linux' };
  if (appVersion) metadata.app_version = String(appVersion);
  return { operating_system: operatingSystem, metadata };
}

function perAccount(settings, key) {
  return settings && typeof settings[key] === 'object' && settings[key] ? settings[key] : {};
}

/** The device id saved for this account in the local settings, or null. */
export function savedDeviceId(settings, userId) {
  const id = perAccount(settings, 'devices')[userId || ''];
  return isDeviceId(id) ? id : null;
}

/** The `devices` value to save after registering `id` for `userId` (other accounts are kept). */
export function withDevice(settings, userId, id) {
  return { ...perAccount(settings, 'devices'), [userId || '']: id };
}

/**
 * What the saved device is registered as. Ids saved before the app could
 * register as 'Linux' have no entry: they are 'Web'.
 */
export function savedDeviceOs(settings, userId) {
  return perAccount(settings, 'deviceOs')[userId || ''] === DEVICE_OPERATING_SYSTEM
    ? DEVICE_OPERATING_SYSTEM
    : FALLBACK_OPERATING_SYSTEM;
}

/** The `deviceOs` value to save for `userId` (other accounts are kept). */
export function withDeviceOs(settings, userId, operatingSystem) {
  return { ...perAccount(settings, 'deviceOs'), [userId || '']: operatingSystem };
}

/** Registers as 'Linux', or as 'Web' when the server doesn't know 'Linux' yet. */
async function register(request, appVersion) {
  let operatingSystem = DEVICE_OPERATING_SYSTEM;
  let created;
  try {
    created = await request('POST', '/device', deviceBody(appVersion));
  } catch (error) {
    if (!REFUSED.includes(error?.status)) throw error;
    operatingSystem = FALLBACK_OPERATING_SYSTEM;
    created = await request('POST', '/device', deviceBody(appVersion, operatingSystem));
  }
  if (!isDeviceId(created?.id)) throw new Error('The server did not return a device id');
  return { id: created.id, operatingSystem };
}

/**
 * Asks the server to turn the saved 'Web' registration into 'Linux'.
 * Returns 'migrated', 'later' (refused or unreachable: keep using the id) or
 * 'gone' (the account no longer has that device).
 */
async function migrate({ request, saveSettings, settings, userId, id, now, attempts }) {
  const last = attempts.get(userId);
  if (last !== undefined && now - last < MIGRATION_RETRY_MS) return 'later';
  attempts.set(userId, now);
  try {
    await request('PATCH', `/device/${id}`, { operating_system: DEVICE_OPERATING_SYSTEM });
  } catch (error) {
    return error?.status === 404 ? 'gone' : 'later';
  }
  attempts.delete(userId);
  await saveSettings({ deviceOs: withDeviceOs(settings, userId, DEVICE_OPERATING_SYSTEM) }).catch(() => {});
  return 'migrated';
}

/**
 * Returns the device id for the signed-in account, registering the install
 * first when it has none (or when `force` is set, because the server no longer
 * knows the saved one). A saved 'Web' registration is moved to 'Linux' on the
 * way, when the server accepts that; if it doesn't, the saved id is used as is.
 *
 * request(method, path, body) -> parsed JSON, or throws an error with `status`;
 * loadSettings() / saveSettings(patch) read and merge the local settings file.
 */
export async function ensureDevice({
  request,
  loadSettings,
  saveSettings,
  userId,
  appVersion,
  force = false,
  now = Date.now(),
  attempts = migrationAttempts,
}) {
  const settings = (await loadSettings().catch(() => null)) || {};
  const saved = force ? null : savedDeviceId(settings, userId);
  if (saved) {
    if (savedDeviceOs(settings, userId) === DEVICE_OPERATING_SYSTEM) return saved;
    const outcome = await migrate({ request, saveSettings, settings, userId, id: saved, now, attempts });
    if (outcome !== 'gone') return saved;
  }
  const { id, operatingSystem } = await register(request, appVersion);
  // The server has just refused 'Linux': no need to ask again straight away.
  if (operatingSystem === DEVICE_OPERATING_SYSTEM) attempts.delete(userId);
  else attempts.set(userId, now);
  await saveSettings({
    devices: withDevice(settings, userId, id),
    deviceOs: withDeviceOs(settings, userId, operatingSystem),
  }).catch(() => {});
  return id;
}

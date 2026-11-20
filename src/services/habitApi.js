// The habit API bound to the signed-in user and this install's device id
// (see habitApiCore.js and deviceCore.js).
import { nativeAuthService } from './nativeAuth.js';
import { createHabitApi } from './habitApiCore.js';
import { ensureDevice } from './deviceCore.js';

let pending = null;

function getDeviceId(request, force) {
  // One registration at a time: two habits ticked quickly must not create two devices.
  if (pending) return pending;
  pending = (async () => {
    const info = await window.api?.getAppInfo?.().catch(() => null);
    return ensureDevice({
      request,
      loadSettings: () => window.api.getLocalSettings(),
      saveSettings: (patch) => window.api.saveSettings(patch),
      userId: nativeAuthService.getUser()?.sub || '',
      appVersion: info?.version,
      force,
    });
  })().finally(() => {
    pending = null;
  });
  return pending;
}

export const habitApi = createHabitApi({
  fetch: (...args) => window.fetch(...args),
  getToken: () => nativeAuthService.getToken(),
  getDeviceId,
});

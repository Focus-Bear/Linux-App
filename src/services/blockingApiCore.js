// Focus Bear API calls for block lists and blocking schedules, the same ones
// the Windows app makes (API/FocusBearAPIClient.cs):
//
//   GET    /user/focus-modes                     the account's block lists
//   POST   /focus-mode                           create one (201)
//   PUT    /focus-mode                           save: an array of every list (200)
//   DELETE /focus-mode?id=                       delete one (204; 404 = already gone)
//   GET    /blocking-schedules
//   POST   /blocking-schedules?device_id=        (201)
//   PUT    /blocking-schedules/{id}?device_id=   (200)
//   DELETE /blocking-schedules/{id}?device_id=   (204)
//
// device_id tells the server which device made the change, so it doesn't send
// that device its own "schedule updated" notification.
//
// `request(method, path, body)` and `getDeviceId()` are passed in, for node --test.
import { allListsBody, newListBody, scheduleBody } from '../electron/blockingModel.js';

export function createBlockingApi({ request, getDeviceId, newId = () => crypto.randomUUID() }) {
  const withDevice = async (path) => {
    const deviceId = await getDeviceId().catch(() => null);
    return deviceId ? `${path}?device_id=${encodeURIComponent(deviceId)}` : path;
  };

  return {
    async getLists() {
      const modes = await request('GET', '/user/focus-modes');
      return Array.isArray(modes) ? modes : [];
    },

    /** Creates a list and returns it as it was sent (the id is made here, as on Windows). */
    async createList(name, kind) {
      const body = newListBody(newId(), name, kind);
      await request('POST', '/focus-mode', body);
      return body;
    },

    /** Saves the lists. The call takes every list of the account, not only the changed one. */
    saveLists(modes) {
      return request('PUT', '/focus-mode', allListsBody(modes));
    },

    async deleteList(id) {
      try {
        await request('DELETE', `/focus-mode?id=${encodeURIComponent(id)}`);
      } catch (error) {
        if (error?.status !== 404) throw error; // already deleted elsewhere
      }
    },

    async getSchedules() {
      const schedules = await request('GET', '/blocking-schedules');
      return Array.isArray(schedules) ? schedules : [];
    },

    /** Creates (no `existing`) or updates a schedule from the form's values; returns what was sent. */
    async saveSchedule(draft, existing = null) {
      if (existing) {
        const body = scheduleBody(draft, existing.id, existing);
        await request('PUT', await withDevice(`/blocking-schedules/${encodeURIComponent(existing.id)}`), body);
        return { ...existing, ...body };
      }
      const body = scheduleBody(draft, newId());
      await request('POST', await withDevice('/blocking-schedules'), body);
      return body;
    },

    async deleteSchedule(id) {
      try {
        await request('DELETE', await withDevice(`/blocking-schedules/${encodeURIComponent(id)}`));
      } catch (error) {
        if (error?.status !== 404) throw error;
      }
    },
  };
}

// Focus Bear API calls for block lists and blocking schedules, the same ones
// the Windows app makes (API/FocusBearAPIClient.cs):
//
//   GET    /user/focus-modes                     the account's block lists
//   POST   /focus-mode                           create one (201)
//   PUT    /focus-mode                           save: an array of lists; the server updates the
//                                                ones in the array and leaves the others alone (200)
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
import { listBody, newListBody, scheduleBody } from '../electron/blockingModel.js';

/** Thrown by updateList when the list is no longer on the account. */
export class ListGoneError extends Error {
  constructor(id) {
    super(`Block list ${id} is no longer on the account`);
    this.name = 'ListGoneError';
    this.status = 404;
  }
}

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

    /**
     * Changes one list on the account. The lists are read again first and
     * `change(list)` is applied to that fresh copy, and only that list is sent:
     * the window's copy can be minutes old, and sending every list from it
     * wrote over edits made on another device (and over lists this app hides).
     * Returns { saved, modes }: the list as sent, and the fresh lists with it in place.
     */
    async updateList(id, change) {
      const fresh = await request('GET', '/user/focus-modes');
      const modes = Array.isArray(fresh) ? fresh : [];
      const current = modes.find((mode) => mode && mode.id === id);
      if (!current) throw new ListGoneError(id);
      const saved = change(current);
      if (saved !== current) await request('PUT', '/focus-mode', [listBody(saved)]);
      return { saved, modes: modes.map((mode) => (mode && mode.id === id ? saved : mode)) };
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

    /**
     * Creates (no `existing`) or updates a schedule from the form's values.
     * Returns the schedule with the id the server gave it: the server does not
     * keep the id sent in a POST, so editing or deleting a new schedule with
     * the id made here answered 404.
     */
    async saveSchedule(draft, existing = null) {
      if (existing) {
        const body = scheduleBody(draft, existing.id, existing);
        await request('PUT', await withDevice(`/blocking-schedules/${encodeURIComponent(existing.id)}`), body);
        return { ...existing, ...body };
      }
      const body = scheduleBody(draft, newId());
      const created = await request('POST', await withDevice('/blocking-schedules'), body);
      const id = created && typeof created === 'object' && typeof created.id === 'string' && created.id ? created.id : null;
      if (id) return { ...body, ...created, id };
      // No id in the answer: find the new schedule in the account's list.
      const all = await request('GET', '/blocking-schedules').catch(() => null);
      const match = (Array.isArray(all) ? all : []).filter(
        (schedule) => schedule && schedule.name === body.name && schedule.start_time === body.start_time && schedule.end_time === body.end_time,
      );
      return match.length > 0 ? { ...body, ...match[match.length - 1] } : body;
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

// Focus Bear API calls for completing and skipping habits, the same ones the
// Windows app makes (API/FocusBearAPIClient.cs, API/ActivityCompletedBody.cs):
//
//   POST /completed-activity        done   (201)
//   POST /completed-activity/skip   skipped (201)
//
// Both need the id of a registered device (see deviceCore.js). When the server
// says it doesn't know the device (404: it was removed from the account), the
// install registers again and the call is sent once more.
//
// `fetch`, `getToken` and `getDeviceId` are passed in, for node --test.

export const API_BASE_URL = 'https://api.focusbear.io';

export class HabitApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HabitApiError';
    this.status = status;
  }
}

/**
 * Body of POST /completed-activity. Times are epoch milliseconds. `alreadyDid`
 * is the skip dialog's "I already did it": a completion flagged with
 * metadata.skipped_did_complete, as the Windows app sends it.
 */
export function completedBody(habit, deviceId, { startMs, finishMs, seconds, alreadyDid = false, answers = [] }) {
  const body = {
    activity_id: habit.id,
    duration_logged: Math.max(0, Math.round(Number(seconds) || 0)),
    device_id: deviceId,
    activity_sequence_id: habit.sequenceId || '',
    start_time: new Date(startMs).toISOString(),
    finish_time: new Date(finishMs).toISOString(),
    metadata: alreadyDid ? { skipped_did_complete: true } : {},
  };
  // Log quantity ("How many pages did you read?"): left out when nothing was answered.
  if (Array.isArray(answers) && answers.length > 0) body.log_quantity_answers = answers;
  return body;
}

/** Body of POST /completed-activity/skip. */
export function skippedBody(habit, deviceId) {
  return { activity_id: habit.id, device_id: deviceId, activity_sequence_id: habit.sequenceId || '' };
}

export function createHabitApi({ fetch, getToken, getDeviceId, baseUrl = API_BASE_URL }) {
  async function request(method, path, body) {
    const token = await getToken();
    if (!token) throw new HabitApiError('Not signed in', 401);
    // No Content-Type without a body: the server answers 400 to a DELETE that
    // announces JSON and sends none.
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new HabitApiError(`${method} ${path} failed: ${response.status}`, response.status);
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /** Sends `build(deviceId)`; a 404 means the device is gone, so register again and retry once. */
  async function withDevice(path, build) {
    const deviceId = await getDeviceId(request, false);
    try {
      return await request('POST', path, build(deviceId));
    } catch (error) {
      if (error.status !== 404) throw error;
      const fresh = await getDeviceId(request, true);
      return request('POST', path, build(fresh));
    }
  }

  return {
    request,

    /** Marks a habit done. `timing` = { startMs, finishMs, seconds }. */
    completeHabit(habit, timing) {
      return withDevice('/completed-activity', (deviceId) => completedBody(habit, deviceId, timing));
    },

    skipHabit(habit) {
      return withDevice('/completed-activity/skip', (deviceId) => skippedBody(habit, deviceId));
    },

    /** Registers the install if it isn't yet (called once after sign-in). */
    registerDevice() {
      return getDeviceId(request, false);
    },
  };
}

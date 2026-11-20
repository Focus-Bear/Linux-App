// Focus Bear API calls for focus sessions, the same ones the Windows app makes
// (API/FocusBearAPIClient.cs), so sessions sync between devices:
//
//   GET   /user/focus-modes                          the account's block lists
//   POST  /focus-mode                                create the default block list
//   POST  /focus-mode/{id}/start                     201
//   PATCH /focus-mode/{id}/update_scheduled_finish   −5 / +5, resume
//   POST  /focus-mode/{id}/finish                    201 (on time or stopped early)
//   GET   /user/weekly-focus-block-summary           find the finished row…
//   PATCH /user/weekly-focus-block-summary/{rowId}   …and attach the reflection
//
// `fetch` and `getToken` are passed in so this file has no browser or Electron
// imports and can be tested with node --test. focusApi.js binds the real ones.
import {
  defaultModeBody,
  findSummaryRow,
  finishBody,
  pickDefaultMode,
  reflectionBody,
  scheduledFinishBody,
  startBody,
} from '../electron/focusSessionModel.js';

export const API_BASE_URL = 'https://api.focusbear.io';

export class FocusApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'FocusApiError';
    this.status = status;
  }
}

export function createFocusApi({ fetch, getToken, baseUrl = API_BASE_URL, newId = () => crypto.randomUUID() }) {
  async function request(method, path, body) {
    const token = await getToken();
    if (!token) throw new FocusApiError('Not signed in', 401);
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new FocusApiError(`${method} ${path} failed: ${response.status}`, response.status);
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  const modePath = (id) => `/focus-mode/${encodeURIComponent(id)}`;

  async function getFocusModes() {
    const modes = await request('GET', '/user/focus-modes');
    return Array.isArray(modes) ? modes : [];
  }

  /** The account's default block list; created when the account has none yet. */
  async function ensureDefaultMode(modes) {
    const existing = pickDefaultMode((modes || []).filter((mode) => mode?.metadata?.isDefault === true));
    if (existing) return existing;
    const body = defaultModeBody(newId());
    await request('POST', '/focus-mode', body);
    return body;
  }

  return {
    getFocusModes,
    ensureDefaultMode,

    startSession(session) {
      return request('POST', `${modePath(session.modeId)}/start`, startBody(session));
    },

    updateScheduledFinish(session) {
      return request('PATCH', `${modePath(session.modeId)}/update_scheduled_finish`, scheduledFinishBody(session));
    },

    finishSession(session, reflection) {
      return request('POST', `${modePath(session.modeId)}/finish`, finishBody(session, reflection));
    },

    /**
     * Saves what the user wrote on the end screen onto the finished session.
     * Returns false when there was nothing to save or the row wasn't found.
     */
    async saveReflection(session, reflection) {
      const body = reflectionBody(reflection);
      if (!body) return false;
      const rows = await request('GET', '/user/weekly-focus-block-summary?limit=5&offset=0');
      const row = findSummaryRow(rows, session.modeId);
      if (!row) return false;
      await request('PATCH', `/user/weekly-focus-block-summary/${encodeURIComponent(row.id)}`, body);
      return true;
    },
  };
}

// Focus Bear API calls behind the TOOLS pages (Notes, Stats, Focus Music) and
// Achievements. See notesModel.js and statsModel.js for where each comes from
// in the Windows app.
//
// `request(method, path, body)` is passed in, for node --test.
import {
  BRAIN_DUMP_FULL,
  BRAIN_DUMP_TITLE,
  MAX_BODY,
  PAGE_SIZE,
  isBrainDump,
  latestBrainDump,
  noteBody,
  pinBody,
  textToHtml,
} from './notesModel.js';
import { leaderboardPath } from './statsModel.js';
import { goalsBody } from './onboardingModel.js';

// Looking for the Brain Dump: the server's largest page, and where to give up (10,000 notes).
const FIND_PAGE_SIZE = 50;
const FIND_MAX_PAGES = 200;

export function createToolsApi({ request }) {
  const list = (result) => (Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : []);
  // The brain dump found last time, so the next look is one request.
  let brainDumpId = null;
  let appending = Promise.resolve();

  /**
   * Looks for the account's Brain Dump: { note, complete }. The server has no
   * filter for it (note.controller.ts: GET /note takes page / take / order
   * only, ordered by created_at) and does not keep one per account, so the
   * list is read page by page until a page holds one or the list ends. An old
   * Brain Dump is far down that list; looking only at the newest notes misses
   * it, and saving then makes a second one. `complete` is true only when the
   * whole list was read and has none: only then may one be created.
   */
  async function findBrainDump() {
    if (brainDumpId) {
      try {
        const known = await request('GET', `/note/${encodeURIComponent(brainDumpId)}`);
        if (isBrainDump(known)) return { note: known, complete: false };
      } catch (error) {
        if (error?.status !== 404) throw error; // deleted on another device: look again
      }
      brainDumpId = null;
    }
    for (let page = 1; page <= FIND_MAX_PAGES; page += 1) {
      const result = await request('GET', `/note?page=${page}&take=${FIND_PAGE_SIZE}&order=DESC`);
      const notes = list(result);
      const found = latestBrainDump(notes);
      if (found) {
        brainDumpId = found.id;
        return { note: found, complete: false };
      }
      // Without the paging details a full page means there may be more.
      const more = result?.meta ? Boolean(result.meta.hasNextPage) : notes.length >= FIND_PAGE_SIZE;
      if (!more || notes.length === 0) return { note: null, complete: true };
    }
    return { note: null, complete: false };
  }

  return {
    // --- notes ---------------------------------------------------------------

    /** One page of notes, newest first: { notes, hasNextPage }. */
    async getNotes(page = 1) {
      const result = await request('GET', `/note?page=${page}&take=${PAGE_SIZE}&order=DESC`);
      return { notes: list(result), hasNextPage: Boolean(result?.meta?.hasNextPage) };
    },

    async getPinnedNotes() {
      return list(await request('GET', '/note?page=1&take=50&order=DESC&pinned=true'));
    },

    async searchNotes(query) {
      return list(await request('GET', `/note/search?query=${encodeURIComponent(String(query).trim())}&take=20`));
    },

    /** Creates or updates; returns the note as the server has it. */
    saveNote(note, fields) {
      return request('PUT', '/note', noteBody(note, fields));
    },

    findBrainDump,

    /**
     * Adds text to the end of the Brain Dump (creating it for an account that
     * has none), as the focus session's brain dump box does on Windows. Throws
     * when the note would go over the server's limit (error.code 'NOTE_FULL',
     * with a message that can be shown), so no text is dropped quietly.
     */
    appendBrainDump(text) {
      const addition = String(text ?? '').trim();
      if (!addition) return Promise.resolve(null);
      // One at a time: the second thought is added to the note the first one left.
      const run = appending.then(async () => {
        const { note: existing, complete } = await findBrainDump();
        // Not found, but the list could not be read to its end: making one now could make a second one.
        if (!existing && !complete) throw new Error('The notes could not all be read, so no Brain Dump was created.');
        const body = `${existing?.body || ''}${textToHtml(addition)}`;
        if (body.length > MAX_BODY) throw Object.assign(new Error(BRAIN_DUMP_FULL), { code: 'NOTE_FULL' });
        const note = existing || { is_brain_dump: true };
        const saved = await request('PUT', '/note', noteBody(note, { title: existing?.title || BRAIN_DUMP_TITLE, body }));
        if (saved?.id) brainDumpId = saved.id;
        return saved;
      });
      appending = run.catch(() => {});
      return run;
    },

    setNotePinned(note, pinned) {
      return request('PUT', '/note', pinBody(note, pinned));
    },

    async deleteNote(id) {
      try {
        await request('DELETE', `/note?note_id=${encodeURIComponent(id)}`);
      } catch (error) {
        if (error?.status !== 404) throw error; // already deleted elsewhere
      }
    },

    // --- stats ---------------------------------------------------------------

    getDetails() {
      return request('GET', '/user/details');
    },

    getLevelStats() {
      return request('GET', '/user/stats/onboarding');
    },

    getLeaderboard(sortId) {
      return request('GET', leaderboardPath(sortId));
    },

    setUsername(username) {
      return request('PUT', '/user/username', { username: String(username).trim() });
    },

    async getGoals() {
      const goals = await request('GET', '/user/long-term-goals');
      const items = Array.isArray(goals) ? goals : Array.isArray(goals?.goals) ? goals.goals : [];
      return items.map((goal) => (typeof goal === 'string' ? goal : goal?.goal || goal?.text || '')).filter(Boolean);
    },

    saveGoals(goals) {
      return request('PATCH', '/user/long-term-goals', goalsBody(goals));
    },

    async getFocusLog(limit = 30, offset = 0) {
      const rows = await request('GET', `/user/weekly-focus-block-summary?limit=${limit}&offset=${offset}`);
      return Array.isArray(rows) ? rows : [];
    },

    // --- focus music ---------------------------------------------------------

    async getTracks() {
      const tracks = await request('GET', '/tracks');
      return Array.isArray(tracks) ? tracks : [];
    },
  };
}

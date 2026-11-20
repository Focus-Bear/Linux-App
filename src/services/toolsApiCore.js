// Focus Bear API calls behind the TOOLS pages (Notes, Stats, Focus Music) and
// Achievements. See notesModel.js and statsModel.js for where each comes from
// in the Windows app.
//
// `request(method, path, body)` is passed in, for node --test.
import { PAGE_SIZE, noteBody, pinBody } from './notesModel.js';
import { leaderboardPath } from './statsModel.js';
import { goalsBody } from './onboardingModel.js';

export function createToolsApi({ request }) {
  const list = (result) => (Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : []);

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

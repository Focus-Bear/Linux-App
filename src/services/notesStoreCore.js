// The Notes page's state: the list, the search results, the note in the editor
// and its saves. The store itself (no React, no fetch, no DOM: the API, the
// timers and the HTML check are passed in), so the order of saves, opens and
// deletes can be tested with a fake API that answers late or out of order
// (notesStoreCore.test.js). notes.jsx only draws what `get()` returns.
//
// The rules:
//   - One copy of each note (`known`, by id). The list and the search results
//     are lists of ids into it, so a save shows in both and a note is always
//     opened from the latest copy. A copy from the server never replaces a
//     newer one already here.
//   - Each open note has its own text (`editor`) and its own queue of saves:
//     one request at a time, the next one sends the newest text and waits for
//     the one before it. A new note therefore has its real id before it is
//     saved a second time, and two saves can't land in the wrong order.
//   - Opening the note that is already open does nothing.
//   - A note with formatting this editor would flatten opens read-only.
//   - The Brain Dump row for "this account has none yet" is only offered once
//     the whole list was searched for one.
import {
  BRAIN_DUMP_PLACEHOLDER_ID,
  BRAIN_DUMP_TITLE,
  DRAFT_PREFIX,
  arrangeNotes,
  isBrainDump,
  isLocalNoteId,
  isPinned,
  noteError,
  plainText,
  updatedTime,
} from './notesModel.js';

export const SAVE_FAILED = "Couldn't save this note. Check your connection; it will be tried again when you type.";
export const LOAD_MORE_FAILED = "Couldn't load more notes. Check your connection and try again.";
export const PIN_FAILED = "Couldn't change the pin. Check your connection and try again.";
export const PIN_EMPTY = "Write something first: an empty note can't be pinned.";
export const DELETE_FAILED = "Couldn't delete that note. Check your connection and try again.";
export const READ_ONLY_NOTICE = "This note has formatting Focus Bear on Linux can't edit yet. Open it in the web app to change it.";
export const UNTITLED = 'Untitled note';

const PLACEHOLDER = { id: BRAIN_DUMP_PLACEHOLDER_ID, title: BRAIN_DUMP_TITLE, body: '', is_brain_dump: true, tags: [] };

export function createNotesStore({
  api,
  // (html) => { html, lost }: the body as it may be shown and saved, and the formatting that had to go (sanitizeHtml.js).
  inspect = (html) => ({ html: String(html ?? ''), lost: [] }),
  saveDelayMs = 1200, // after the last key
  maxWaitMs = 10000, // while typing without a pause
  searchDelayMs = 300,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  now = () => Date.now(),
  log = console,
}) {
  let state = {
    status: 'loading', // loading | ready | error
    shown: [], // the rows of the list (or of the search), in order
    searching: false, // `shown` is a search result
    hasMore: false,
    query: '',
    selectedId: null,
    note: null, // the saved copy of the open note
    title: '',
    body: '', // the open note's text when it was opened (the editor is filled from it when `opened` changes)
    opened: 0, // goes up each time a note is put into the editor
    readOnly: false,
    saveState: 'idle', // idle | dirty | saving | saved | error
    message: null,
  };
  const listeners = new Set();

  const known = new Map(); // id -> note: the one copy of each note
  let listIds = [];
  let resultIds = null; // ids of the search results, or null when not searching
  // found: the list has a brain dump. none: the whole list was read and has none. unknown: not known (yet).
  let brainDump = 'unknown';
  let page = 1;
  const editors = new Map(); // id -> the text and save queue of a note that is open, unsaved or being saved
  let current = null;
  let saveTimer = null;
  let maxTimer = null;
  let searchTimer = null;
  let searchRun = 0;
  let loadRun = 0;
  let draftCount = 0;

  function publish(patch = {}) {
    const rows = (resultIds || listIds).map((id) => known.get(id)).filter(Boolean);
    state = {
      ...state,
      ...patch,
      shown: arrangeNotes(rows, { withBrainDump: !resultIds && brainDump === 'none' }),
      searching: Boolean(resultIds),
      note: current ? current.note : null,
      selectedId: current ? current.note.id : null,
    };
    listeners.forEach((listener) => listener());
  }

  /** Takes a note from the server into `known`, unless the copy here is newer. Returns its id. */
  function absorb(note) {
    if (!note || !note.id) return null;
    const have = known.get(note.id);
    if (!have || updatedTime(note) >= updatedTime(have)) known.set(note.id, have ? { ...have, ...note } : note);
    return note.id;
  }

  const unique = (ids) => [...new Set(ids.filter(Boolean))];
  const lookup = (id) => known.get(id) || (id === BRAIN_DUMP_PLACEHOLDER_ID && brainDump === 'none' ? PLACEHOLDER : null);
  const isBusy = (editor) => editor.saving || editor.queued;

  function makeEditor(note) {
    return {
      note,
      title: note.title || '',
      body: note.body || '',
      dirty: false,
      queued: false, // a save is waiting behind the one in flight
      saving: false,
      removed: false,
      tail: Promise.resolve(null), // the last save asked for; never rejects
      readOnly: inspect(note.body || '').lost.length > 0,
    };
  }

  function forget(id) {
    known.delete(id);
    editors.delete(id);
    listIds = listIds.filter((item) => item !== id);
    if (resultIds) resultIds = resultIds.filter((item) => item !== id);
  }

  /** An editor nobody is looking at and with nothing left to send is let go; a new note that was never written in goes with its row. */
  function settle(editor) {
    if (editor === current || editor.dirty || isBusy(editor)) return;
    const id = editor.note.id;
    if (editors.get(id) === editor) editors.delete(id);
    if (isLocalNoteId(id) && id !== BRAIN_DUMP_PLACEHOLDER_ID && !editor.removed) {
      forget(id);
      publish();
    }
  }

  function stopTimers() {
    if (saveTimer) clearTimer(saveTimer);
    if (maxTimer) clearTimer(maxTimer);
    saveTimer = null;
    maxTimer = null;
  }

  /** One request. Only ever called from the editor's queue, so there is one at a time per note. */
  async function saveOnce(editor) {
    if (editor.removed || !editor.dirty) return editor.removed || isLocalNoteId(editor.note.id) ? null : editor.note;
    // What is saved is what would be shown when the note is opened again.
    const body = inspect(editor.body).html;
    const fresh = isLocalNoteId(editor.note.id);
    const text = plainText(body);
    // A note without a title is named after its first words, as on Windows.
    const title =
      editor.title.trim() ||
      (isBrainDump(editor.note) ? BRAIN_DUMP_TITLE : text.slice(0, 60).trim()) ||
      // No words at all: a saved note that was emptied is still saved (the server wants a title);
      // a new note with only a picture too. A new note with nothing in it is not.
      (!fresh || /<img\b/i.test(body) ? UNTITLED : '');
    if (!title) {
      editor.dirty = false;
      if (editor === current) publish({ saveState: 'idle' });
      return null;
    }
    const problem = noteError(title, body);
    if (problem) {
      if (editor === current) publish({ saveState: 'error', message: problem });
      return null;
    }
    editor.dirty = false;
    editor.saving = true;
    if (editor === current) publish({ saveState: 'saving' });
    try {
      const saved = await api.saveNote(editor.note, { title, body });
      const merged = { ...editor.note, ...(saved || {}), title, body };
      if (isLocalNoteId(merged.id)) throw new Error('The server did not return the new note.');
      const oldId = editor.note.id;
      editor.note = merged;
      if (!editor.title.trim()) editor.title = title;
      if (editor.removed) return merged; // deleted meanwhile: remove() deletes it by this id
      // The row of a new note becomes the note the server made of it.
      if (oldId !== merged.id) {
        known.delete(oldId);
        editors.delete(oldId);
        editors.set(merged.id, editor);
        listIds = listIds.map((id) => (id === oldId ? merged.id : id));
        if (resultIds) resultIds = resultIds.map((id) => (id === oldId ? merged.id : id));
      }
      known.set(merged.id, merged);
      if (!listIds.includes(merged.id)) listIds = [merged.id, ...listIds];
      listIds = unique(listIds);
      if (isBrainDump(merged)) brainDump = 'found';
      if (editor === current) publish({ title: editor.title, saveState: editor.dirty ? 'dirty' : 'saved', message: null });
      else publish();
      return merged;
    } catch (error) {
      log.error('[Notes] Could not save the note:', error?.message || error);
      editor.dirty = true; // the text stays here and goes with the next save
      if (editor === current) publish({ saveState: 'error', message: SAVE_FAILED });
      else publish({ message: `Couldn't save "${title}". Check your connection, then open it again.` });
      return null;
    } finally {
      editor.saving = false;
    }
  }

  /** Sends the note's text if it changed. Resolves with the saved note (or null) once every save asked for so far is done. */
  function flush(editor = current) {
    if (!editor) return Promise.resolve(null);
    if (editor === current) stopTimers();
    if (editor.dirty && !editor.queued && !editor.removed) {
      editor.queued = true;
      editor.tail = editor.tail.then(async () => {
        editor.queued = false;
        const saved = await saveOnce(editor);
        settle(editor);
        return saved;
      });
    }
    return editor.tail;
  }

  function touch() {
    publish({ saveState: 'dirty' });
    if (saveTimer) clearTimer(saveTimer);
    saveTimer = setTimer(() => flush(), saveDelayMs);
    // Typing without a pause is still saved every so often.
    if (!maxTimer) maxTimer = setTimer(() => flush(), maxWaitMs);
  }

  /** The editor is about to show something else. */
  function leave() {
    const editor = current;
    if (!editor) return;
    stopTimers();
    current = null;
    if (editor.dirty) flush(editor);
    else settle(editor);
  }

  function show(editor) {
    current = editor;
    editors.set(editor.note.id, editor);
    publish({
      title: editor.title,
      body: editor.body,
      opened: state.opened + 1,
      readOnly: editor.readOnly,
      saveState: editor.dirty ? 'dirty' : 'idle',
      message: null,
    });
    // Text a failed save left behind is tried again.
    if (editor.dirty && !editor.readOnly) touch();
  }

  async function findBrainDump(run) {
    try {
      const { note, complete } = await api.findBrainDump();
      if (run !== loadRun || brainDump === 'found') return;
      if (note) {
        absorb(note);
        listIds = unique([...listIds, note.id]);
        brainDump = 'found';
      } else {
        brainDump = complete ? 'none' : 'unknown';
      }
      publish();
    } catch (error) {
      // No Brain Dump row this time: offering an empty one could create a second Brain Dump.
      log.error('[Notes] Could not look for the Brain Dump:', error?.message || error);
    }
  }

  const store = {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async load() {
      loadRun += 1;
      const run = loadRun;
      try {
        const [first, pinned] = await Promise.all([api.getNotes(1), api.getPinnedNotes().catch(() => [])]);
        if (run !== loadRun) return;
        const drafts = listIds.filter((id) => isLocalNoteId(id) && known.has(id));
        listIds = unique([...drafts, ...[...pinned, ...first.notes].map(absorb)]);
        page = 1;
        const listed = listIds.some((id) => isBrainDump(known.get(id)));
        if (listed) brainDump = 'found';
        publish({ status: 'ready', hasMore: first.hasNextPage });
        // The Brain Dump can be older than everything on the first page: look for it before offering a new one.
        if (!listed) await findBrainDump(run);
      } catch (error) {
        if (run !== loadRun) return;
        log.error('[Notes] Could not load the notes:', error?.message || error);
        publish({ status: 'error' });
      }
    },

    async loadMore() {
      try {
        const next = await api.getNotes(page + 1);
        page += 1;
        listIds = unique([...listIds, ...next.notes.map(absorb)]);
        if (next.notes.some(isBrainDump)) brainDump = 'found';
        publish({ hasMore: next.hasNextPage });
      } catch (error) {
        log.error('[Notes] Could not load more notes:', error?.message || error);
        publish({ message: LOAD_MORE_FAILED });
      }
    },

    /** Search as you type, a moment after the last key. An empty query goes back to the list. */
    setQuery(text) {
      const query = String(text ?? '');
      if (searchTimer) clearTimer(searchTimer);
      searchTimer = null;
      searchRun += 1;
      const run = searchRun;
      const wanted = query.trim();
      if (!wanted) {
        resultIds = null;
        publish({ query });
        return;
      }
      publish({ query });
      searchTimer = setTimer(async () => {
        searchTimer = null;
        let found = [];
        try {
          found = await api.searchNotes(wanted);
        } catch (error) {
          log.error('[Notes] Search failed:', error?.message || error);
        }
        if (run !== searchRun) return;
        resultIds = unique(found.map(absorb));
        publish();
      }, searchDelayMs);
    },

    /** Puts the note with this id into the editor. The note that is already there stays as it is. */
    open(id) {
      if (current && current.note.id === id) return;
      const note = lookup(id);
      const editor = editors.get(id) || (note ? makeEditor(note) : null);
      if (!editor) return;
      leave();
      show(editor);
    },

    newNote() {
      leave(); // an unused new note goes away here
      draftCount += 1;
      const draft = { id: `${DRAFT_PREFIX}${now()}-${draftCount}`, title: '', body: '', tags: [] };
      known.set(draft.id, draft);
      listIds = [draft.id, ...listIds];
      store.setQuery('');
      show(makeEditor(draft));
    },

    /** What was typed: the title, the editor's HTML, or both. Called on every key, so the store always has the latest text. */
    edit({ title, body } = {}) {
      const editor = current;
      if (!editor || editor.readOnly) return;
      let changed = false;
      if (title !== undefined && title !== editor.title) {
        editor.title = String(title);
        changed = true;
      }
      if (body !== undefined && body !== editor.body) {
        editor.body = String(body);
        changed = true;
      }
      if (title !== undefined) state = { ...state, title: editor.title };
      if (!changed) return;
      editor.dirty = true;
      touch();
    },

    flush: () => flush(),

    async togglePin() {
      const editor = current;
      if (!editor) return;
      await flush(editor);
      const note = editor.note;
      if (isLocalNoteId(note.id)) {
        if (editor === current) publish({ message: PIN_EMPTY });
        return;
      }
      const pinned = !isPinned(note);
      try {
        const saved = await api.setNotePinned(note, pinned);
        editor.note = { ...editor.note, pinned_at: saved?.pinned_at ?? (pinned ? new Date(now()).toISOString() : null) };
        if (!editor.removed) known.set(editor.note.id, editor.note);
        publish();
      } catch (error) {
        log.error('[Notes] Could not pin the note:', error?.message || error);
        publish({ message: PIN_FAILED });
      }
    },

    /** Deletes the open note. A new note whose first save is still on its way is deleted once it has its id. */
    async remove() {
      const editor = current;
      if (!editor || isBrainDump(editor.note)) return;
      stopTimers();
      editor.removed = true;
      editor.dirty = false;
      current = null;
      forget(editor.note.id);
      publish({ message: null });
      await editor.tail;
      const id = editor.note.id;
      forget(id);
      if (isLocalNoteId(id)) return; // never reached the server
      try {
        await api.deleteNote(id);
      } catch (error) {
        log.error('[Notes] Could not delete the note:', error?.message || error);
        // Still on the account: back into the list it goes.
        known.set(id, editor.note);
        listIds = unique([id, ...listIds]);
        publish({ message: DELETE_FAILED });
      }
    },

    /** The page is going away: send what is unsaved and stop the timers. */
    close() {
      const done = flush();
      stopTimers();
      if (searchTimer) clearTimer(searchTimer);
      searchTimer = null;
      return done;
    },
  };

  return store;
}

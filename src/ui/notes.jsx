import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './styles/distracting-sites.css'; // shared .fb-input
import './styles/tools.css';
import { toolsApi } from '../services/toolsApi.js';
import { sanitizeHtml } from './sanitizeHtml.js';
import {
  BRAIN_DUMP_TITLE,
  DRAFT_PREFIX,
  MAX_TITLE,
  arrangeNotes,
  isBrainDump,
  isLocalNoteId,
  isPinned,
  noteDate,
  noteError,
  plainText,
  preview,
} from '../services/notesModel.js';

const FORMATS = [
  { command: 'bold', label: 'B', title: 'Bold', style: { fontWeight: 700 } },
  { command: 'italic', label: 'I', title: 'Italic', style: { fontStyle: 'italic' } },
  { command: 'underline', label: 'U', title: 'Underline', style: { textDecoration: 'underline' } },
  { command: 'insertUnorderedList', label: '• List', title: 'Bulleted list' },
  { command: 'insertOrderedList', label: '1. List', title: 'Numbered list' },
];

/**
 * TOOLS > Notes. The account's notes with the Brain Dump on top, like the
 * Windows Notes window (BrainDump/BrainDumpWindow.xaml): search, new note, pin,
 * delete, and an editor that saves as you type. Notes are stored as HTML, so
 * formatting made on another device is kept.
 */
export default function NotesPage() {
  const [notes, setNotes] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null); // search results, or null
  const [selectedId, setSelectedId] = useState(null);
  const [title, setTitle] = useState('');
  const [saveState, setSaveState] = useState('idle'); // idle | dirty | saving | saved | error
  const [message, setMessage] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [opened, setOpened] = useState(0); // goes up each time a note is put into the editor
  const editorRef = useRef(null);
  const saveTimer = useRef(null);
  // The note in the editor and whether it has unsaved edits, readable from timers.
  const current = useRef({ note: null, dirty: false, title: '' });

  const load = useCallback(async () => {
    try {
      const [first, pinned] = await Promise.all([toolsApi.getNotes(1), toolsApi.getPinnedNotes().catch(() => [])]);
      setNotes([...pinned, ...first.notes]);
      setHasMore(first.hasNextPage);
      setPage(1);
      setStatus('ready');
    } catch (error) {
      console.error('[Notes] Could not load the notes:', error);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadMore = async () => {
    try {
      const next = await toolsApi.getNotes(page + 1);
      setNotes((prev) => [...prev, ...next.notes]);
      setHasMore(next.hasNextPage);
      setPage(page + 1);
    } catch (error) {
      console.error('[Notes] Could not load more notes:', error);
      setMessage("Couldn't load more notes. Check your connection and try again.");
    }
  };

  // Search as you type, a moment after the last key.
  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setResults(null);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const found = await toolsApi.searchNotes(text);
        if (!cancelled) setResults(found);
      } catch (error) {
        console.error('[Notes] Search failed:', error);
        if (!cancelled) setResults([]);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const shown = useMemo(
    () => (results ? arrangeNotes(results, { withBrainDump: false }) : arrangeNotes(notes)),
    [notes, results],
  );

  /** Sends the editor's content if it changed. Returns the saved note (or null). */
  const flush = useCallback(async () => {
    clearTimeout(saveTimer.current);
    const { note, dirty } = current.current;
    if (!note || !dirty) return null;
    const body = editorRef.current ? editorRef.current.innerHTML : note.body || '';
    // A note without a title is named after its first words, as on Windows.
    const noteTitle =
      current.current.title.trim() || (isBrainDump(note) ? BRAIN_DUMP_TITLE : plainText(body).slice(0, 60).trim());
    if (!noteTitle) {
      // nothing written yet
      current.current.dirty = false;
      setSaveState('idle');
      return null;
    }
    const problem = noteError(noteTitle, body);
    if (problem) {
      setSaveState('error');
      setMessage(problem);
      return null;
    }
    current.current.dirty = false;
    setSaveState('saving');
    try {
      const saved = await toolsApi.saveNote(note, { title: noteTitle, body });
      const merged = { ...note, ...(saved || {}), title: noteTitle, body };
      setNotes((prev) => {
        // A draft row is replaced by the note the server made of it.
        const without = prev.filter((item) => item.id !== note.id && item.id !== merged.id);
        return [merged, ...without];
      });
      if (current.current.note?.id === note.id) {
        current.current.note = merged;
        if (!current.current.title.trim()) {
          current.current.title = noteTitle;
          setTitle(noteTitle);
        }
        setSelectedId(merged.id);
      }
      setSaveState(current.current.dirty ? 'dirty' : 'saved');
      setMessage(null);
      return merged;
    } catch (error) {
      console.error('[Notes] Could not save the note:', error);
      current.current.dirty = true;
      setSaveState('error');
      setMessage("Couldn't save this note. Check your connection; it will be tried again when you type.");
      return null;
    }
  }, []);

  const touch = () => {
    current.current.dirty = true;
    setSaveState('dirty');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 1200);
  };

  // Save what is open when the page is left.
  useEffect(() => () => {
    flush();
  }, [flush]);

  const open = async (note) => {
    await flush();
    current.current = { note, dirty: false, title: note.title || '' };
    setSelectedId(note.id);
    setTitle(note.title || '');
    setSaveState('idle');
    setMessage(null);
    setConfirmDelete(false);
    setOpened((count) => count + 1);
  };

  // Put the note's text into the editor when a note is opened (not after each
  // save: that would move the cursor).
  useEffect(() => {
    if (editorRef.current && current.current.note) {
      editorRef.current.innerHTML = sanitizeHtml(current.current.note.body || '');
    }
  }, [opened]);

  const newNote = async () => {
    await flush();
    const draft = { id: `${DRAFT_PREFIX}${Date.now()}`, title: '', body: '', tags: [] };
    setQuery('');
    setNotes((prev) => [draft, ...prev]);
    current.current = { note: draft, dirty: false, title: '' };
    setSelectedId(draft.id);
    setTitle('');
    setSaveState('idle');
    setMessage(null);
    setConfirmDelete(false);
    setOpened((count) => count + 1);
  };

  const togglePin = async () => {
    const note = (await flush()) || current.current.note;
    if (!note?.id || isLocalNoteId(note.id)) {
      setMessage('Write something first: an empty note can\'t be pinned.');
      return;
    }
    const pinned = !isPinned(note);
    try {
      const saved = await toolsApi.setNotePinned(note, pinned);
      const merged = { ...note, pinned_at: saved?.pinned_at ?? (pinned ? new Date().toISOString() : null) };
      current.current.note = merged;
      setNotes((prev) => prev.map((item) => (item.id === note.id ? merged : item)));
    } catch (error) {
      console.error('[Notes] Could not pin the note:', error);
      setMessage("Couldn't change the pin. Check your connection and try again.");
    }
  };

  const remove = async () => {
    const note = current.current.note;
    clearTimeout(saveTimer.current);
    current.current = { note: null, dirty: false, title: '' };
    const id = note?.id;
    setSelectedId(null);
    setConfirmDelete(false);
    setNotes((prev) => prev.filter((item) => item.id !== id));
    setResults((prev) => (prev ? prev.filter((item) => item.id !== id) : prev));
    if (!id || isLocalNoteId(id)) return;
    try {
      await toolsApi.deleteNote(id);
    } catch (error) {
      console.error('[Notes] Could not delete the note:', error);
      setMessage("Couldn't delete that note. Check your connection and try again.");
      load();
    }
  };

  const format = (command) => {
    editorRef.current?.focus();
    document.execCommand(command, false);
    touch();
  };

  const editing = current.current.note && selectedId !== null;
  const brainDump = editing && isBrainDump(current.current.note);
  const saveText = { dirty: 'Not saved yet', saving: 'Saving…', saved: 'Saved', error: 'Not saved' }[saveState] || '';

  return (
    <div className="fb-page fb-notes">
      <h1 className="fb-page__title">Notes</h1>
      <p className="fb-page__subtitle">Your notes and your Brain Dump, saved to your account.</p>

      {status === 'loading' && <p className="fb-tools__note" role="status">Loading your notes…</p>}
      {status === 'error' && (
        <section className="fb-card" role="alert">
          <h2 className="fb-card__title">Your notes couldn&apos;t be loaded</h2>
          <p className="fb-card__desc">Check your internet connection, then try again.</p>
          <button type="button" className="fb-btn fb-btn--primary" onClick={load}>Try again</button>
        </section>
      )}

      {status === 'ready' && (
        <div className="fb-notes__columns">
          <aside className="fb-card fb-notes__list" aria-label="Notes">
            <div className="fb-notes__list-head">
              <input
                className="fb-input"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search notes"
                aria-label="Search notes"
              />
              <button type="button" className="fb-btn fb-btn--primary" onClick={newNote}>+ New note</button>
            </div>
            {results && shown.length === 0 && <p className="fb-tools__note">No notes match &quot;{query.trim()}&quot;.</p>}
            <ul className="fb-notes__rows">
              {shown.map((note) => (
                <li key={note.id}>
                  <button
                    type="button"
                    className="fb-notes__row"
                    aria-current={note.id === selectedId ? 'true' : undefined}
                    onClick={() => open(note)}
                  >
                    <span className="fb-notes__row-title">
                      {isBrainDump(note) && <span aria-hidden="true">🧠 </span>}
                      {!isBrainDump(note) && isPinned(note) && <span aria-hidden="true">📌 </span>}
                      {note.title || 'New note'}
                    </span>
                    <span className="fb-notes__row-preview">
                      {preview(note) || (isBrainDump(note) ? 'Get distracting thoughts out of your head.' : 'Empty note')}
                    </span>
                    {noteDate(note) && <span className="fb-notes__row-date">{noteDate(note)}</span>}
                  </button>
                </li>
              ))}
            </ul>
            {!results && hasMore && (
              <button type="button" className="fb-btn fb-btn--gray fb-btn--block" onClick={loadMore}>Show more notes</button>
            )}
          </aside>

          <section className="fb-card fb-notes__editor" aria-label="Note">
            {!editing && (
              <p className="fb-tools__note">Pick a note on the left, or start a new one.</p>
            )}
            {editing && (
              <>
                <div className="fb-notes__editor-head">
                  <input
                    className="fb-input fb-notes__title"
                    value={title}
                    onChange={(e) => {
                      setTitle(e.target.value);
                      current.current.title = e.target.value;
                      touch();
                    }}
                    placeholder="Title"
                    aria-label="Note title"
                    maxLength={MAX_TITLE}
                    disabled={brainDump}
                  />
                  <span className="fb-notes__saved" role="status">{saveText}</span>
                </div>
                <div className="fb-notes__toolbar" role="toolbar" aria-label="Formatting">
                  {FORMATS.map((item) => (
                    <button
                      key={item.command}
                      type="button"
                      className="fb-btn fb-btn--gray fb-btn--small"
                      title={item.title}
                      aria-label={item.title}
                      style={item.style}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => format(item.command)}
                    >
                      {item.label}
                    </button>
                  ))}
                  <span className="fb-tools__spacer" />
                  {!brainDump && (
                    <>
                      <button type="button" className="fb-btn fb-btn--small" onClick={togglePin}>
                        {isPinned(current.current.note) ? 'Unpin' : 'Pin'}
                      </button>
                      {!confirmDelete && (
                        <button type="button" className="fb-btn fb-btn--gray fb-btn--small" onClick={() => setConfirmDelete(true)}>
                          Delete
                        </button>
                      )}
                      {confirmDelete && (
                        <>
                          <button type="button" className="fb-btn fb-btn--danger fb-btn--small" onClick={remove}>Delete this note</button>
                          <button type="button" className="fb-btn fb-btn--gray fb-btn--small" onClick={() => setConfirmDelete(false)}>Keep</button>
                        </>
                      )}
                    </>
                  )}
                </div>
                <div
                  ref={editorRef}
                  className="fb-notes__body"
                  contentEditable
                  suppressContentEditableWarning
                  role="textbox"
                  aria-multiline="true"
                  aria-label="Note text"
                  data-placeholder={brainDump ? 'Type whatever is on your mind…' : 'Write your note…'}
                  onInput={touch}
                  onBlur={flush}
                />
                {message && <p className="fb-tools__error" role="alert">{message}</p>}
              </>
            )}
            {!editing && message && <p className="fb-tools__error" role="alert">{message}</p>}
          </section>
        </div>
      )}
    </div>
  );
}

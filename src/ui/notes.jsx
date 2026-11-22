import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import './styles/distracting-sites.css'; // shared .fb-input
import './styles/tools.css';
import { toolsApi } from '../services/toolsApi.js';
import { READ_ONLY_NOTICE, createNotesStore } from '../services/notesStoreCore.js';
import { inspectHtml, sanitizeHtml } from './sanitizeHtml.js';
import { MAX_TITLE, isBrainDump, isPinned, noteDate, preview } from '../services/notesModel.js';

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
 * formatting made on another device is kept; a note with formatting this
 * editor can't keep opens read-only.
 *
 * This is only the view: which note is open, what was typed and when it is
 * saved are the store's business (services/notesStoreCore.js).
 */
export default function NotesPage() {
  const [store] = useState(() => createNotesStore({ api: toolsApi, inspect: inspectHtml }));
  const state = useSyncExternalStore(store.subscribe, store.get);
  const { status, shown, searching, hasMore, query, selectedId, note, title, readOnly, saveState, message, opened } = state;
  // The "Delete this note" question belongs to the note it was asked about.
  const [confirmFor, setConfirmFor] = useState(null);
  const confirmDelete = confirmFor === opened;
  const editorRef = useRef(null);

  // Load on arrival; save what is open when the page (or the window) goes away.
  useEffect(() => {
    store.load();
    const onUnload = () => store.close();
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      store.close();
    };
  }, [store]);

  // Put the note's text into the editor when a note is opened (not after each
  // save: that would move the cursor).
  useEffect(() => {
    if (editorRef.current && opened > 0) editorRef.current.innerHTML = sanitizeHtml(store.get().body);
  }, [opened, store]);

  // Every key hands the store the editor's HTML, so a save never depends on
  // this element still being on the page.
  const typed = () => {
    if (editorRef.current) store.edit({ body: editorRef.current.innerHTML });
  };

  const format = (command) => {
    editorRef.current?.focus();
    document.execCommand(command, false);
    typed();
  };

  const editing = Boolean(note);
  const brainDump = editing && isBrainDump(note);
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
          <button type="button" className="fb-btn fb-btn--primary" onClick={() => store.load()}>Try again</button>
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
                onChange={(e) => store.setQuery(e.target.value)}
                placeholder="Search notes"
                aria-label="Search notes"
              />
              <button type="button" className="fb-btn fb-btn--primary" onClick={() => store.newNote()}>+ New note</button>
            </div>
            {searching && shown.length === 0 && <p className="fb-tools__note">No notes match &quot;{query.trim()}&quot;.</p>}
            <ul className="fb-notes__rows">
              {shown.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className="fb-notes__row"
                    aria-current={row.id === selectedId ? 'true' : undefined}
                    onClick={() => store.open(row.id)}
                  >
                    <span className="fb-notes__row-title">
                      {isBrainDump(row) && <span aria-hidden="true">🧠 </span>}
                      {!isBrainDump(row) && isPinned(row) && <span aria-hidden="true">📌 </span>}
                      {row.title || 'New note'}
                    </span>
                    <span className="fb-notes__row-preview">
                      {preview(row) || (isBrainDump(row) ? 'Get distracting thoughts out of your head.' : 'Empty note')}
                    </span>
                    {noteDate(row) && <span className="fb-notes__row-date">{noteDate(row)}</span>}
                  </button>
                </li>
              ))}
            </ul>
            {!searching && hasMore && (
              <button type="button" className="fb-btn fb-btn--gray fb-btn--block" onClick={() => store.loadMore()}>Show more notes</button>
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
                    onChange={(e) => store.edit({ title: e.target.value })}
                    onBlur={() => store.flush()}
                    placeholder="Title"
                    aria-label="Note title"
                    maxLength={MAX_TITLE}
                    disabled={brainDump || readOnly}
                  />
                  <span className="fb-notes__saved" role="status">{saveText}</span>
                </div>
                <div className="fb-notes__toolbar" role="toolbar" aria-label="Formatting">
                  {!readOnly && FORMATS.map((item) => (
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
                      <button type="button" className="fb-btn fb-btn--small" onClick={() => store.togglePin()}>
                        {isPinned(note) ? 'Unpin' : 'Pin'}
                      </button>
                      {!confirmDelete && (
                        <button type="button" className="fb-btn fb-btn--gray fb-btn--small" onClick={() => setConfirmFor(opened)}>
                          Delete
                        </button>
                      )}
                      {confirmDelete && (
                        <>
                          <button type="button" className="fb-btn fb-btn--danger fb-btn--small" onClick={() => store.remove()}>Delete this note</button>
                          <button type="button" className="fb-btn fb-btn--gray fb-btn--small" onClick={() => setConfirmFor(null)}>Keep</button>
                        </>
                      )}
                    </>
                  )}
                </div>
                {readOnly && <p className="fb-tools__note fb-notes__read-only" role="note">{READ_ONLY_NOTICE}</p>}
                <div
                  ref={editorRef}
                  className="fb-notes__body"
                  contentEditable={!readOnly}
                  aria-readonly={readOnly ? 'true' : undefined}
                  suppressContentEditableWarning
                  role="textbox"
                  aria-multiline="true"
                  aria-label="Note text"
                  data-placeholder={brainDump ? 'Type whatever is on your mind…' : 'Write your note…'}
                  onInput={typed}
                  onBlur={() => store.flush()}
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

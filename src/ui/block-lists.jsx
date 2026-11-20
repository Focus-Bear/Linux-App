import { useEffect, useState } from 'react';
import './styles/distracting-sites.css';
import './styles/blocking-schedule.css'; // .fb-option
import './styles/blocking.css';
import ListEditor from './list-editor.jsx';
import { blockingStore } from '../services/blockingStore.js';
import {
  MAX_LIST_NAME,
  entryError,
  isBuiltIn,
  listCount,
  listEntries,
  listKind,
  listNameError,
  listNotice,
  normaliseEntry,
  visibleLists,
} from '../electron/blockingModel.js';

const KIND_LABEL = { default: 'Default', relax: 'Relax', allow: 'Allow List', block: 'Block List' };

/**
 * Blocking > Block Lists. The account's block lists ("focus modes"), shared
 * with the Windows and Mac apps (Preferences/BlockListsView.cs): create,
 * rename and delete lists, choose block list or allow list, and edit the
 * websites. A focus session or a blocking schedule uses one of them.
 * `blocking` is the shell's blocking state (see useBlocking.js).
 */
export default function BlockListsPage({ blocking, onOpenDistractingSites }) {
  const { status, modes, schedules, error, inForce } = blocking;
  const lists = visibleLists(modes);
  const [selectedId, setSelectedId] = useState(null);
  const [dialog, setDialog] = useState(null); // null | { type: 'create' | 'rename' | 'delete', ... }

  useEffect(() => {
    blockingStore.load();
  }, []);

  const selected = lists.find((mode) => mode.id === selectedId) || lists[0] || null;

  if (status === 'loading') {
    return (
      <div className="fb-page">
        <h1 className="fb-page__title">Block Lists</h1>
        <p className="fb-page__subtitle" role="status">Loading your block lists…</p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="fb-page">
        <h1 className="fb-page__title">Block Lists</h1>
        <section className="fb-card" role="alert">
          <h2 className="fb-card__title">Your block lists couldn&apos;t be loaded</h2>
          <p className="fb-card__desc">Check your internet connection, then try again.</p>
          <button type="button" className="fb-btn fb-btn--primary" onClick={() => blockingStore.load()}>Try again</button>
        </section>
      </div>
    );
  }

  const kind = selected ? listKind(selected) : null;
  const entries = selected ? listEntries(selected) : [];
  const usedBy = selected ? schedules.filter((schedule) => schedule.focus_mode_id === selected.id) : [];
  const inUse = selected && inForce.mode?.id === selected.id;

  return (
    <div className="fb-page fb-blocking">
      <h1 className="fb-page__title">Block Lists</h1>
      <p className="fb-page__subtitle">
        Choose what a focus session or a blocking schedule blocks. Your lists are the same on all your devices.
      </p>

      {error && (
        <p className="fb-blocking__error" role="alert">
          {error}{' '}
          <button type="button" className="fb-blocking__link" onClick={() => blockingStore.clearError()}>Dismiss</button>
        </p>
      )}

      <section className="fb-card" aria-labelledby="my-lists">
        <div className="fb-row fb-row--between">
          <h2 id="my-lists" className="fb-blocking__caption">MY BLOCKLISTS</h2>
          <button type="button" className="fb-btn fb-btn--primary fb-btn--small" onClick={() => setDialog({ type: 'create' })}>
            Create New Block
          </button>
        </div>
        <div className="fb-blocking__lists" role="tablist" aria-label="Block lists">
          {lists.map((mode) => (
            <button
              key={mode.id}
              type="button"
              role="tab"
              aria-selected={mode.id === selected?.id}
              className={`fb-blocking__list${mode.id === selected?.id ? ' fb-blocking__list--selected' : ''}`}
              onClick={() => setSelectedId(mode.id)}
            >
              <span className="fb-blocking__list-name">{mode.name}</span>
              <span className="fb-blocking__list-meta">
                {KIND_LABEL[listKind(mode)]}
                {listCount(mode) ? ` · ${listCount(mode)}` : ''}
                {inForce.mode?.id === mode.id ? ' · in use now' : ''}
              </span>
            </button>
          ))}
        </div>
      </section>

      {selected && (
        <>
          <section className="fb-card" aria-label={`${selected.name} settings`}>
            <div className="fb-row fb-row--between fb-blocking__head">
              <h2 className="fb-card__title" style={{ margin: 0 }}>{selected.name}</h2>
              {!isBuiltIn(selected) && (
                <div className="fb-row">
                  <button
                    type="button"
                    className="fb-btn fb-btn--gray fb-btn--small"
                    onClick={() => setDialog({ type: 'rename', mode: selected })}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="fb-btn fb-btn--danger fb-btn--small"
                    onClick={() => setDialog({ type: 'delete', mode: selected })}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>

            {!isBuiltIn(selected) && (
              <div className="fb-segmented fb-blocking__kind" role="group" aria-label="List type">
                {['block', 'allow'].map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={kind === value}
                    onClick={() => blockingStore.setListKind(selected.id, value)}
                  >
                    {KIND_LABEL[value]}
                  </button>
                ))}
              </div>
            )}

            <p className="fb-card__desc" style={{ marginBottom: 0 }}>{listNotice(selected)}</p>
            {inUse && (
              <p className="fb-blocking__note">
                In use now{inForce.source === 'schedule' ? ` by the schedule "${inForce.schedule.name}"` : ' by your focus session'}.
                Changes apply straight away.
              </p>
            )}
            {kind === 'default' && (
              <button type="button" className="fb-btn fb-blocking__gap" onClick={onOpenDistractingSites}>
                Edit Super Distracting Sites
              </button>
            )}
          </section>

          {(kind === 'block' || kind === 'allow') && (
            <ListEditor
              key={`${selected.id}-${kind}`}
              embedded
              title={kind === 'allow' ? 'Allowed websites' : 'Blocked websites'}
              description={
                kind === 'allow'
                  ? 'Only these sites open while this list is in use. Add the sites you need for this kind of work.'
                  : 'These sites are blocked while this list is in use.'
              }
              items={entries}
              emptyText={kind === 'allow' ? 'Nothing is allowed in this list yet.' : 'Nothing is blocked in this list yet.'}
              addLabel="Add URL"
              dialogTitle="Add a new URL"
              placeholder="e.g. docs.google.com"
              help="A site (github.com), part of an address (google.com/maps) or a word that appears in the address."
              validate={(value) => entryError(value, entries)}
              onAdd={(value) => blockingStore.setListEntries(selected.id, [...entries, normaliseEntry(value)])}
              onRemove={(indices) =>
                blockingStore.setListEntries(selected.id, entries.filter((_, index) => !indices.has(index)))
              }
            />
          )}
        </>
      )}

      {dialog?.type === 'create' && (
        <NameDialog
          title="Create New Block"
          confirm="Create"
          modes={modes}
          withKind
          onCancel={() => setDialog(null)}
          onConfirm={async (name, newKind) => {
            const created = await blockingStore.createList(name, newKind);
            if (created) setSelectedId(created.id);
            setDialog(null);
          }}
        />
      )}

      {dialog?.type === 'rename' && (
        <NameDialog
          title="Rename this block list"
          confirm="Rename"
          modes={modes}
          initial={dialog.mode.name}
          selfId={dialog.mode.id}
          onCancel={() => setDialog(null)}
          onConfirm={(name) => {
            blockingStore.renameList(dialog.mode.id, name);
            setDialog(null);
          }}
        />
      )}

      {dialog?.type === 'delete' && (
        <div className="fb-dialog-overlay" onClick={() => setDialog(null)}>
          <div
            className="fb-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-list-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setDialog(null);
            }}
          >
            <div className="fb-dialog__header">
              <h2 id="delete-list-title">Delete &quot;{dialog.mode.name}&quot;?</h2>
            </div>
            <div className="fb-dialog__body">
              {inUse ? (
                <p style={{ margin: 0 }}>This block list is in use right now. End the focus session or schedule first.</p>
              ) : usedBy.length > 0 ? (
                <p style={{ margin: 0 }}>
                  {usedBy.length === 1 ? 'The schedule' : 'The schedules'} {usedBy.map((s) => `"${s.name}"`).join(', ')}{' '}
                  {usedBy.length === 1 ? 'uses' : 'use'} this block list. Choose another list for{' '}
                  {usedBy.length === 1 ? 'it' : 'them'} first.
                </p>
              ) : (
                <p style={{ margin: 0 }}>It is deleted on all your devices. This can&apos;t be undone.</p>
              )}
            </div>
            <div className="fb-dialog__footer">
              <button type="button" className="fb-btn fb-btn--gray" onClick={() => setDialog(null)} autoFocus>
                {inUse || usedBy.length > 0 ? 'OK' : 'Cancel'}
              </button>
              {!inUse && usedBy.length === 0 && (
                <button
                  type="button"
                  className="fb-btn fb-btn--danger"
                  onClick={() => {
                    blockingStore.deleteList(dialog.mode.id);
                    setSelectedId(null);
                    setDialog(null);
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NameDialog({ title, confirm, modes, initial = '', selfId = null, withKind = false, onCancel, onConfirm }) {
  const [name, setName] = useState(initial);
  const [kind, setKind] = useState('block');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    const problem = listNameError(name, modes, selfId);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    await onConfirm(name.trim(), kind);
  };

  return (
    <div className="fb-dialog-overlay" onClick={onCancel}>
      <form
        className="fb-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="list-name-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
        onSubmit={submit}
      >
        <div className="fb-dialog__header">
          <h2 id="list-name-title">{title}</h2>
        </div>
        <div className="fb-dialog__body">
          <label className="fb-blocking__label" htmlFor="list-name">Name</label>
          <input
            id="list-name"
            className="fb-input"
            value={name}
            maxLength={MAX_LIST_NAME}
            autoFocus
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'list-name-error' : undefined}
          />
          {error && <p id="list-name-error" className="fb-dialog__error" role="alert">{error}</p>}

          {withKind && (
            <div className="fb-options fb-blocking__gap" role="radiogroup" aria-label="List type">
              {[
                ['block', 'Block List', 'Blocks the sites you add, as well as your Super Distracting Sites.'],
                ['allow', 'Allow List', 'Blocks everything except the sites you add.'],
              ].map(([value, label, desc]) => (
                <label key={value} className={`fb-option${kind === value ? ' fb-option--checked' : ''}`}>
                  <input type="radio" name="list-kind" value={value} checked={kind === value} onChange={() => setKind(value)} />
                  <span>
                    <span className="fb-option__title">{label}</span>
                    <span className="fb-option__desc">{desc}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="fb-dialog__footer">
          <button type="button" className="fb-btn fb-btn--gray" onClick={onCancel}>Cancel</button>
          <button type="submit" className="fb-btn fb-btn--primary" disabled={busy}>{busy ? 'Saving…' : confirm}</button>
        </div>
      </form>
    </div>
  );
}

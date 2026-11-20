import { useState } from 'react';
import './styles/distracting-sites.css';

/**
 * Card with a selectable list, "Add" (opens a small dialog) and "Remove (n)".
 * Shared by Blocking > Super Distracting Sites and Keyword Blocking, styled like
 * the Windows blocked-URL lists (card, orange-bordered buttons, themed dialog).
 */
export default function ListEditor({
  title,
  description,
  items,
  emptyText,
  addLabel,
  dialogTitle,
  placeholder,
  help,
  validate,
  onAdd,
  onRemove,
  children,
}) {
  const [selected, setSelected] = useState(() => new Set());
  const [showDialog, setShowDialog] = useState(false);
  const [input, setInput] = useState('');
  const [error, setError] = useState(null);

  const toggle = (index) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const close = () => {
    setShowDialog(false);
    setInput('');
    setError(null);
  };

  const submit = () => {
    const value = input.trim();
    if (!value) return;
    // `validate` returns a message when the value can't be added.
    const problem = validate ? validate(value) : null;
    if (problem) {
      setError(problem);
      return;
    }
    onAdd(value);
    close();
  };

  const remove = () => {
    onRemove(selected);
    setSelected(new Set());
  };

  return (
    <div className="fb-page">
      <h1 className="fb-page__title">{title}</h1>
      <p className="fb-page__subtitle">{description}</p>

      <section className="fb-card">
        <ul className="fb-list" aria-label={title}>
          {items.length === 0 && <li className="fb-list__empty">{emptyText}</li>}
          {items.map((item, index) => (
            <li key={`${item}-${index}`}>
              <button
                type="button"
                className="fb-list__item"
                aria-pressed={selected.has(index)}
                onClick={() => toggle(index)}
              >
                {item}
              </button>
            </li>
          ))}
        </ul>

        <div className="fb-row fb-row--between" style={{ marginTop: 14 }}>
          <button type="button" className="fb-btn fb-btn--gray" onClick={remove} disabled={selected.size === 0}>
            Remove ({selected.size})
          </button>
          <button type="button" className="fb-btn fb-btn--primary" onClick={() => setShowDialog(true)}>
            + {addLabel}
          </button>
        </div>

        {children}
      </section>

      {showDialog && (
        <div className="fb-dialog-overlay" onClick={close}>
          <div
            className="fb-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fb-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="fb-dialog__header">
              <h2 id="fb-dialog-title">{dialogTitle}</h2>
              <button type="button" className="fb-icon-btn" onClick={close} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="fb-dialog__body">
              <input
                type="text"
                className="fb-input"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setError(null);
                }}
                aria-invalid={error ? 'true' : undefined}
                aria-describedby={error ? 'fb-dialog-error' : undefined}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit();
                  if (e.key === 'Escape') close();
                }}
                placeholder={placeholder}
                autoFocus
              />
              {error && (
                <div id="fb-dialog-error" className="fb-dialog__error" role="alert">
                  {error}
                </div>
              )}
              {help && <div className="fb-dialog__help">{help}</div>}
            </div>
            <div className="fb-dialog__footer">
              <button type="button" className="fb-btn fb-btn--gray" onClick={close}>
                Cancel
              </button>
              <button type="button" className="fb-btn fb-btn--primary" onClick={submit} disabled={!input.trim()}>
                Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

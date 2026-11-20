import { useState } from 'react';
import './styles/distracting-sites.css'; // shared .fb-input and .fb-dialog
import { quantityAnswers, quantityError } from '../services/dayPlanExtras.js';

/**
 * Asked when a habit that logs a quantity is done ("How many pages did you
 * read?"), like the Windows DayPlanLogQuantityWindow. onSubmit(answers) gets
 * the log_quantity_answers; an empty field leaves its question out.
 */
export default function QuantityDialog({ habit, onSubmit, onCancel }) {
  const [values, setValues] = useState({});
  const questions = habit.questions || [];
  const errors = Object.fromEntries(questions.map((question) => [question.id, quantityError(question, values[question.id])]));
  const invalid = Object.values(errors).some(Boolean);

  const submit = (event) => {
    event.preventDefault();
    if (invalid) return;
    onSubmit(quantityAnswers(questions, values));
  };

  return (
    <div className="fb-dialog-overlay">
      <form
        className="fb-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quantity-title"
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && onCancel) onCancel();
        }}
      >
        <div className="fb-dialog__header">
          <h2 id="quantity-title">{habit.icon ? `${habit.icon} ` : ''}{habit.name}</h2>
        </div>
        <div className="fb-dialog__body">
          {questions.map((question, index) => (
            <div key={question.id} style={{ marginBottom: 12 }}>
              <label htmlFor={`quantity-${question.id}`} style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
                {question.text}
              </label>
              <input
                id={`quantity-${question.id}`}
                className="fb-input"
                type="number"
                inputMode="decimal"
                step="any"
                min={question.min ?? undefined}
                max={question.max !== null && question.max > (question.min ?? -Infinity) ? question.max : undefined}
                value={values[question.id] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [question.id]: e.target.value }))}
                autoFocus={index === 0}
                aria-invalid={Boolean(errors[question.id])}
                aria-describedby={`quantity-help-${question.id}`}
              />
              <div id={`quantity-help-${question.id}`} className="fb-dialog__help">
                {errors[question.id] ||
                  [question.minLabel && `${question.min}: ${question.minLabel}`, question.maxLabel && `${question.max}: ${question.maxLabel}`]
                    .filter(Boolean)
                    .join(' · ')}
              </div>
            </div>
          ))}
        </div>
        <div className="fb-dialog__footer">
          {onCancel && (
            <button type="button" className="fb-btn fb-btn--gray" onClick={onCancel}>Cancel</button>
          )}
          <button type="button" className="fb-btn fb-btn--gray" onClick={() => onSubmit([])}>Don&apos;t log</button>
          <button type="submit" className="fb-btn fb-btn--primary" disabled={invalid}>Save and finish</button>
        </div>
      </form>
    </div>
  );
}

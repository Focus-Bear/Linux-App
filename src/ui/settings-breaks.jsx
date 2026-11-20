import { useEffect, useState } from 'react';
import './styles/distracting-sites.css'; // shared .fb-input and .fb-check
import './styles/focus-session.css'; // shared stepper
import './styles/micro-break.css';
import { breakStore } from '../services/breakStore.js';
import { useSyncedState } from '../services/sync.js';
import {
  MAX_BREAK_MINUTES,
  MIN_BREAK_MINUTES,
  nextBreakLabel,
  parseBreakMinutes,
  stepBreakMinutes,
} from '../electron/breakModel.js';

/**
 * Settings > Breaks. The settings of the Windows app's Breaks page and
 * Microbreak Settings dialog that do something on Linux:
 *   Enable Breaks              kUserdefaultsBreaksEnabledFromOnboarding (device settings)
 *   Break frequency (minutes)  break_after_minutes (account settings)
 *   Start breaks automatically kBreakAutoStartEnabled (device settings)
 * Break activities are edited on the Edit Habits page.
 */
export default function SettingsBreaksPage({ breaks, onEditHabits, onStartBreak }) {
  const [enabled, setEnabled, enabledLoading] = useSyncedState('breaksEnabled');
  const [autoStart, setAutoStart, autoLoading] = useSyncedState('breakAutoStart');
  const { status, habits, minutes, saving, saveError, nextAt } = breaks;
  const [text, setText] = useState(() => String(minutes));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    breakStore.load();
  }, []);

  useEffect(() => {
    setText(String(minutes));
    setInvalid(false);
  }, [minutes]);

  const apply = (value) => {
    setInvalid(false);
    setText(String(value));
    if (value !== minutes) breakStore.saveMinutes(value);
  };

  const commit = () => {
    const parsed = parseBreakMinutes(text);
    if (parsed === null) {
      setInvalid(true);
      return;
    }
    apply(parsed);
  };

  const ready = status === 'ready';
  const on = enabled !== false;
  const nextText = on ? nextBreakLabel(nextAt, Date.now()) : '';

  return (
    <div className="fb-page fb-break">
      <h1 className="fb-page__title">Breaks</h1>
      <p className="fb-page__subtitle">
        Micro breaks help keep your energy and alertness levels consistent throughout the day.
      </p>

      <section className="fb-card">
        <div className="fb-break__setting">
          <label className="fb-check">
            <input
              type="checkbox"
              checked={on}
              disabled={enabledLoading}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span>
              Enable Breaks
              <span className="fb-check__help">
                {on
                  ? `Focus Bear reminds you to take a break every ${minutes} minutes.${nextText ? ` ${nextText}.` : ''}`
                  : 'No break reminders. You can still start a break yourself.'}
              </span>
            </span>
          </label>
        </div>

        <div className="fb-break__setting">
          <label className="fb-focus__label" htmlFor="break-minutes" style={{ marginTop: 0 }}>
            Break frequency (minutes)
          </label>
          <div className="fb-focus__stepper">
            <button
              type="button"
              className="fb-btn fb-btn--gray"
              onClick={() => apply(stepBreakMinutes(parseBreakMinutes(text) ?? minutes, -1))}
              disabled={!ready || saving}
              aria-label="5 minutes less between breaks"
            >
              − 5
            </button>
            <input
              id="break-minutes"
              className="fb-input fb-focus__length"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
              }}
              disabled={!ready || saving}
              inputMode="numeric"
              aria-invalid={invalid}
              aria-describedby="break-minutes-help"
            />
            <button
              type="button"
              className="fb-btn fb-btn--gray"
              onClick={() => apply(stepBreakMinutes(parseBreakMinutes(text) ?? minutes, 1))}
              disabled={!ready || saving}
              aria-label="5 minutes more between breaks"
            >
              + 5
            </button>
          </div>
          <p id="break-minutes-help" className="fb-focus__help">
            {invalid
              ? `Enter a whole number from ${MIN_BREAK_MINUTES} to ${MAX_BREAK_MINUTES} minutes.`
              : 'Saved to your account, so your other devices use it too.'}
          </p>
          {saveError && <p className="fb-break__error" role="alert">{saveError}</p>}
        </div>

        <div className="fb-break__setting">
          <label className="fb-check">
            <input
              type="checkbox"
              checked={Boolean(autoStart)}
              disabled={autoLoading}
              onChange={(e) => setAutoStart(e.target.checked)}
            />
            <span>
              Start breaks automatically
              <span className="fb-check__help">
                When a break is due, its activities start after 5 seconds without pressing Start Micro Break.
              </span>
            </span>
          </label>
        </div>
      </section>

      <section className="fb-card" aria-labelledby="break-activities-title">
        <h2 id="break-activities-title" className="fb-card__title">Break activities</h2>
        {status === 'loading' && <p className="fb-card__desc" role="status">Loading your break activities…</p>}
        {status === 'error' && (
          <p className="fb-card__desc" role="alert">Your break activities couldn&apos;t be loaded. Check your connection.</p>
        )}
        {ready && habits.length === 0 && <p className="fb-card__desc">No break activities added yet.</p>}
        {ready && habits.length > 0 && (
          <>
            <p className="fb-card__desc">
              Each break plays the &quot;Every break&quot; activities plus one of the others, taking turns.
            </p>
            <ul className="fb-break__list">
              {habits.map((habit) => (
                <li key={habit.id} className="fb-break__item">
                  <span className="fb-break__item-icon" aria-hidden="true">{habit.icon || '✨'}</span>
                  <span className="fb-break__item-name">{habit.name}</span>
                  <span className={`fb-break__badge${habit.everyBreak ? ' fb-break__badge--every' : ''}`}>
                    {habit.everyBreak ? 'Every break' : 'Random breaks'}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="fb-row">
          <button type="button" className="fb-btn" onClick={onEditHabits}>Edit break activities</button>
          {ready && habits.length > 0 && (
            <button type="button" className="fb-btn fb-btn--primary" onClick={onStartBreak}>Start Micro Break</button>
          )}
        </div>
      </section>
    </div>
  );
}

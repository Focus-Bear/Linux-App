import { useEffect, useState } from 'react';
import './styles/distracting-sites.css'; // shared .fb-input
import './styles/focus-session.css';
import { useSyncedState } from '../services/sync.js';
import { clampMinutes, formatLength, parseLength, startLabel, stepMinutes } from '../electron/focusSessionModel.js';

/**
 * Settings > Focus Sessions. The usual session length, saved to the account as
 * kPomodoroDurationMinutes (the same setting as the Windows and Mac apps), and
 * used as the starting value on the Start Focus Session screen.
 */
export default function SettingsFocusPage() {
  const [saved, setSaved, isLoading] = useSyncedState('pomodoroMinutes');
  const minutes = clampMinutes(saved);
  const [text, setText] = useState(() => formatLength(minutes));

  useEffect(() => {
    setText(formatLength(minutes));
  }, [minutes]);

  const apply = (value) => {
    const next = clampMinutes(value);
    setText(formatLength(next));
    if (next !== minutes) setSaved(next);
  };

  const commit = () => apply(parseLength(text) ?? minutes);

  return (
    <div className="fb-page fb-focus">
      <h1 className="fb-page__title">Focus Sessions</h1>
      <p className="fb-page__subtitle">How long your focus sessions usually are.</p>

      <section className="fb-card" aria-busy={isLoading}>
        <label className="fb-focus__label" htmlFor="default-length">Default session length:</label>
        <div className="fb-focus__stepper">
          <button
            type="button"
            className="fb-btn fb-btn--gray"
            onClick={() => apply(stepMinutes(parseLength(text) ?? minutes, -1))}
            disabled={isLoading}
            aria-label="5 minutes less"
          >
            − 5
          </button>
          <input
            id="default-length"
            className="fb-input fb-focus__length"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
            }}
            disabled={isLoading}
            inputMode="numeric"
            aria-describedby="default-length-help"
          />
          <button
            type="button"
            className="fb-btn fb-btn--gray"
            onClick={() => apply(stepMinutes(parseLength(text) ?? minutes, 1))}
            disabled={isLoading}
            aria-label="5 minutes more"
          >
            + 5
          </button>
        </div>
        <p id="default-length-help" className="fb-focus__help">
          Hours and minutes (HH:MM), up to 8 hours. The start screen will offer &quot;{startLabel(minutes)}&quot;; you can
          still change the length for each session. Saved to your account, so your other devices use it too.
        </p>
      </section>
    </div>
  );
}

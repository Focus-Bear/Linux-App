import { useEffect, useState } from 'react';
import './styles/distracting-sites.css'; // shared .fb-input and .fb-dialog
import './styles/focus-session.css';
import { focusApi } from '../services/focusApi.js';
import { auth0Sync } from '../services/sync.js';
import {
  DEFAULT_MODE_NAME,
  MAX_ACHIEVEMENT_CHARS,
  createSession,
  defaultMinutes,
  elapsedMs,
  formatClock,
  formatDuration,
  formatLength,
  formatRange,
  parseLength,
  pickDefaultMode,
  progress,
  remainingMs,
  selectableModes,
  sessionTitle,
  startLabel,
  stepMinutes,
  totalMs,
} from '../electron/focusSessionModel.js';
import { listSummary, wireToInput } from '../electron/blockingModel.js';

const LOGO = `${import.meta.env.BASE_URL}bear-icon.png`;

// Goal and block list carried from the end screen's "Start a new session".
let prefill = null;

// The block list used last time is offered first, as on Windows (MOST_RECENT_FOCUS_MODE_ID).
const LAST_MODE_KEY = 'fb_last_focus_mode';
const readLastMode = () => {
  try {
    return window.localStorage.getItem(LAST_MODE_KEY) || '';
  } catch {
    return '';
  }
};
const saveLastMode = (id) => {
  try {
    if (id) window.localStorage.setItem(LAST_MODE_KEY, id);
  } catch {
    // not remembered
  }
};

/**
 * MAIN > Focus Session. Three screens, following the Windows app:
 *   start   - goal, session length, block list  (Pomodoro/FocusStartSimpleScreen.cs)
 *   running - countdown, progress, pause / end  (focusStateVcInfo)
 *   end     - "Great job" with the session's numbers and a reflection (SessionCompleteView.cs)
 * The session itself lives in the main process (see useFocusSession.js).
 */
export default function FocusSessionPage({ session, now, loaded, blocking, onEditBlockLists }) {
  if (!loaded) {
    return (
      <div className="fb-page fb-focus">
        <p className="fb-page__subtitle" role="status">Loading…</p>
      </div>
    );
  }
  if (!session) return <StartView blocking={blocking} onEditBlockLists={onEditBlockLists} />;
  if (session.status === 'ended') return <EndView session={session} />;
  return <RunningView session={session} now={now} />;
}

// ---------------------------------------------------------------- start ----

function StartView({ blocking, onEditBlockLists }) {
  // The usual length from Settings > Focus Sessions (kPomodoroDurationMinutes).
  const [minutes, setMinutes] = useState(() =>
    defaultMinutes({ kPomodoroDurationMinutes: auth0Sync.getValue('pomodoroMinutes') }),
  );
  const [lengthText, setLengthText] = useState(() => formatLength(minutes));
  const [goal, setGoal] = useState(() => prefill?.intention || '');
  const [modes, setModes] = useState(null); // null = loading
  const [modeId, setModeId] = useState(() => prefill?.modeId || '');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    prefill = null;
    let cancelled = false;
    focusApi
      .getFocusModes()
      .then((list) => {
        if (cancelled) return;
        setModes(list);
        setModeId((current) => {
          if (current) return current;
          const usable = selectableModes(list);
          const last = readLastMode();
          return usable.find((mode) => mode.id === last)?.id || pickDefaultMode(usable)?.id || '';
        });
      })
      .catch((err) => {
        console.error('[Focus] Could not load block lists:', err);
        if (!cancelled) setModes([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const options = selectableModes(modes || []);
  const selectedMode = options.find((option) => option.id === modeId) || null;
  // A blocking schedule is on: say so, as the Windows start screen does.
  const running = blocking?.inForce?.source === 'schedule' ? blocking.inForce.schedule : null;
  const scheduleNote = running
    ? `“${running.name}” is blocking until ${wireToInput(running.end_time)}. You can still start a focus session.`
    : '';

  const applyMinutes = (value) => {
    setMinutes(value);
    setLengthText(formatLength(value));
  };

  const commitLength = () => {
    const parsed = parseLength(lengthText);
    applyMinutes(parsed ?? minutes);
  };

  const start = async () => {
    if (starting) return;
    const length = parseLength(lengthText) ?? minutes;
    applyMinutes(length);
    setStarting(true);
    setError(null);

    let mode = options.find((option) => option.id === modeId) || null;
    let synced = false;
    let draft = null;
    try {
      // An account that has never used another Focus Bear app has no block
      // lists yet; the default one is created the way the Windows app does it.
      if (!mode) mode = await focusApi.ensureDefaultMode(modes || []);
      draft = createSession({ modeId: mode.id, modeName: mode.name, intention: goal, minutes: length, now: Date.now() });
      await focusApi.startSession(draft);
      synced = true;
      saveLastMode(mode.id);
    } catch (err) {
      // Offline or the server said no: still let the person focus. The
      // session just won't appear in their stats.
      console.error('[Focus] Could not start the session on the server:', err);
    }

    try {
      await window.api.focusSession.start({
        modeId: mode?.id || null,
        modeName: mode?.name || DEFAULT_MODE_NAME,
        intention: goal,
        minutes: length,
        startTime: draft?.startTime,
        synced,
      });
    } catch (err) {
      console.error('[Focus] Could not start the session:', err);
      setError('The session could not be started. Try again.');
      setStarting(false);
    }
  };

  return (
    <div className="fb-page fb-focus">
      <h1 className="fb-page__title">Start a focus session</h1>
      <p className="fb-page__subtitle">Choose how long to focus and which block list keeps distractions away.</p>

      <div className="fb-focus__bear">
        <img src={LOGO} alt="" />
        <div className="fb-focus__bubble">Ready to focus?</div>
      </div>

      <section className="fb-card">
        <label className="fb-focus__label" htmlFor="focus-length">Set session length:</label>
        <div className="fb-focus__stepper">
          <button
            type="button"
            className="fb-btn fb-btn--gray"
            onClick={() => applyMinutes(stepMinutes(parseLength(lengthText) ?? minutes, -1))}
            aria-label="5 minutes less"
          >
            − 5
          </button>
          <input
            id="focus-length"
            className="fb-input fb-focus__length"
            value={lengthText}
            onChange={(e) => setLengthText(e.target.value)}
            onBlur={commitLength}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitLength();
            }}
            inputMode="numeric"
            aria-describedby="focus-length-help"
          />
          <button
            type="button"
            className="fb-btn fb-btn--gray"
            onClick={() => applyMinutes(stepMinutes(parseLength(lengthText) ?? minutes, 1))}
            aria-label="5 minutes more"
          >
            + 5
          </button>
        </div>
        <p id="focus-length-help" className="fb-focus__help">Hours and minutes (HH:MM), up to 8 hours.</p>

        <label className="fb-focus__label" htmlFor="focus-goal">What&apos;s your focus goal?</label>
        <textarea
          id="focus-goal"
          className="fb-input fb-focus__goal"
          rows={2}
          maxLength={255}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Optional: what do you want to get done in this session?"
        />

        <label className="fb-focus__label" htmlFor="focus-mode">Block list:</label>
        <select
          id="focus-mode"
          className="fb-input"
          value={modeId}
          onChange={(e) => setModeId(e.target.value)}
          disabled={modes === null}
        >
          {modes === null && <option value="">Loading your block lists…</option>}
          {modes !== null && options.length === 0 && <option value="">{DEFAULT_MODE_NAME}</option>}
          {options.map((option) => (
            <option key={option.id} value={option.id}>{option.name}</option>
          ))}
        </select>

        <p className="fb-focus__help">
          {selectedMode ? `${listSummary(selectedMode)} ` : ''}
          {onEditBlockLists && (
            <button type="button" className="fb-focus__link" onClick={onEditBlockLists}>Edit block lists</button>
          )}
        </p>
        {scheduleNote && <p className="fb-focus__help">{scheduleNote}</p>}

        {error && <p className="fb-focus__error" role="alert">{error}</p>}

        <button
          type="button"
          className="fb-btn fb-btn--primary fb-btn--block fb-focus__start"
          onClick={start}
          disabled={starting || modes === null}
        >
          {starting ? 'Starting…' : startLabel(parseLength(lengthText) ?? minutes)}
        </button>
      </section>
    </div>
  );
}

// -------------------------------------------------------------- running ----

function RunningView({ session, now }) {
  const [confirmEnd, setConfirmEnd] = useState(false);
  const paused = session.status === 'paused';
  const remaining = remainingMs(session, now);
  const percent = Math.round(progress(session, now) * 100);

  // Tell the server about a changed finish time (−5 / +5, resume), as the
  // Windows app does for −5 / +5. Best effort: the local timer is what counts.
  const syncFinish = (updated) => {
    if (!updated || !updated.synced || !updated.modeId || updated.status !== 'running') return;
    focusApi.updateScheduledFinish(updated).catch((err) => console.error('[Focus] Could not update the finish time:', err));
  };

  const adjust = (delta) => window.api.focusSession.adjust(delta).then(syncFinish);
  const togglePause = () =>
    paused ? window.api.focusSession.resume().then(syncFinish) : window.api.focusSession.pause();

  const end = () => {
    setConfirmEnd(false);
    window.api.focusSession.end();
  };

  return (
    <div className="fb-page fb-focus">
      <h1 className="fb-page__title">{paused ? 'Focus Session Paused' : 'Ongoing Focus Session'}</h1>
      <p className="fb-page__subtitle">
        {paused ? 'The clock is stopped. Resume when you are ready.' : 'Stay with it. Focus Bear is keeping distractions away.'}
      </p>

      <section className={`fb-card fb-focus__timer-card${paused ? ' fb-focus__timer-card--paused' : ''}`}>
        <div className="fb-focus__clock" role="timer" aria-label="Time left">
          {formatClock(remaining)}
        </div>
        <div
          className="fb-focus__progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label="Session progress"
        >
          <div className="fb-focus__progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <div className="fb-focus__progress-text">
          {formatClock(Math.floor(elapsedMs(session, now) / 1000) * 1000)} of {formatClock(totalMs(session))}
        </div>

        <div className="fb-focus__adjust">
          <button
            type="button"
            className="fb-btn fb-btn--gray fb-btn--small"
            onClick={() => adjust(-5)}
            title="Take time off this session"
          >
            − 5 min
          </button>
          <button
            type="button"
            className="fb-btn fb-btn--gray fb-btn--small"
            onClick={() => adjust(5)}
            title="Add time to this session"
          >
            + 5 min
          </button>
        </div>
      </section>

      <section className="fb-card">
        <dl className="fb-focus__facts">
          <dt>Focus Goal:</dt>
          <dd className={session.intention ? '' : 'fb-focus__muted'}>
            {session.intention || 'No goal set for this session'}
          </dd>
          <dt>Block list:</dt>
          <dd>{session.modeName || DEFAULT_MODE_NAME}</dd>
        </dl>
        {!session.synced && (
          <p className="fb-focus__help">
            Focus Bear couldn&apos;t reach your account when this session started, so it won&apos;t show in your stats.
          </p>
        )}
        <div className="fb-row fb-focus__actions">
          <button type="button" className="fb-btn fb-btn--primary" onClick={togglePause}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="fb-btn fb-btn--gray" onClick={() => setConfirmEnd(true)}>
            End Session
          </button>
        </div>
      </section>

      {confirmEnd && (
        <div className="fb-dialog-overlay" onClick={() => setConfirmEnd(false)}>
          <div
            className="fb-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="focus-end-title"
            aria-describedby="focus-end-text"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setConfirmEnd(false);
            }}
          >
            <div className="fb-dialog__header">
              <h2 id="focus-end-title">End session early?</h2>
            </div>
            <div className="fb-dialog__body">
              <p id="focus-end-text" style={{ margin: 0 }}>
                A few more minutes could be the difference. Stick with it?
              </p>
            </div>
            <div className="fb-dialog__footer">
              <button type="button" className="fb-btn fb-btn--gray" onClick={end}>
                End session
              </button>
              <button type="button" className="fb-btn fb-btn--primary" onClick={() => setConfirmEnd(false)} autoFocus>
                Keep going
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ end ----

function EndView({ session }) {
  const [achievements, setAchievements] = useState('');
  const [stars, setStars] = useState(0);
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error
  const focused = elapsedMs(session, session.endedAt);
  const canSave = session.synced && session.finishReported && (achievements.trim() || stars > 0) && saveState !== 'saving';

  const save = async () => {
    setSaveState('saving');
    try {
      const saved = await focusApi.saveReflection(session, { achievements, stars });
      setSaveState(saved ? 'saved' : 'error');
    } catch (err) {
      console.error('[Focus] Could not save the reflection:', err);
      setSaveState('error');
    }
  };

  const close = (again) => {
    if (again) prefill = { intention: session.intention, modeId: session.modeId };
    window.api.focusSession.clear();
  };

  return (
    <div className="fb-page fb-focus">
      <div className="fb-focus__hero">
        <img src={LOGO} alt="" />
        <div>
          <h1 className="fb-focus__great">GREAT JOB!</h1>
          <p className="fb-page__subtitle" style={{ marginBottom: 0 }}>
            {session.endedEarly
              ? 'Focus session ended. Every focused minute counts.'
              : 'Focus session complete. Look at you getting things done.'}
          </p>
        </div>
      </div>

      <section className="fb-card">
        <h2 className="fb-card__title">{sessionTitle(session)}</h2>
        <p className="fb-card__desc">
          {formatRange(session.startTime, session.endedAt)} • {session.modeName || DEFAULT_MODE_NAME}
        </p>
        <div className="fb-focus__metrics">
          <div className="fb-focus__metric">
            <div className="fb-focus__metric-value">{formatDuration(focused)}</div>
            <div className="fb-focus__metric-label">Total Focus Time</div>
          </div>
          <div className="fb-focus__metric">
            <div className="fb-focus__metric-value">{formatDuration(totalMs(session))}</div>
            <div className="fb-focus__metric-label">Planned Time</div>
          </div>
          <div className="fb-focus__metric">
            <div className="fb-focus__metric-value">{formatDuration(session.pausedTotalMs)}</div>
            <div className="fb-focus__metric-label">Time Paused</div>
          </div>
        </div>
      </section>

      <section className="fb-card" aria-labelledby="focus-reflect">
        <h2 id="focus-reflect" className="fb-card__title">Reflect on this session</h2>

        <label className="fb-focus__label" htmlFor="focus-achieved">What did you achieve during this session?</label>
        <textarea
          id="focus-achieved"
          className="fb-input fb-focus__goal"
          rows={2}
          maxLength={MAX_ACHIEVEMENT_CHARS}
          value={achievements}
          onChange={(e) => {
            setAchievements(e.target.value);
            setSaveState('idle');
          }}
        />
        <div className="fb-focus__counter">{achievements.length}/{MAX_ACHIEVEMENT_CHARS}</div>

        <div className="fb-focus__label" id="focus-rate">Rate your productivity</div>
        <div className="fb-focus__stars" role="radiogroup" aria-labelledby="focus-rate">
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={stars === value}
              aria-label={`${value} star${value === 1 ? '' : 's'}`}
              className={`fb-focus__star${value <= stars ? ' fb-focus__star--on' : ''}`}
              onClick={() => {
                setStars(value === stars ? 0 : value);
                setSaveState('idle');
              }}
            >
              ★
            </button>
          ))}
        </div>

        <div className="fb-row" style={{ marginTop: 14 }}>
          <button type="button" className="fb-btn" onClick={save} disabled={!canSave}>
            {saveState === 'saving' ? 'Saving…' : 'Save'}
          </button>
          <span className="fb-focus__help" role="status" style={{ margin: 0 }}>
            {saveState === 'saved' && 'Saved to your focus history.'}
            {saveState === 'error' && "Couldn't save that. Check your connection and try again."}
            {saveState === 'idle' && !session.synced && "This session wasn't synced, so there is nothing to attach a reflection to."}
          </span>
        </div>
      </section>

      <div className="fb-row fb-focus__actions">
        <button type="button" className="fb-btn fb-btn--primary" onClick={() => close(false)}>
          Continue
        </button>
        <button type="button" className="fb-btn" onClick={() => close(true)}>
          Start a new session
        </button>
      </div>
    </div>
  );
}

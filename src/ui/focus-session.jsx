import { useEffect, useRef, useState } from 'react';
import './styles/distracting-sites.css'; // shared .fb-input and .fb-dialog
import './styles/focus-session.css';
import { focusApi } from '../services/focusApi.js';
import { toolsApi } from '../services/toolsApi.js';
import { auth0Sync } from '../services/sync.js';
import { dayKey, newTaskBody } from '../services/dayPlanModel.js';
import {
  DEFAULT_MODE_NAME,
  MAX_ACHIEVEMENT_CHARS,
  MAX_QUEUE,
  STRICTNESS_LEVELS,
  activeTask,
  canPause,
  clockMs,
  completeTask,
  createSession,
  defaultMinutes,
  defaultStrictness,
  doneTasks,
  elapsedMs,
  formatClock,
  formatDuration,
  formatLength,
  formatRange,
  makeStopCode,
  needsStopCode,
  parseLength,
  pickDefaultMode,
  playTask,
  progress,
  selectableModes,
  sessionQueue,
  sessionTitle,
  startLabel,
  stepMinutes,
  stopCodeMatches,
  stopDelaySeconds,
  strictnessLevel,
  totalMs,
} from '../electron/focusSessionModel.js';
import { listSummary, wireToInput } from '../electron/blockingModel.js';

const LOGO = `${import.meta.env.BASE_URL}bear-icon.png`;

// Goal and block list carried from the end screen's "Start a new session".
let prefill = null;

// The block list and strictness used last time are offered first, as on Windows
// (MOST_RECENT_FOCUS_MODE_ID, LASTFOCUSSESSIONSTRICTNESS).
const LAST_MODE_KEY = 'fb_last_focus_mode';
const LAST_STRICTNESS_KEY = 'fb_last_focus_strictness';
const readStored = (key) => {
  try {
    return window.localStorage.getItem(key) || '';
  } catch {
    return '';
  }
};
const store = (key, value) => {
  try {
    if (value) window.localStorage.setItem(key, value);
  } catch {
    // not remembered
  }
};

/**
 * MAIN > Focus Session. Three screens, following the Windows app:
 *   start   - goal, tasks, session length or no end time, strictness, block list
 *             (Pomodoro/FocusStartAdvancedScreen.cs)
 *   running - clock, current task, brain dump, pause / end  (focusStateVcInfo)
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

/** "Tasks for this session": pick to-dos, search them, or type a new one. */
function TaskPicker({ chosen, onChange }) {
  const [candidates, setCandidates] = useState(null); // null = loading
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [newTitle, setNewTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    focusApi
      .getCandidateTasks()
      .then((list) => {
        if (!cancelled) setCandidates(list);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setResults(null);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      focusApi
        .searchTasks(text)
        .then((list) => {
          if (!cancelled) setResults(list);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const chosenIds = new Set(chosen.map((task) => task.id));
  const full = chosen.length >= MAX_QUEUE;
  const offered = (results || candidates || []).filter((task) => !chosenIds.has(task.id)).slice(0, 8);

  const addNew = async (event) => {
    event.preventDefault();
    const body = newTaskBody(newTitle, dayKey(new Date()), 25);
    if (!body || adding) return;
    setAdding(true);
    setError(null);
    try {
      const created = await focusApi.createTask(body);
      if (created?.id) onChange([...chosen, created]);
      setNewTitle('');
    } catch (err) {
      console.error('[Focus] Could not create the task:', err);
      setError("Couldn't add that task. Check your connection and try again.");
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="fb-focus__tasks">
      <div className="fb-focus__label" id="focus-tasks-label">Tasks for this session (optional):</div>
      {chosen.length > 0 && (
        <ol className="fb-focus__queue" aria-labelledby="focus-tasks-label">
          {chosen.map((task, index) => (
            <li key={task.id}>
              <span className="fb-focus__queue-title">
                {task.icon ? `${task.icon} ` : ''}{task.title}
                {index === 0 && <span className="fb-pill"> First</span>}
              </span>
              <button
                type="button"
                className="fb-btn fb-btn--gray fb-btn--small"
                onClick={() => onChange(chosen.filter((item) => item.id !== task.id))}
                aria-label={`Remove ${task.title} from this session`}
              >
                Remove
              </button>
            </li>
          ))}
        </ol>
      )}

      <input
        className="fb-input"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search your to-do list"
        aria-label="Search your to-do list"
      />
      {candidates === null && <p className="fb-focus__help" role="status">Loading your tasks…</p>}
      {candidates !== null && offered.length === 0 && (
        <p className="fb-focus__help">{results ? `No unfinished tasks match "${query.trim()}".` : 'No more unfinished tasks to add.'}</p>
      )}
      <ul className="fb-focus__candidates">
        {offered.map((task) => (
          <li key={task.id}>
            <button
              type="button"
              className="fb-focus__candidate"
              onClick={() => onChange([...chosen, task])}
              disabled={full}
              aria-label={`Add ${task.title} to this session`}
            >
              <span aria-hidden="true">＋</span>
              <span className="fb-focus__queue-title">{task.icon ? `${task.icon} ` : ''}{task.title}</span>
            </button>
          </li>
        ))}
      </ul>

      <form className="fb-focus__new-task" onSubmit={addNew}>
        <input
          className="fb-input"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Or type a new task"
          aria-label="New task"
          maxLength={255}
        />
        <button type="submit" className="fb-btn" disabled={!newTitle.trim() || adding || full}>
          {adding ? 'Adding…' : 'Add task'}
        </button>
      </form>
      {error && <p className="fb-focus__error" role="alert">{error}</p>}
    </div>
  );
}

function StartView({ blocking, onEditBlockLists }) {
  // The usual length from Settings > Focus Sessions (kPomodoroDurationMinutes).
  const [minutes, setMinutes] = useState(() =>
    defaultMinutes({ kPomodoroDurationMinutes: auth0Sync.getValue('pomodoroMinutes') }),
  );
  const [lengthText, setLengthText] = useState(() => formatLength(minutes));
  const [untimed, setUntimed] = useState(false);
  const [strictness, setStrictness] = useState(() =>
    defaultStrictness(readStored(LAST_STRICTNESS_KEY), auth0Sync.getValue('selectedBearMode')),
  );
  const [goal, setGoal] = useState(() => prefill?.intention || '');
  const [tasks, setTasks] = useState([]);
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
          const last = readStored(LAST_MODE_KEY);
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

    const queue = sessionQueue(tasks);
    // Without a typed goal the first task is the goal, so the session has a name in the stats.
    const intention = goal.trim() || queue[0]?.title || '';
    let mode = options.find((option) => option.id === modeId) || null;
    let synced = false;
    let draft = null;
    try {
      // An account that has never used another Focus Bear app has no block
      // lists yet; the default one is created the way the Windows app does it.
      if (!mode) mode = await focusApi.ensureDefaultMode(modes || []);
      draft = createSession({
        modeId: mode.id,
        modeName: mode.name,
        intention,
        minutes: length,
        untimed,
        strictness,
        tasks: queue,
        now: Date.now(),
      });
      await focusApi.startSession(draft);
      synced = true;
      store(LAST_MODE_KEY, mode.id);
    } catch (err) {
      // Offline or the server said no: still let the person focus. The
      // session just won't appear in their stats.
      console.error('[Focus] Could not start the session on the server:', err);
    }
    store(LAST_STRICTNESS_KEY, strictness);

    try {
      await window.api.focusSession.start({
        modeId: mode?.id || null,
        modeName: mode?.name || DEFAULT_MODE_NAME,
        intention,
        minutes: length,
        untimed,
        strictness,
        tasks: queue,
        startTime: draft?.startTime,
        synced,
      });
    } catch (err) {
      console.error('[Focus] Could not start the session:', err);
      setError('The session could not be started. Try again.');
      setStarting(false);
    }
  };

  const level = strictnessLevel(strictness);

  return (
    <div className="fb-page fb-focus">
      <h1 className="fb-page__title">Start a focus session</h1>
      <p className="fb-page__subtitle">Choose what to work on, for how long, and which block list keeps distractions away.</p>

      <div className="fb-focus__bear">
        <img src={LOGO} alt="" />
        <div className="fb-focus__bubble">Ready to focus?</div>
      </div>

      <section className="fb-card">
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

        <TaskPicker chosen={tasks} onChange={setTasks} />
      </section>

      <section className="fb-card">
        <label className="fb-focus__label" htmlFor="focus-length">Set session length:</label>
        <div className="fb-focus__stepper">
          <button
            type="button"
            className="fb-btn fb-btn--gray"
            onClick={() => applyMinutes(stepMinutes(parseLength(lengthText) ?? minutes, -1))}
            aria-label="5 minutes less"
            disabled={untimed}
          >
            − 5
          </button>
          <input
            id="focus-length"
            className="fb-input fb-focus__length"
            value={untimed ? '--:--' : lengthText}
            onChange={(e) => setLengthText(e.target.value)}
            onBlur={commitLength}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitLength();
            }}
            inputMode="numeric"
            aria-describedby="focus-length-help"
            disabled={untimed}
          />
          <button
            type="button"
            className="fb-btn fb-btn--gray"
            onClick={() => applyMinutes(stepMinutes(parseLength(lengthText) ?? minutes, 1))}
            aria-label="5 minutes more"
            disabled={untimed}
          >
            + 5
          </button>
        </div>
        <p id="focus-length-help" className="fb-focus__help">Hours and minutes (HH:MM), up to 8 hours.</p>
        <label className="fb-focus__check">
          <input type="checkbox" checked={untimed} onChange={(e) => setUntimed(e.target.checked)} />
          <span>
            No end time
            <span className="fb-focus__help"> The clock counts up and the session runs until you end it (12 hours at most).</span>
          </span>
        </label>

        <div className="fb-focus__label" id="focus-strictness">How strict should this session be?</div>
        <div className="fb-segmented" role="radiogroup" aria-labelledby="focus-strictness">
          {STRICTNESS_LEVELS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={option.id === strictness}
              aria-pressed={option.id === strictness}
              onClick={() => setStrictness(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="fb-focus__help">
          {level?.id === 'junior' && 'Junior: you can pause or stop at any time.'}
          {level?.id === 'captain' && 'Captain: pausing or stopping takes a 15 second wait.'}
          {level?.id === 'pawfessor' && 'Pawfessor: no pausing. To stop early you have to type a row of random characters.'}
        </p>

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
          {starting ? 'Starting…' : untimed ? 'Start an untimed session' : startLabel(parseLength(lengthText) ?? minutes)}
        </button>
      </section>
    </div>
  );
}

// -------------------------------------------------------------- running ----

/**
 * The dialog between pressing Pause / End Session and it happening.
 *   Junior    - a question (ending only; pausing is immediate)
 *   Captain   - a 15 second countdown that can be cancelled
 *   Pawfessor - random characters to type (ending only; there is no pause)
 */
function StopDialog({ session, action, onConfirm, onCancel }) {
  const delay = stopDelaySeconds(session);
  const withCode = action === 'end' && needsStopCode(session);
  const [left, setLeft] = useState(delay);
  const [code] = useState(() => (withCode ? makeStopCode() : ''));
  const [typed, setTyped] = useState('');
  const confirmed = useRef(false);

  useEffect(() => {
    if (delay <= 0) return undefined;
    const timer = setInterval(() => setLeft((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [delay]);

  // Captain: when the wait is over the pause or stop goes through by itself, as on Windows.
  useEffect(() => {
    if (delay > 0 && left === 0 && !confirmed.current) {
      confirmed.current = true;
      onConfirm();
    }
  }, [delay, left, onConfirm]);

  const ending = action === 'end';
  const title = ending ? 'End session early?' : 'Pause the session?';

  return (
    <div className="fb-dialog-overlay" onClick={onCancel}>
      <div
        className="fb-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="focus-stop-title"
        aria-describedby="focus-stop-text"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      >
        <div className="fb-dialog__header">
          <h2 id="focus-stop-title">{title}</h2>
        </div>
        <div className="fb-dialog__body">
          {delay > 0 && (
            <>
              <p id="focus-stop-text" style={{ marginTop: 0 }}>
                This is a Captain session. The session {ending ? 'ends' : 'pauses'} when the wait is over. Changed your
                mind? Keep going.
              </p>
              <div className="fb-focus__countdown" role="timer" aria-live="polite">{left}</div>
            </>
          )}
          {withCode && (
            <>
              <p id="focus-stop-text" style={{ marginTop: 0 }}>
                This is a Pawfessor session: no stopping. If you really have to, type these characters exactly.
              </p>
              <div className="fb-focus__code" aria-label="Characters to type">{code}</div>
              <input
                className="fb-input"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onPaste={(e) => e.preventDefault()}
                aria-label="Type the characters shown above"
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            </>
          )}
          {delay <= 0 && !withCode && (
            <p id="focus-stop-text" style={{ margin: 0 }}>
              A few more minutes could be the difference. Stick with it?
            </p>
          )}
        </div>
        <div className="fb-dialog__footer">
          {delay <= 0 && (
            <button
              type="button"
              className="fb-btn fb-btn--gray"
              onClick={onConfirm}
              disabled={withCode && !stopCodeMatches(code, typed)}
            >
              End session
            </button>
          )}
          <button type="button" className="fb-btn fb-btn--primary" onClick={onCancel} autoFocus={!withCode}>
            Keep going
          </button>
        </div>
      </div>
    </div>
  );
}

function RunningView({ session, now }) {
  const [stopAction, setStopAction] = useState(null); // null | 'end' | 'pause'
  const [taskError, setTaskError] = useState(null);
  const [dump, setDump] = useState('');
  const [dumpState, setDumpState] = useState('idle'); // idle | saving | saved | error
  const paused = session.status === 'paused';
  const percent = Math.round(progress(session, now) * 100);
  const queue = Array.isArray(session.tasks) ? session.tasks : [];
  const current = activeTask(queue);
  const finished = doneTasks(queue).length;
  const level = strictnessLevel(session.strictness);

  // Tell the server about a changed finish time (−5 / +5, resume), as the
  // Windows app does for −5 / +5. Best effort: the local timer is what counts.
  const syncFinish = (updated) => {
    if (!updated || !updated.synced || !updated.modeId || updated.status !== 'running') return;
    focusApi.updateScheduledFinish(updated).catch((err) => console.error('[Focus] Could not update the finish time:', err));
  };

  const adjust = (delta) => window.api.focusSession.adjust(delta).then(syncFinish);

  const pauseOrResume = () => {
    if (paused) {
      window.api.focusSession.resume().then(syncFinish);
      return;
    }
    if (stopDelaySeconds(session) > 0) setStopAction('pause');
    else window.api.focusSession.pause();
  };

  const confirmStop = () => {
    const action = stopAction;
    setStopAction(null);
    if (action === 'pause') window.api.focusSession.pause();
    else if (action === 'end') window.api.focusSession.end();
  };

  // Done on the current task: it is ticked off in the to-do list and the next one comes up.
  const finishTask = async (task) => {
    setTaskError(null);
    await window.api.focusSession.setTasks(completeTask(queue, task.id));
    try {
      await focusApi.completeTask(task);
    } catch (err) {
      console.error('[Focus] Could not tick the task off:', err);
      setTaskError(`"${task.title}" is done here, but couldn't be ticked off in your to-do list. Check your connection.`);
    }
  };

  const saveDump = async () => {
    if (!dump.trim() || dumpState === 'saving') return;
    setDumpState('saving');
    try {
      await toolsApi.appendBrainDump(dump);
      setDump('');
      setDumpState('saved');
    } catch (err) {
      console.error('[Focus] Could not save to the brain dump:', err);
      setDumpState('error');
    }
  };

  return (
    <div className="fb-page fb-focus">
      <h1 className="fb-page__title">{paused ? 'Focus Session Paused' : 'Ongoing Focus Session'}</h1>
      <p className="fb-page__subtitle">
        {paused ? 'The clock is stopped. Resume when you are ready.' : 'Stay with it. Focus Bear is keeping distractions away.'}
      </p>

      <section className={`fb-card fb-focus__timer-card${paused ? ' fb-focus__timer-card--paused' : ''}`}>
        <div className="fb-focus__clock" role="timer" aria-label={session.untimed ? 'Time focused so far' : 'Time left'}>
          {formatClock(session.untimed ? Math.floor(clockMs(session, now) / 1000) * 1000 : clockMs(session, now))}
        </div>
        {session.untimed ? (
          <div className="fb-focus__progress-text">No end time. End the session when you are done.</div>
        ) : (
          <>
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
                disabled={session.strictness === 'pawfessor'}
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
          </>
        )}
      </section>

      {queue.length > 0 && (
        <section className="fb-card" aria-labelledby="focus-queue-title">
          <div className="fb-row fb-row--between">
            <h2 id="focus-queue-title" className="fb-card__title">Tasks</h2>
            <span className={`fb-pill${finished === queue.length ? ' fb-pill--ok' : ''}`}>{finished} / {queue.length} done</span>
          </div>
          {current ? (
            <div className="fb-focus__current">
              <div>
                <div className="fb-focus__current-label">Working on now</div>
                <div className="fb-focus__current-title">{current.icon ? `${current.icon} ` : ''}{current.title}</div>
              </div>
              <button type="button" className="fb-btn fb-btn--primary" onClick={() => finishTask(current)}>
                ✓ Done
              </button>
            </div>
          ) : (
            <p className="fb-focus__help">Every task of this session is done. Nice work.</p>
          )}
          <ol className="fb-focus__queue">
            {queue.map((task) => {
              const done = task.status === 'COMPLETED';
              const isCurrent = current && task.id === current.id;
              return (
                <li key={task.id} className={done ? 'fb-focus__queue-done' : undefined}>
                  <span className="fb-focus__queue-title">
                    {done ? '✓ ' : ''}{task.icon ? `${task.icon} ` : ''}{task.title}
                    {isCurrent && <span className="fb-pill"> Now</span>}
                  </span>
                  {!done && !isCurrent && (
                    <button
                      type="button"
                      className="fb-btn fb-btn--gray fb-btn--small"
                      onClick={() => window.api.focusSession.setTasks(playTask(queue, task.id))}
                      aria-label={`Work on ${task.title} now`}
                    >
                      Do this now
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
          {taskError && <p className="fb-focus__error" role="alert">{taskError}</p>}
        </section>
      )}

      <section className="fb-card">
        <dl className="fb-focus__facts">
          <dt>Focus Goal:</dt>
          <dd className={session.intention ? '' : 'fb-focus__muted'}>
            {session.intention || 'No goal set for this session'}
          </dd>
          <dt>Block list:</dt>
          <dd>{session.modeName || DEFAULT_MODE_NAME}</dd>
          {level && (
            <>
              <dt>Strictness:</dt>
              <dd>{level.label} ({level.hint.toLowerCase()})</dd>
            </>
          )}
        </dl>
        {!session.synced && (
          <p className="fb-focus__help">
            Focus Bear couldn&apos;t reach your account when this session started, so it won&apos;t show in your stats.
          </p>
        )}
        <div className="fb-row fb-focus__actions">
          {(canPause(session) || paused) && (
            <button type="button" className="fb-btn fb-btn--primary" onClick={pauseOrResume}>
              {paused ? 'Resume' : 'Pause'}
            </button>
          )}
          <button type="button" className="fb-btn fb-btn--gray" onClick={() => setStopAction('end')}>
            End Session
          </button>
        </div>
      </section>

      <section className="fb-card" aria-labelledby="focus-dump-title">
        <h2 id="focus-dump-title" className="fb-card__title">Brain dump</h2>
        <p className="fb-card__desc">Something else on your mind? Park it here and get back to work. It is added to your Brain Dump note.</p>
        <textarea
          className="fb-input fb-focus__goal"
          rows={2}
          value={dump}
          onChange={(e) => {
            setDump(e.target.value);
            setDumpState('idle');
          }}
          placeholder="Type the thought…"
          aria-labelledby="focus-dump-title"
          maxLength={2000}
        />
        <div className="fb-row" style={{ marginTop: 10 }}>
          <button type="button" className="fb-btn" onClick={saveDump} disabled={!dump.trim() || dumpState === 'saving'}>
            {dumpState === 'saving' ? 'Saving…' : 'Save to Brain Dump'}
          </button>
          <span className="fb-focus__help" role="status" style={{ margin: 0 }}>
            {dumpState === 'saved' && 'Saved. You can read it later under Notes.'}
            {dumpState === 'error' && "Couldn't save that. Check your connection and try again."}
          </span>
        </div>
      </section>

      {stopAction && (
        <StopDialog session={session} action={stopAction} onConfirm={confirmStop} onCancel={() => setStopAction(null)} />
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
  const queue = Array.isArray(session.tasks) ? session.tasks : [];
  const finished = doneTasks(queue);

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
            {session.endedEarly && !session.untimed
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
            <div className="fb-focus__metric-value">{session.untimed ? 'No end time' : formatDuration(totalMs(session))}</div>
            <div className="fb-focus__metric-label">Planned Time</div>
          </div>
          <div className="fb-focus__metric">
            <div className="fb-focus__metric-value">{formatDuration(session.pausedTotalMs)}</div>
            <div className="fb-focus__metric-label">Time Paused</div>
          </div>
          {queue.length > 0 && (
            <div className="fb-focus__metric">
              <div className="fb-focus__metric-value">{finished.length} / {queue.length}</div>
              <div className="fb-focus__metric-label">Tasks Done</div>
            </div>
          )}
        </div>
        {queue.length > 0 && (
          <ol className="fb-focus__queue">
            {queue.map((task) => (
              <li key={task.id} className={task.status === 'COMPLETED' ? 'fb-focus__queue-done' : undefined}>
                <span className="fb-focus__queue-title">
                  {task.status === 'COMPLETED' ? '✓ ' : ''}{task.icon ? `${task.icon} ` : ''}{task.title}
                </span>
                {task.status !== 'COMPLETED' && <span className="fb-focus__muted">Not finished</span>}
              </li>
            ))}
          </ol>
        )}
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

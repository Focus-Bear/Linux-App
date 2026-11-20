import { useCallback, useEffect, useMemo, useState } from 'react';
import './styles/distracting-sites.css'; // shared .fb-input
import './styles/day-plan.css';
import { dayPlanApi } from '../services/dayPlanApi.js';
import { habitPlayer, reportHabit, useHabitPlayer } from '../services/habitPlayerStore.js';
import { currentHabit } from '../services/habitPlayerModel.js';
import { postponeStore, usePostpone } from '../services/postponeStore.js';
import { useSyncedState } from '../services/sync.js';
import HabitPlayer from './habit-player.jsx';
import QuantityDialog from './quantity-dialog.jsx';
import {
  buildTimeline,
  dayKey,
  formatSpan,
  formatTime,
  minutesOfDay,
  remainingTaskSeconds,
  tasksForDay,
  timeRange,
} from '../services/dayPlanModel.js';
import {
  POSTPONE_CHOICES,
  dayDate,
  dayLabel,
  defaultEventEnd,
  defaultEventStart,
  eventError,
  focusBlockNote,
  isPostponed,
  postponeLabel,
  shiftDay,
} from '../services/dayPlanExtras.js';

const SAVE_FAILED = "Couldn't save that. Check your connection and try again.";

function timezoneName() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The form behind "Add event": a name and a start and end time on the day shown. */
function AddEventForm({ day, isToday, onAdded, onCancel }) {
  const [title, setTitle] = useState('');
  const [start, setStart] = useState(() => defaultEventStart(new Date(), isToday));
  const [end, setEnd] = useState(() => defaultEventEnd(defaultEventStart(new Date(), isToday)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    const problem = eventError({ title, start, end });
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await dayPlanApi.addEvent({ title, start, end }, day, timezoneName());
      onAdded(created);
    } catch (err) {
      console.error('[DayPlan] Could not add the event:', err);
      setError("Couldn't add that event. Check your connection and try again.");
      setBusy(false);
    }
  };

  return (
    <form className="fb-dayplan__event-form" onSubmit={submit} aria-label="Add an event">
      <input
        className="fb-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Event name"
        aria-label="Event name"
        maxLength={255}
        autoFocus
      />
      <div className="fb-dayplan__event-times">
        <label>
          From
          <input
            className="fb-input"
            type="time"
            value={start}
            onChange={(e) => {
              setStart(e.target.value);
              setEnd(defaultEventEnd(e.target.value));
            }}
            required
          />
        </label>
        <label>
          Till
          <input className="fb-input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} required />
        </label>
      </div>
      {error && <p className="fb-dayplan__error" role="alert">{error}</p>}
      <div className="fb-row">
        <button type="submit" className="fb-btn fb-btn--primary" disabled={busy}>{busy ? 'Adding…' : 'Add event'}</button>
        <button type="button" className="fb-btn fb-btn--gray" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * MAIN > Day Plan. A day's routines and habits, meetings, your own events and
 * focus blocks on a timeline, with the day's tasks beside it, like the Windows
 * Day Plan (Habits/HabitsDayPlan.xaml). Today's habits can be started (the
 * habit player takes over the page), marked done or skipped; a routine can be
 * postponed or skipped for today. Other days are a preview.
 */
export default function DayPlanPage({ onOpenTodoList, onEditHabits, onStartFocus }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [now, setNow] = useState(() => new Date());
  // The day shown; null = today (so the page follows midnight).
  const [viewDay, setViewDay] = useState(null);
  // Task changes made here, shown before (and kept if) the reload returns them.
  const [overrides, setOverrides] = useState({});
  const [added, setAdded] = useState([]);
  const [newTitle, setNewTitle] = useState('');
  const [taskError, setTaskError] = useState(null);
  const [habitError, setHabitError] = useState(null);
  const [busyHabits, setBusyHabits] = useState(() => new Set());
  const [busyRoutine, setBusyRoutine] = useState(null);
  const [postponeFor, setPostponeFor] = useState(null); // card id whose postpone choices are open
  const [askQuantity, setAskQuantity] = useState(null); // habit being marked done that asks a question
  const [addingEvent, setAddingEvent] = useState(false);
  // The player covers the page while a routine is played; "‹ Day Plan" hides it.
  const [playerOpen, setPlayerOpen] = useState(true);
  const { player, failed, version, outcomes, outcomesDay } = useHabitPlayer();
  const postponed = usePostpone();
  const [breaksEnabled] = useSyncedState('breaksEnabled');

  const today = dayKey(now);
  const day = viewDay || today;
  const isToday = day === today;

  const load = useCallback(async () => {
    setStatus((current) => (current === 'ready' ? 'ready' : 'loading'));
    try {
      const result = await dayPlanApi.loadDay(day, -new Date().getTimezoneOffset());
      setData(result);
      setAdded([]);
      setStatus('ready');
    } catch (error) {
      console.error('[DayPlan] Could not load the day:', error);
      setStatus((current) => (current === 'ready' ? 'ready' : 'error'));
    }
  }, [day]);

  // `version` changes each time a habit is reported, so the day's progress is read again.
  useEffect(() => {
    load();
  }, [load, version]);

  // Keep "now" fresh so finished meetings drop off and the current card moves.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  const goTo = (target) => {
    setViewDay(target === today ? null : target);
    setData(null);
    setStatus('loading');
    setAddingEvent(false);
    setPostponeFor(null);
    setHabitError(null);
    setTaskError(null);
  };

  // What is on screen belongs to the day shown (not the one being left).
  const shown = data && data.day === day ? data : null;

  const cards = useMemo(
    () =>
      shown
        ? buildTimeline({
            settings: shown.settings,
            progress: shown.progress,
            events: shown.events,
            planEvents: shown.planEvents,
            day,
            weekday: dayDate(day).getDay(),
            nowMinutes: isToday ? minutesOfDay(now) : null,
            local: isToday && outcomesDay === day ? outcomes : null,
            // Focus blocks are a plan: today's remaining time and the days ahead.
            withFocusBlocks: day >= today,
            breakMinutes: breaksEnabled ? Number(shown.settings?.break_after_minutes) || 0 : 0,
          })
        : [],
    [shown, day, today, isToday, now, outcomes, outcomesDay, breaksEnabled],
  );

  const playHabit = (card, habitId = null) => {
    setHabitError(null);
    if (isPostponed(postponed, card.id, Date.now())) postponeStore.clear();
    if (habitPlayer.start(card, habitId)) setPlayerOpen(true);
  };

  // Done / Skip on a row, without playing the habit. Done logs the habit's
  // planned length, as the Windows Day Plan does.
  const markHabit = async (habit, outcome, answers = []) => {
    if (busyHabits.has(habit.id)) return;
    if (outcome === 'done' && habit.questions?.length > 0 && askQuantity?.id !== habit.id) {
      setAskQuantity(habit);
      return;
    }
    setAskQuantity(null);
    setHabitError(null);
    setBusyHabits((prev) => new Set(prev).add(habit.id));
    const finishMs = Date.now();
    const timing =
      outcome === 'done' ? { startMs: finishMs - habit.seconds * 1000, finishMs, seconds: habit.seconds, answers } : null;
    try {
      await reportHabit(habit, timing);
    } catch {
      habitPlayer.clearFailed();
      setHabitError(`Couldn't save "${habit.name}". Check your connection and try again.`);
    } finally {
      setBusyHabits((prev) => {
        const next = new Set(prev);
        next.delete(habit.id);
        return next;
      });
    }
  };

  // "Skip for today" on a routine, and its undo.
  const setRoutineSkipped = async (card, skipped) => {
    const sequenceId = card.sequenceId || card.habits?.[0]?.sequenceId;
    if (!sequenceId || busyRoutine) return;
    setBusyRoutine(card.id);
    setHabitError(null);
    try {
      if (skipped) await dayPlanApi.skipRoutine(sequenceId);
      else await dayPlanApi.undoSkipRoutine(sequenceId);
      if (skipped && isPostponed(postponed, card.id, Date.now())) postponeStore.clear();
      await load();
    } catch (error) {
      console.error('[DayPlan] Could not change the routine:', error);
      setHabitError(`Couldn't ${skipped ? 'skip' : 'bring back'} "${card.title}". Check your connection and try again.`);
    } finally {
      setBusyRoutine(null);
    }
  };

  const postpone = (card, minutes) => {
    postponeStore.postpone(card, minutes);
    setPostponeFor(null);
    if (player && player.routine.id === card.id) habitPlayer.close();
  };

  const deleteEvent = async (card) => {
    if (!card.sourceId) return;
    setHabitError(null);
    setData((prev) => (prev ? { ...prev, planEvents: prev.planEvents.filter((event) => event.id !== card.sourceId) } : prev));
    try {
      await dayPlanApi.deleteEvent(card.sourceId);
    } catch (error) {
      console.error('[DayPlan] Could not delete the event:', error);
      setHabitError(`Couldn't delete "${card.title}". Check your connection and try again.`);
      load();
    }
  };

  const tasks = useMemo(() => {
    if (!shown) return [];
    const merged = [...shown.tasks, ...added].map((task) =>
      task.id in overrides ? { ...task, status: overrides[task.id] ? 'COMPLETED' : 'NOT_STARTED' } : task,
    );
    return tasksForDay(merged, day, today);
  }, [shown, added, overrides, day, today]);

  const toggleTask = async (task) => {
    const completed = !task.completed;
    setTaskError(null);
    setOverrides((prev) => ({ ...prev, [task.id]: completed }));
    try {
      await dayPlanApi.setTaskCompleted(task, completed);
    } catch (error) {
      console.error('[DayPlan] Could not update the task:', error);
      setOverrides((prev) => ({ ...prev, [task.id]: !completed }));
      setTaskError(SAVE_FAILED);
    }
  };

  const addTask = async (event) => {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    setTaskError(null);
    try {
      const created = await dayPlanApi.addTask(title, day);
      if (created?.id) setAdded((prev) => [...prev, created]);
      setNewTitle('');
    } catch (error) {
      console.error('[DayPlan] Could not add the task:', error);
      setTaskError("Couldn't add that task. Check your connection and try again.");
    }
  };

  const left = remainingTaskSeconds(tasks);
  const openCount = tasks.filter((task) => !task.completed).length;

  if (player && playerOpen) {
    return (
      <HabitPlayer
        player={player}
        failed={failed}
        onBack={() => setPlayerOpen(false)}
        onPostpone={(minutes) => {
          const card = cards.find((item) => item.id === player.routine.id) || { id: player.routine.id, title: player.routine.title };
          postpone(card, minutes);
        }}
      />
    );
  }

  const playing = player && player.phase !== 'finished' ? currentHabit(player) : null;
  const dayName = isToday ? 'today' : dayLabel(day, today).split(' · ').pop();

  return (
    <div className="fb-page fb-dayplan">
      <div className="fb-row fb-row--between fb-dayplan__header">
        <div>
          <h1 className="fb-page__title">Day Plan</h1>
          <p className="fb-page__subtitle" style={{ marginBottom: 0 }}>
            {dayLabel(day, today)}{isToday ? ` · ${formatTime(minutesOfDay(now))}` : ''}
          </p>
        </div>
        <div className="fb-row fb-dayplan__nav">
          <button type="button" className="fb-btn fb-btn--gray fb-btn--small" onClick={() => goTo(shiftDay(day, -1))} aria-label="Previous day">
            ‹
          </button>
          {!isToday && (
            <button type="button" className="fb-btn fb-btn--small" onClick={() => goTo(today)}>Today</button>
          )}
          <button type="button" className="fb-btn fb-btn--gray fb-btn--small" onClick={() => goTo(shiftDay(day, 1))} aria-label="Next day">
            ›
          </button>
          <button type="button" className="fb-btn fb-btn--gray fb-btn--small" onClick={load} disabled={status === 'loading'}>
            Refresh
          </button>
        </div>
      </div>

      {player && (
        <section className="fb-card fb-dayplan__playing" aria-label="Routine in progress">
          <span className="fb-dayplan__icon" aria-hidden="true">{playing?.icon || '✅'}</span>
          <span className="fb-dayplan__playing-text">
            <strong>{player.routine.title}</strong>
            {playing
              ? ` · ${playing.name}${player.phase === 'running' ? '' : ' is next'}`
              : ' · finished'}
          </span>
          <button type="button" className="fb-btn fb-btn--primary fb-btn--small" onClick={() => setPlayerOpen(true)}>
            {playing ? 'Back to habit' : 'See summary'}
          </button>
        </section>
      )}

      {status === 'loading' && <p className="fb-dayplan__note" role="status">Loading your day…</p>}

      {status === 'error' && (
        <section className="fb-card" role="alert">
          <h2 className="fb-card__title">Your day couldn&apos;t be loaded</h2>
          <p className="fb-card__desc">Check your internet connection, then try again.</p>
          <button type="button" className="fb-btn fb-btn--primary" onClick={load}>Try again</button>
        </section>
      )}

      {status === 'ready' && shown && (
        <div className="fb-dayplan__columns">
          <section className="fb-dayplan__timeline" aria-label={`Timeline for ${dayName}`}>
            {!isToday && (
              <p className="fb-dayplan__note">
                {day > today
                  ? 'A preview of this day. Habits can be started and marked on the day itself.'
                  : 'How this day went. Habits can only be marked on the day itself.'}
              </p>
            )}

            {cards.length === 0 && (
              <div className="fb-card">
                <p className="fb-card__desc" style={{ marginBottom: 12 }}>
                  Nothing scheduled for this day. Add habits to your morning or evening routine to see them here.
                </p>
                <button type="button" className="fb-btn" onClick={onEditHabits}>Edit Habits</button>
              </div>
            )}

            {cards.map((card) => {
              const waiting = card.habits && isToday && isPostponed(postponed, card.id, now.getTime());
              return (
                <article
                  key={card.id}
                  className={`fb-dayplan__card fb-dayplan__card--${card.kind}${card.current ? ' fb-dayplan__card--current' : ''}${card.past ? ' fb-dayplan__card--past' : ''}`}
                >
                  <header className="fb-dayplan__card-head">
                    <span className="fb-dayplan__time">{timeRange(card)}</span>
                    <span className="fb-dayplan__icon" aria-hidden="true">{card.icon}</span>
                    <h2 className="fb-dayplan__card-title">{card.title}</h2>
                    {card.current && <span className="fb-pill fb-dayplan__now">Now</span>}
                    {card.kind === 'focus' && <span className="fb-dayplan__span">{focusBlockNote(card)}</span>}
                    {card.kind === 'focus' && isToday && card.current && onStartFocus && (
                      <button type="button" className="fb-btn fb-btn--primary fb-btn--small" onClick={onStartFocus}>
                        Start focus session
                      </button>
                    )}
                    {card.kind === 'event' && card.sourceId && (
                      <button
                        type="button"
                        className="fb-btn fb-btn--gray fb-btn--small"
                        onClick={() => deleteEvent(card)}
                        aria-label={`Delete ${card.title}`}
                      >
                        Delete
                      </button>
                    )}
                    {card.habits && card.cancelled && <span className="fb-pill">Skipped for today</span>}
                    {card.habits && card.cancelled && isToday && (
                      <button
                        type="button"
                        className="fb-btn fb-btn--small"
                        onClick={() => setRoutineSkipped(card, false)}
                        disabled={busyRoutine === card.id}
                      >
                        Undo
                      </button>
                    )}
                    {card.habits && !card.cancelled && card.allDone && <span className="fb-pill fb-pill--ok">✅ Habits done</span>}
                    {waiting && <span className="fb-pill">{postponeLabel(postponed)}</span>}
                    {card.habits && isToday && !card.cancelled && !card.allDone && !player && (
                      <button type="button" className="fb-btn fb-btn--primary fb-btn--small" onClick={() => playHabit(card)}>
                        {card.openCount === card.habits.length ? 'Start routine now' : 'Continue routine'}
                      </button>
                    )}
                  </header>

                  {card.habits && isToday && !card.cancelled && !card.allDone && (
                    <div className="fb-dayplan__routine-actions">
                      {postponeFor === card.id ? (
                        <span className="fb-row" role="group" aria-label={`Postpone ${card.title} by`}>
                          <span className="fb-dayplan__span">Remind me in</span>
                          {POSTPONE_CHOICES.map((minutes) => (
                            <button key={minutes} type="button" className="fb-btn fb-btn--small" onClick={() => postpone(card, minutes)}>
                              {minutes} min
                            </button>
                          ))}
                          <button type="button" className="fb-btn fb-btn--gray fb-btn--small" onClick={() => setPostponeFor(null)}>Cancel</button>
                        </span>
                      ) : (
                        <>
                          <button type="button" className="fb-dayplan__link" onClick={() => setPostponeFor(card.id)}>
                            {waiting ? 'Postpone again' : 'Postpone'}
                          </button>
                          {waiting && (
                            <button type="button" className="fb-dayplan__link" onClick={() => postponeStore.clear()}>Cancel the reminder</button>
                          )}
                          <button
                            type="button"
                            className="fb-dayplan__link"
                            onClick={() => setRoutineSkipped(card, true)}
                            disabled={busyRoutine === card.id || Boolean(player)}
                          >
                            Skip routine for today
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  {card.habits && (
                    <ul className="fb-dayplan__habits">
                      {card.habits.map((habit) => (
                        <li
                          key={habit.id}
                          className={`fb-dayplan__habit${habit.done ? ' fb-dayplan__habit--done' : ''}${habit.skipped ? ' fb-dayplan__habit--skipped' : ''}`}
                        >
                          <span className="fb-dayplan__time">{timeRange(habit)}</span>
                          <span className="fb-dayplan__icon" aria-hidden="true">{habit.icon}</span>
                          <span className="fb-dayplan__habit-name">
                            {habit.name}
                            {habit.done && <span className="fb-dayplan__sr"> (done)</span>}
                            {habit.skipped && <span className="fb-dayplan__sr"> (skipped)</span>}
                          </span>
                          <span className="fb-dayplan__span">{formatSpan(habit.seconds)}</span>
                          {habit.done && <span className="fb-dayplan__state fb-dayplan__state--done" aria-hidden="true">✓ Done</span>}
                          {habit.skipped && <span className="fb-dayplan__state" aria-hidden="true">Skipped</span>}
                          {isToday && !card.cancelled && !habit.done && !habit.skipped && (
                            <span className="fb-dayplan__habit-actions">
                              <button
                                type="button"
                                className="fb-btn fb-btn--small"
                                onClick={() => playHabit(card, habit.id)}
                                disabled={Boolean(player) || busyHabits.has(habit.id)}
                                aria-label={`Start ${habit.name}`}
                                title="Start this habit"
                              >
                                ▶ Start
                              </button>
                              <button
                                type="button"
                                className="fb-btn fb-btn--small"
                                onClick={() => markHabit(habit, 'done')}
                                disabled={busyHabits.has(habit.id) || playing?.id === habit.id}
                                aria-label={`Mark ${habit.name} done`}
                              >
                                Done
                              </button>
                              <button
                                type="button"
                                className="fb-btn fb-btn--gray fb-btn--small"
                                onClick={() => markHabit(habit, 'skipped')}
                                disabled={busyHabits.has(habit.id) || playing?.id === habit.id}
                                aria-label={`Skip ${habit.name} for today`}
                              >
                                Skip
                              </button>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              );
            })}

            {habitError && <p className="fb-dayplan__error" role="alert">{habitError}</p>}

            {shown.failed?.includes('meetings') && (
              <p className="fb-dayplan__note">Your calendar couldn&apos;t be reached, so meetings are missing.</p>
            )}
            {shown.failed?.includes('events') && (
              <p className="fb-dayplan__note">Your own events couldn&apos;t be loaded.</p>
            )}
          </section>

          <aside className="fb-card fb-dayplan__tasks" aria-labelledby="dayplan-tasks-title">
            <h2 id="dayplan-tasks-title" className="fb-card__title">Tasks for {dayName}</h2>
            <p className="fb-card__desc">
              {openCount === 0 ? 'Nothing left to do.' : `≈ ${formatSpan(left)} of tasks to do`}
            </p>

            {shown.failed?.includes('tasks') && (
              <p className="fb-dayplan__note" role="alert">Your tasks couldn&apos;t be loaded.</p>
            )}

            {tasks.length === 0 && !shown.failed?.includes('tasks') && (
              <p className="fb-dayplan__note">No tasks yet. Add one below or from your to-do list.</p>
            )}

            <ul className="fb-dayplan__task-list">
              {tasks.map((task) => (
                <li key={task.id} className={`fb-dayplan__task${task.completed ? ' fb-dayplan__task--done' : ''}`}>
                  <label>
                    <input type="checkbox" checked={task.completed} onChange={() => toggleTask(task)} />
                    <span className="fb-dayplan__task-text">
                      <span className="fb-dayplan__task-title">{task.title}</span>
                      <span className="fb-dayplan__task-meta">
                        {task.seconds > 0 && formatSpan(task.seconds)}
                        {task.overdue && !task.completed && <span className="fb-dayplan__overdue">Overdue</span>}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>

            {taskError && <p className="fb-dayplan__error" role="alert">{taskError}</p>}

            <form className="fb-dayplan__add" onSubmit={addTask}>
              <input
                className="fb-input"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder={`Add a task for ${dayName}`}
                aria-label={`Add a task for ${dayName}`}
                maxLength={255}
              />
              <button type="submit" className="fb-btn fb-btn--primary" disabled={!newTitle.trim()}>
                Add task
              </button>
            </form>
            <button type="button" className="fb-btn fb-btn--block fb-dayplan__todo" onClick={onOpenTodoList}>
              From to-do list
            </button>

            {addingEvent ? (
              <AddEventForm
                day={day}
                isToday={isToday}
                onCancel={() => setAddingEvent(false)}
                onAdded={(created) => {
                  setAddingEvent(false);
                  if (created) setData((prev) => (prev ? { ...prev, planEvents: [...prev.planEvents, created] } : prev));
                  else load();
                }}
              />
            ) : (
              <button type="button" className="fb-btn fb-btn--block fb-dayplan__todo" onClick={() => setAddingEvent(true)}>
                Add event
              </button>
            )}
          </aside>
        </div>
      )}

      {askQuantity && (
        <QuantityDialog
          habit={askQuantity}
          onSubmit={(answers) => markHabit(askQuantity, 'done', answers)}
          onCancel={() => setAskQuantity(null)}
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import './styles/distracting-sites.css'; // shared .fb-input
import './styles/day-plan.css';
import { dayPlanApi } from '../services/dayPlanApi.js';
import {
  buildTimeline,
  dayKey,
  formatDay,
  formatSpan,
  formatTime,
  minutesOfDay,
  remainingTaskSeconds,
  tasksForDay,
  timeRange,
} from '../services/dayPlanModel.js';

/**
 * MAIN > Day Plan. Today's routines and habits and meetings on a timeline,
 * with "Tasks for today" beside it, like the Windows Day Plan
 * (Habits/HabitsDayPlan.xaml). Habits are read-only here; tasks can be ticked
 * off and added.
 */
export default function DayPlanPage({ onOpenTodoList, onEditHabits }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [now, setNow] = useState(() => new Date());
  // Task changes made here, shown before (and kept if) the reload returns them.
  const [overrides, setOverrides] = useState({});
  const [added, setAdded] = useState([]);
  const [newTitle, setNewTitle] = useState('');
  const [taskError, setTaskError] = useState(null);

  const day = dayKey(now);

  const load = useCallback(async () => {
    setStatus((current) => (current === 'ready' ? 'ready' : 'loading'));
    try {
      const today = new Date();
      const result = await dayPlanApi.loadDay(dayKey(today), -today.getTimezoneOffset());
      setData(result);
      setAdded([]);
      setStatus('ready');
    } catch (error) {
      console.error('[DayPlan] Could not load the day:', error);
      setStatus((current) => (current === 'ready' ? 'ready' : 'error'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, day]);

  // Keep "now" fresh so finished meetings drop off and the current card moves.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  const cards = useMemo(
    () =>
      data
        ? buildTimeline({
            settings: data.settings,
            progress: data.progress,
            events: data.events,
            day,
            weekday: now.getDay(),
            nowMinutes: minutesOfDay(now),
          })
        : [],
    [data, day, now],
  );

  const tasks = useMemo(() => {
    if (!data) return [];
    const merged = [...data.tasks, ...added].map((task) =>
      task.id in overrides ? { ...task, status: overrides[task.id] ? 'COMPLETED' : 'NOT_STARTED' } : task,
    );
    return tasksForDay(merged, day);
  }, [data, added, overrides, day]);

  const toggleTask = async (task) => {
    const completed = !task.completed;
    setTaskError(null);
    setOverrides((prev) => ({ ...prev, [task.id]: completed }));
    try {
      await dayPlanApi.setTaskCompleted(task, completed);
    } catch (error) {
      console.error('[DayPlan] Could not update the task:', error);
      setOverrides((prev) => ({ ...prev, [task.id]: !completed }));
      setTaskError("Couldn't save that. Check your connection and try again.");
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

  return (
    <div className="fb-page fb-dayplan">
      <div className="fb-row fb-row--between fb-dayplan__header">
        <div>
          <h1 className="fb-page__title">Day Plan</h1>
          <p className="fb-page__subtitle" style={{ marginBottom: 0 }}>
            Today · {formatDay(now)} · {formatTime(minutesOfDay(now))}
          </p>
        </div>
        <button type="button" className="fb-btn fb-btn--gray fb-btn--small" onClick={load} disabled={status === 'loading'}>
          Refresh
        </button>
      </div>

      {status === 'loading' && <p className="fb-dayplan__note" role="status">Loading your day…</p>}

      {status === 'error' && (
        <section className="fb-card" role="alert">
          <h2 className="fb-card__title">Your day couldn&apos;t be loaded</h2>
          <p className="fb-card__desc">Check your internet connection, then try again.</p>
          <button type="button" className="fb-btn fb-btn--primary" onClick={load}>Try again</button>
        </section>
      )}

      {status === 'ready' && (
        <div className="fb-dayplan__columns">
          <section className="fb-dayplan__timeline" aria-label="Today's timeline">
            {cards.length === 0 && (
              <div className="fb-card">
                <p className="fb-card__desc" style={{ marginBottom: 12 }}>
                  Nothing scheduled for this day. Add habits to your morning or evening routine to see them here.
                </p>
                <button type="button" className="fb-btn" onClick={onEditHabits}>Edit Habits</button>
              </div>
            )}

            {cards.map((card) => (
              <article
                key={card.id}
                className={`fb-dayplan__card fb-dayplan__card--${card.kind}${card.current ? ' fb-dayplan__card--current' : ''}${card.past ? ' fb-dayplan__card--past' : ''}`}
              >
                <header className="fb-dayplan__card-head">
                  <span className="fb-dayplan__time">{timeRange(card)}</span>
                  <span className="fb-dayplan__icon" aria-hidden="true">{card.icon}</span>
                  <h2 className="fb-dayplan__card-title">{card.title}</h2>
                  {card.current && <span className="fb-pill fb-dayplan__now">Now</span>}
                  {card.habits && card.allDone && <span className="fb-pill fb-pill--ok">✅ Habits done</span>}
                </header>

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
                          {habit.skipped && ' · skipped'}
                        </span>
                        <span className="fb-dayplan__span">{formatSpan(habit.seconds)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ))}

            {data?.failed?.includes('meetings') && (
              <p className="fb-dayplan__note">Your calendar couldn&apos;t be reached, so meetings are missing.</p>
            )}
          </section>

          <aside className="fb-card fb-dayplan__tasks" aria-labelledby="dayplan-tasks-title">
            <h2 id="dayplan-tasks-title" className="fb-card__title">Tasks for today</h2>
            <p className="fb-card__desc">
              {openCount === 0 ? 'Nothing left to do.' : `≈ ${formatSpan(left)} of tasks to do`}
            </p>

            {data?.failed?.includes('tasks') && (
              <p className="fb-dayplan__note" role="alert">Your tasks couldn&apos;t be loaded.</p>
            )}

            {tasks.length === 0 && !data?.failed?.includes('tasks') && (
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
                placeholder="Add a task for today"
                aria-label="Add a task for today"
                maxLength={255}
              />
              <button type="submit" className="fb-btn fb-btn--primary" disabled={!newTitle.trim()}>
                Add task
              </button>
            </form>
            <button type="button" className="fb-btn fb-btn--block fb-dayplan__todo" onClick={onOpenTodoList}>
              From to-do list
            </button>
          </aside>
        </div>
      )}
    </div>
  );
}

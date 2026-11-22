import { useEffect, useState } from 'react';
import './styles/distracting-sites.css'; // shared .fb-input and .fb-dialog
import './styles/blocking.css';
import { blockingStore } from '../services/blockingStore.js';
import { SCHEDULE_LOCKED } from '../electron/blockingModel.js';
import {
  DAY_FULL_NAMES,
  DAY_LETTERS,
  DAY_ORDER,
  EVERY_DAY,
  MAX_LIST_NAME,
  WEEKDAYS,
  WEEKEND,
  daysSummary,
  isScheduleActive,
  overlappingSchedules,
  scheduleDays,
  scheduleDraft,
  scheduleError,
  timeSummary,
  timeToMinutes,
  visibleLists,
} from '../electron/blockingModel.js';

const PRESETS = [
  ['Weekdays', WEEKDAYS],
  ['Weekends', WEEKEND],
  ['Everyday', EVERY_DAY],
];

/**
 * Blocking > Blocking Schedule. The account's blocking schedules, shared with
 * the Windows and Mac apps (Preferences/BlockingSchedules): at the chosen days
 * and times the chosen block list is in force, without starting a focus session.
 * `blocking` is the shell's blocking state (see useBlocking.js).
 */
export default function BlockingSchedule({ blocking, onEditBlockLists }) {
  const { status, modes, schedules, error, inForce, locks } = blocking;
  const [editing, setEditing] = useState(null); // null | { schedule: object | null }
  // A strict schedule that is running can't be edited or deleted until it ends
  // (the change would lift it on every device).
  const isLocked = (schedule) => Boolean(schedule && locks?.scheduleIds?.has(schedule.id));
  const lists = visibleLists(modes);
  const listName = (id) => modes.find((mode) => mode.id === id)?.name || 'a deleted block list';
  const now = new Date();

  useEffect(() => {
    blockingStore.load();
  }, []);

  return (
    <div className="fb-page fb-blocking">
      <div className="fb-row fb-row--between">
        <h1 className="fb-page__title">Blocking Schedule</h1>
        {status === 'ready' && schedules.length > 0 && (
          <button type="button" className="fb-btn fb-btn--primary fb-btn--small" onClick={() => setEditing({ schedule: null })}>
            Add new block
          </button>
        )}
      </div>
      <p className="fb-page__subtitle">
        Block distractions at set times, without starting a focus session. Each schedule uses one of your block lists.
      </p>

      {error && (
        <p className="fb-blocking__error" role="alert">
          {error}{' '}
          <button type="button" className="fb-blocking__link" onClick={() => blockingStore.clearError()}>Dismiss</button>
        </p>
      )}

      {status === 'loading' && <p className="fb-card__desc" role="status">Loading your blocking schedules…</p>}

      {status === 'error' && (
        <section className="fb-card" role="alert">
          <h2 className="fb-card__title">Your blocking schedules couldn&apos;t be loaded</h2>
          <p className="fb-card__desc">Check your internet connection, then try again.</p>
          <button type="button" className="fb-btn fb-btn--primary" onClick={() => blockingStore.load()}>Try again</button>
        </section>
      )}

      {status === 'ready' && schedules.length === 0 && (
        <section className="fb-card">
          <h2 className="fb-card__title">No blocking schedules yet</h2>
          <p className="fb-card__desc">
            For example: block social media on weekdays from 09:00 to 17:00, or everything except your study sites in the
            evening.
          </p>
          <button type="button" className="fb-btn fb-btn--primary" onClick={() => setEditing({ schedule: null })}>
            Add a schedule
          </button>
        </section>
      )}

      {status === 'ready' && schedules.length > 0 && (
        <section className="fb-card" aria-label="Blocking schedules">
          {schedules.map((schedule) => {
            const active = isScheduleActive(schedule, now);
            const governs = inForce.schedule?.id === schedule.id;
            return (
              <div key={schedule.id} className={`fb-schedule${active ? ' fb-schedule--active' : ''}`}>
                <div className="fb-schedule__text">
                  <div className="fb-schedule__name">
                    {schedule.emoji ? `${schedule.emoji} ` : ''}{schedule.name}
                  </div>
                  <div className="fb-schedule__meta">
                    {daysSummary(scheduleDays(schedule))} · {timeSummary(schedule)} · {listName(schedule.focus_mode_id)}
                  </div>
                </div>
                {active && (
                  <span className="fb-pill fb-pill--ok">{governs ? 'Blocking now' : 'On now'}</span>
                )}
                <button
                  type="button"
                  className="fb-btn fb-btn--gray fb-btn--small"
                  onClick={() => setEditing({ schedule })}
                  aria-label={`Edit ${schedule.name}`}
                  disabled={isLocked(schedule)}
                  title={isLocked(schedule) ? SCHEDULE_LOCKED : undefined}
                >
                  {isLocked(schedule) ? 'Locked' : 'Edit'}
                </button>
              </div>
            );
          })}
        </section>
      )}

      {status === 'ready' && (
        <button type="button" className="fb-btn fb-blocking__gap" onClick={onEditBlockLists}>
          Edit block lists
        </button>
      )}

      {editing && (
        <ScheduleDialog
          schedule={editing.schedule}
          schedules={schedules}
          lists={lists}
          running={Boolean(editing.schedule) && isScheduleActive(editing.schedule, now)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ScheduleDialog({ schedule, schedules, lists, running, onClose }) {
  const [draft, setDraft] = useState(() => scheduleDraft(schedule, lists[0]?.id || ''));
  const [error, setError] = useState(null);
  const [overlap, setOverlap] = useState(null); // names the draft overlaps, once the user was told
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const change = (patch) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setError(null);
    setOverlap(null);
  };

  const toggleDay = (day) =>
    change({ days: draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day] });

  const start = timeToMinutes(draft.start);
  const end = timeToMinutes(draft.end);
  const overnight = start !== null && end !== null && end < start;

  const save = async (event) => {
    event.preventDefault();
    const problem = scheduleError(draft);
    if (problem) {
      setError(problem);
      return;
    }
    // Told once; pressing "Save Anyway" saves.
    if (!overlap) {
      const names = overlappingSchedules(draft, schedules, schedule?.id || null);
      if (names.length > 0) {
        setOverlap(names);
        return;
      }
    }
    setBusy(true);
    const saved = await blockingStore.saveSchedule(draft, schedule);
    if (saved) {
      onClose();
      return;
    }
    setBusy(false);
    setError("Couldn't save that. Check your connection and try again.");
  };

  const remove = async () => {
    setBusy(true);
    await blockingStore.deleteSchedule(schedule.id);
    onClose();
  };

  return (
    <div className="fb-dialog-overlay" onClick={onClose}>
      <form
        className="fb-dialog fb-schedule-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
        onSubmit={save}
      >
        <div className="fb-dialog__header">
          <h2 id="schedule-title">{schedule ? 'Edit blocking schedule' : 'Add a schedule'}</h2>
        </div>

        <div className="fb-dialog__body">
          <label className="fb-blocking__label" htmlFor="schedule-name">Block name</label>
          <input
            id="schedule-name"
            className="fb-input"
            value={draft.name}
            maxLength={MAX_LIST_NAME}
            placeholder="e.g. Work hours"
            autoFocus
            onChange={(e) => change({ name: e.target.value })}
          />

          <div className="fb-blocking__label" id="schedule-days">Blocking schedule</div>
          <div className="fb-schedule__presets">
            {PRESETS.map(([label, days]) => (
              <button key={label} type="button" className="fb-btn fb-btn--gray fb-btn--small" onClick={() => change({ days: [...days] })}>
                {label}
              </button>
            ))}
          </div>
          <div className="fb-schedule__days" role="group" aria-labelledby="schedule-days">
            {DAY_ORDER.map((day) => (
              <button
                key={day}
                type="button"
                className="fb-schedule__day"
                aria-pressed={draft.days.includes(day)}
                aria-label={DAY_FULL_NAMES[day]}
                title={DAY_FULL_NAMES[day]}
                onClick={() => toggleDay(day)}
              >
                {DAY_LETTERS[day]}
              </button>
            ))}
          </div>

          <div className="fb-blocking__label">Active time</div>
          <div className="fb-schedule__times">
            <label>
              <span className="fb-schedule__hint">From </span>
              <input
                type="time"
                className="fb-input"
                value={draft.start}
                onChange={(e) => change({ start: e.target.value })}
                aria-label="From"
              />
            </label>
            <label>
              <span className="fb-schedule__hint">Till </span>
              <input
                type="time"
                className="fb-input"
                value={draft.end}
                onChange={(e) => change({ end: e.target.value })}
                aria-label="Till"
              />
            </label>
            {overnight && <span className="fb-schedule__hint">Ends the next day</span>}
          </div>

          <label className="fb-blocking__label" htmlFor="schedule-list">Block list</label>
          <select id="schedule-list" className="fb-input" value={draft.modeId} onChange={(e) => change({ modeId: e.target.value })}>
            {lists.length === 0 && <option value="">No block lists yet</option>}
            {lists.map((mode) => (
              <option key={mode.id} value={mode.id}>{mode.name}</option>
            ))}
          </select>

          {error && <p className="fb-dialog__error" role="alert">{error}</p>}
          {overlap && (
            <p className="fb-dialog__error" role="alert">
              Time Overlap Detected. This blocking schedule&apos;s time overlaps with {overlap.map((n) => `"${n}"`).join(', ')}.
              Do you want to save it anyway?
            </p>
          )}
          {confirmDelete && (
            <p className="fb-dialog__error" role="alert">
              {running
                ? 'This schedule is currently running. Are you sure you want to delete it? Blocking will stop immediately.'
                : 'Delete this schedule on all your devices?'}
            </p>
          )}
        </div>

        <div className="fb-dialog__footer">
          {schedule && !confirmDelete && (
            <button type="button" className="fb-btn fb-btn--danger" style={{ marginRight: 'auto' }} onClick={() => setConfirmDelete(true)} disabled={busy}>
              Delete
            </button>
          )}
          {confirmDelete ? (
            <>
              <button type="button" className="fb-btn fb-btn--gray" onClick={() => setConfirmDelete(false)} disabled={busy}>
                Keep it
              </button>
              <button type="button" className="fb-btn fb-btn--danger" onClick={remove} disabled={busy}>
                Delete schedule
              </button>
            </>
          ) : (
            <>
              <button type="button" className="fb-btn fb-btn--gray" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="submit" className="fb-btn fb-btn--primary" disabled={busy}>
                {busy ? 'Saving…' : overlap ? 'Save Anyway' : 'Save changes'}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

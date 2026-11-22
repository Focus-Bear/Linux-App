import { useEffect, useState } from 'react';
import './styles/distracting-sites.css'; // shared .fb-check
import './styles/focus-session.css'; // shared clock and progress bar
import './styles/habit-player.css';
import './styles/micro-break.css';
import { breakStore } from '../services/breakStore.js';
import { useSyncedState } from '../services/sync.js';
import {
  currentHabit,
  formatCountdown,
  habitProgress,
  isTimed,
  lastResult,
  remainingMs,
} from '../services/habitPlayerModel.js';
import { AUTO_START_SECONDS, breakSeconds, formatBreakLength, nextBreakLabel } from '../electron/breakModel.js';

const LOGO = `${import.meta.env.BASE_URL}bear-icon.png`;

/**
 * MAIN > Start Micro Break. The break itself, following the Windows break
 * screens (Habits/BreakStartView.cs and the break habit window):
 *   start    - "Time for a microbreak!", the habits of this break, Start Micro Break
 *   playing  - one break habit after another, each with its countdown
 *   finished - "Nice break."
 * `breaks` is the break store's state (see useBreaks.js).
 */
export default function MicroBreakPage({ breaks, onEditHabits, onOpenSettings, onLeave }) {
  const { player } = breaks;

  // Opening the page reads the break habits again (they are edited on the dashboard page).
  useEffect(() => {
    breakStore.load();
    // A break finished earlier and left open is not what "Start Micro Break" should show.
    breakStore.dismissFinished();
  }, []);

  if (player && player.phase === 'finished') return <BreakFinished breaks={breaks} onLeave={onLeave} />;
  if (player) return <BreakPlaying breaks={breaks} />;
  return <BreakStart breaks={breaks} onEditHabits={onEditHabits} onOpenSettings={onOpenSettings} onLeave={onLeave} />;
}

function BreakStart({ breaks, onEditHabits, onOpenSettings, onLeave }) {
  const { status, plan, due, nextAt } = breaks;
  const [enabled] = useSyncedState('breaksEnabled');
  const [autoStart, setAutoStart, autoLoading] = useSyncedState('breakAutoStart');
  const [countdown, setCountdown] = useState(null);

  // "Start breaks automatically": a break that came from the timer starts after 5 seconds.
  const auto = due && autoStart && !autoLoading && plan.play.length > 0;
  useEffect(() => {
    if (!auto) {
      setCountdown(null);
      return undefined;
    }
    const end = Date.now() + AUTO_START_SECONDS * 1000;
    setCountdown(AUTO_START_SECONDS);
    const timer = setInterval(() => {
      const left = Math.ceil((end - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(timer);
        breakStore.start();
      } else {
        setCountdown(left);
      }
    }, 250);
    return () => clearInterval(timer);
  }, [auto]);

  if (status === 'loading') {
    return (
      <div className="fb-page fb-break">
        <p className="fb-page__subtitle" role="status">Loading your break activities…</p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="fb-page fb-break">
        <h1 className="fb-page__title">Micro break</h1>
        <section className="fb-card" role="alert">
          <h2 className="fb-card__title">Your break activities couldn&apos;t be loaded</h2>
          <p className="fb-card__desc">Check your internet connection, then try again.</p>
          <button type="button" className="fb-btn fb-btn--primary" onClick={() => breakStore.load()}>Try again</button>
        </section>
      </div>
    );
  }

  if (plan.play.length === 0) {
    return (
      <div className="fb-page fb-break">
        <h1 className="fb-page__title">Micro break</h1>
        <section className="fb-card">
          <h2 className="fb-card__title">No break activities added yet.</h2>
          <p className="fb-card__desc">
            Add a few short break activities (stretch, look away from the screen, drink water) and Focus Bear will remind
            you to take them through the day.
          </p>
          <button type="button" className="fb-btn fb-btn--primary" onClick={onEditHabits}>Edit Habits</button>
        </section>
      </div>
    );
  }

  const seconds = breakSeconds(plan.play);
  const nextText = enabled === false ? 'Break reminders are switched off.' : nextBreakLabel(nextAt, Date.now());

  return (
    <div className="fb-page fb-break">
      <div className="fb-focus__bear">
        <img src={LOGO} alt="" />
        <div>
          <h1 className="fb-page__title">Time for a microbreak!</h1>
          <p className="fb-page__subtitle" style={{ marginBottom: 0 }}>Let&apos;s keep your mind and body sharp</p>
        </div>
      </div>

      <section className="fb-card">
        <p className="fb-break__duration">
          <strong>Break duration:</strong> {formatBreakLength(seconds)}
        </p>
        <h2 className="fb-break__label">Break activities</h2>
        <ul className="fb-break__list">
          {plan.play.map((habit) => (
            <li key={habit.id} className="fb-break__item">
              <span className="fb-break__item-icon" aria-hidden="true">{habit.icon || '✨'}</span>
              <span className="fb-break__item-name">{habit.name}</span>
              <span className="fb-break__item-time">
                {habit.requirements ? 'Until done' : formatBreakLength(habit.seconds)}
              </span>
            </li>
          ))}
        </ul>

        <button type="button" className="fb-btn fb-btn--primary fb-btn--block" onClick={() => breakStore.start()} autoFocus>
          Start Micro Break
        </button>
        {countdown !== null && (
          <p className="fb-break__auto" role="status">Starting automatically in {countdown}</p>
        )}

        <label className="fb-check fb-break__check">
          <input
            type="checkbox"
            checked={Boolean(autoStart)}
            disabled={autoLoading}
            onChange={(e) => setAutoStart(e.target.checked)}
          />
          <span>Start break habits automatically next time</span>
        </label>

        <div className="fb-row fb-break__footer">
          {due && (
            <button
              type="button"
              className="fb-btn fb-btn--gray fb-btn--small"
              onClick={() => {
                breakStore.skip();
                onLeave();
              }}
            >
              Skip this break
            </button>
          )}
          <button type="button" className="fb-btn fb-btn--gray fb-btn--small" onClick={onOpenSettings}>
            Microbreak Settings
          </button>
          {nextText && <span className="fb-break__next">{nextText}</span>}
        </div>
      </section>
    </div>
  );
}

function BreakPlaying({ breaks }) {
  const { player } = breaks;
  const [now, setNow] = useState(() => Date.now());
  const habit = currentHabit(player);
  const timed = isTimed(habit);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [player.index]);

  const percent = Math.round(habitProgress(player, now) * 100);

  return (
    <div className="fb-page fb-player">
      <div className="fb-row fb-row--between fb-player__top">
        <span className="fb-player__routine">Micro break</span>
        <span className="fb-player__count" style={{ margin: 0 }}>
          Activity {player.index + 1} of {player.queue.length}
        </span>
      </div>

      <section className="fb-card fb-focus__timer-card">
        <div className="fb-player__icon" aria-hidden="true">{habit.icon || '✨'}</div>
        <h1 className="fb-player__name">{habit.name}</h1>

        {timed ? (
          <>
            <div className="fb-focus__clock" role="timer" aria-label="Time left">
              {formatCountdown(remainingMs(player, now))}
            </div>
            <div
              className="fb-focus__progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-label="Activity progress"
            >
              <div className="fb-focus__progress-fill" style={{ width: `${percent}%` }} />
            </div>
          </>
        ) : (
          <p className="fb-player__requirements">
            <strong>Complete After:</strong> {habit.requirements || 'you are done'}
          </p>
        )}

        <div className="fb-row fb-player__actions">
          {!timed && (
            <button type="button" className="fb-btn fb-btn--primary" onClick={() => breakStore.done()}>
              I&apos;m done
            </button>
          )}
          <button type="button" className="fb-btn fb-btn--gray" onClick={() => breakStore.endEarly()}>
            End break
          </button>
        </div>
      </section>
    </div>
  );
}

function BreakFinished({ breaks, onLeave }) {
  const { player, failed, nextAt } = breaks;
  const last = lastResult(player);
  const nextText = nextBreakLabel(nextAt, Date.now());
  const leave = () => {
    breakStore.close();
    onLeave();
  };

  return (
    <div className="fb-page fb-player">
      <section className="fb-card fb-player__done-card">
        <img className="fb-player__bear" src={LOGO} alt="" />
        <h1 className="fb-player__name">{last ? `${last.name} finished!✅ ` : ''}Nice break. 💪</h1>
        {nextText && <p className="fb-player__progress-line">{nextText}.</p>}
        <ul className="fb-player__results" aria-label="What you did in this break">
          {player.results.map((result) => (
            <li key={result.id}>
              <span aria-hidden="true">{result.icon}</span>
              <span className="fb-player__result-name">{result.name}</span>
              <span className="fb-pill fb-pill--ok">Done</span>
            </li>
          ))}
        </ul>
        <button type="button" className="fb-btn fb-btn--primary fb-player__next" autoFocus onClick={leave}>
          Back to Day Plan
        </button>
        {failed.length > 0 && (
          <p className="fb-player__error" role="alert">
            Couldn&apos;t save {failed.join(', ')} to your account. Check your connection.
          </p>
        )}
      </section>
    </div>
  );
}

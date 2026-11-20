import { useEffect, useState } from 'react';
import './styles/distracting-sites.css'; // shared .fb-dialog
import './styles/focus-session.css'; // shared clock and progress bar
import './styles/habit-player.css';
import { habitPlayer, useHabitPlayer } from '../services/habitPlayerStore.js';
import QuantityDialog from './quantity-dialog.jsx';
import { POSTPONE_CHOICES } from '../services/dayPlanExtras.js';
import {
  currentHabit,
  finishedHeading,
  formatCountdown,
  habitProgress,
  isPaused,
  isTimed,
  lastResult,
  nextHabit,
  progressLine,
  remainingMs,
  startNextLabel,
  wrapUpLabel,
} from '../services/habitPlayerModel.js';
import { formatSpan } from '../services/dayPlanModel.js';

const LOGO = `${import.meta.env.BASE_URL}bear-icon.png`;

/**
 * The habit player, shown in place of the Day Plan while a routine is played.
 * Follows the Windows player (Habits/HabitActivityOnGoing.xaml,
 * HabitActivityFinished.xaml): one habit at a time with its countdown, then
 * "<habit> finished!" with a button for the next one, then the routine's end.
 *
 * `onBack` returns to the Day Plan and leaves the routine running.
 */
export default function HabitPlayer({ player, failed, onBack, onPostpone }) {
  if (!player) return null;
  return (
    <div className="fb-page fb-player">
      <div className="fb-row fb-row--between fb-player__top">
        <button type="button" className="fb-btn fb-btn--gray fb-btn--small" onClick={onBack}>
          ‹ Day Plan
        </button>
        <span className="fb-player__routine">{player.routine.title}</span>
      </div>

      {player.phase === 'running' && <RunningHabit player={player} onPostpone={onPostpone} />}
      {player.phase === 'between' && <BetweenHabits player={player} />}
      {player.phase === 'finished' && <RoutineFinished player={player} />}

      {failed.length > 0 && (
        <p className="fb-player__error" role="alert">
          Couldn&apos;t save {failed.join(', ')}. Check your connection, then mark {failed.length === 1 ? 'it' : 'them'} from
          the Day Plan.
        </p>
      )}
    </div>
  );
}

function RunningHabit({ player, onPostpone }) {
  const [now, setNow] = useState(() => Date.now());
  const [skipStep, setSkipStep] = useState(null); // null | 'why' | 'confirm'
  // Log quantity: asked when "I'm done" is pressed, or (`asking`) when the countdown ran out.
  const [askQuantity, setAskQuantity] = useState(false);
  const [postponing, setPostponing] = useState(false);
  const { asking } = useHabitPlayer();
  const habit = currentHabit(player);
  const paused = isPaused(player);
  const timed = isTimed(habit);

  useEffect(() => {
    setNow(Date.now());
    if (paused) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [paused, player.index]);

  const percent = Math.round(habitProgress(player, now) * 100);
  const closeSkip = () => setSkipStep(null);

  return (
    <>
      <p className="fb-player__count">
        Habit {player.index + 1} of {player.queue.length}
      </p>
      <section className={`fb-card fb-focus__timer-card${paused ? ' fb-focus__timer-card--paused' : ''}`}>
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
              aria-label="Habit progress"
            >
              <div className="fb-focus__progress-fill" style={{ width: `${percent}%` }} />
            </div>
            <div className="fb-focus__progress-text">
              {paused ? 'Paused' : `${formatSpan(habit.seconds)} habit. It finishes by itself when the time is up.`}
            </div>
          </>
        ) : (
          <p className="fb-player__requirements">
            <strong>Complete After:</strong> {habit.requirements || 'you are done'}
          </p>
        )}

        <div className="fb-row fb-player__actions">
          {timed ? (
            <button
              type="button"
              className="fb-btn fb-btn--primary"
              onClick={() => (paused ? habitPlayer.resume() : habitPlayer.pause())}
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
          ) : (
            <button
              type="button"
              className="fb-btn fb-btn--primary"
              onClick={() => (habit.questions?.length > 0 ? setAskQuantity(true) : habitPlayer.end('done'))}
            >
              I&apos;m done
            </button>
          )}
          <button type="button" className="fb-btn fb-btn--gray" onClick={() => setSkipStep('why')}>
            Skip this habit for today
          </button>
        </div>

        {onPostpone && (
          <div className="fb-player__postpone">
            {postponing ? (
              <span className="fb-row" role="group" aria-label="Postpone the routine by">
                <span>Remind me in</span>
                {POSTPONE_CHOICES.map((minutes) => (
                  <button key={minutes} type="button" className="fb-btn fb-btn--small" onClick={() => onPostpone(minutes)}>
                    {minutes} min
                  </button>
                ))}
                <button type="button" className="fb-btn fb-btn--gray fb-btn--small" onClick={() => setPostponing(false)}>Cancel</button>
              </span>
            ) : (
              <button type="button" className="fb-player__link" onClick={() => setPostponing(true)}>
                Postpone the routine
              </button>
            )}
          </div>
        )}
      </section>

      {(asking || askQuantity) && (
        <QuantityDialog
          habit={habit}
          onSubmit={(answers) => {
            setAskQuantity(false);
            habitPlayer.end('done', answers);
          }}
          onCancel={asking ? undefined : () => setAskQuantity(false)}
        />
      )}

      {skipStep && (
        <div className="fb-dialog-overlay" onClick={closeSkip}>
          <div
            className="fb-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="skip-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeSkip();
            }}
          >
            <div className="fb-dialog__header">
              <h2 id="skip-title">{skipStep === 'why' ? 'Why do you want to skip?' : 'Confirm skipping this habit'}</h2>
            </div>
            <div className="fb-dialog__body">
              <p style={{ margin: 0 }}>
                {skipStep === 'why'
                  ? `Tell Focus Bear what happened with "${habit.name}".`
                  : `"${habit.name}" will count as skipped today.`}
              </p>
            </div>
            {skipStep === 'why' ? (
              <div className="fb-dialog__footer">
                <button type="button" className="fb-btn fb-btn--gray" onClick={() => setSkipStep('confirm')}>
                  Can&apos;t do it today
                </button>
                <button
                  type="button"
                  className="fb-btn fb-btn--primary"
                  autoFocus
                  onClick={() => {
                    closeSkip();
                    habitPlayer.end('already-did');
                  }}
                >
                  I already did it
                </button>
              </div>
            ) : (
              <div className="fb-dialog__footer">
                <button
                  type="button"
                  className="fb-btn fb-btn--gray"
                  onClick={() => {
                    closeSkip();
                    habitPlayer.end('skipped');
                  }}
                >
                  Skip habit
                </button>
                <button type="button" className="fb-btn fb-btn--primary" autoFocus onClick={closeSkip}>
                  I changed my mind - I&apos;ll do my habits
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function BetweenHabits({ player }) {
  const next = nextHabit(player);
  return (
    <section className="fb-card fb-player__done-card">
      <img className="fb-player__bear" src={LOGO} alt="" />
      <h1 className="fb-player__name">{finishedHeading(lastResult(player))}</h1>
      <p className="fb-player__progress-line">{progressLine(player)}</p>
      <button type="button" className="fb-btn fb-btn--primary fb-player__next" autoFocus onClick={() => habitPlayer.next()}>
        {next.icon ? `${next.icon} ` : ''}{startNextLabel(next)}
      </button>
      <div className="fb-row fb-player__links">
        <button type="button" className="fb-player__link" onClick={() => habitPlayer.skipNext()}>
          Skip this habit for today
        </button>
        <button type="button" className="fb-player__link" onClick={() => habitPlayer.close()}>
          Choose another habit
        </button>
      </div>
    </section>
  );
}

function RoutineFinished({ player }) {
  return (
    <section className="fb-card fb-player__done-card">
      <img className="fb-player__bear" src={LOGO} alt="" />
      <h1 className="fb-player__name">
        {finishedHeading(lastResult(player))} You&apos;ve earned your screen time. 💪
      </h1>
      <p className="fb-player__progress-line">{progressLine(player)}</p>
      <ul className="fb-player__results" aria-label={`${player.routine.title}: what you did`}>
        {player.results.map((result) => (
          <li key={result.id}>
            <span aria-hidden="true">{result.icon}</span>
            <span className="fb-player__result-name">{result.name}</span>
            <span className={`fb-pill${result.outcome === 'done' ? ' fb-pill--ok' : ''}`}>
              {result.outcome === 'done' ? 'Done' : 'Skipped'}
            </span>
          </li>
        ))}
      </ul>
      <button type="button" className="fb-btn fb-btn--primary fb-player__next" autoFocus onClick={() => habitPlayer.close()}>
        {wrapUpLabel(player)}
      </button>
    </section>
  );
}

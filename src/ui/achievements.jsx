import { useCallback, useEffect, useState } from 'react';
import './styles/tools.css';
import { toolsApi } from '../services/toolsApi.js';
import { MAX_LEVEL, achievementsView, localAchievements } from '../services/statsModel.js';
import { useSyncedState } from '../services/sync.js';

/**
 * MAIN > Achievements. The set-up checklists of levels 1 and 2 and the streaks
 * the later levels are about, from GET /user/stats/onboarding (Windows:
 * Stats/AchievementsScreen.cs). A step opens the page where it is done.
 */
export default function AchievementsPage({ onOpen, blocking }) {
  const [blockedSites] = useSyncedState('urlList');
  const [stats, setStats] = useState(null);
  const [status, setStatus] = useState('loading');

  const load = useCallback(async () => {
    try {
      setStats(await toolsApi.getLevelStats());
      setStatus('ready');
    } catch (error) {
      console.error('[Achievements] Could not load:', error);
      setStatus((current) => (current === 'ready' ? 'ready' : 'error'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const view = achievementsView(
    stats,
    localAchievements({ blockedSites, schedules: blocking?.schedules, modes: blocking?.modes }),
  );

  return (
    <div className="fb-page fb-achievements">
      <h1 className="fb-page__title">Achievements</h1>
      <p className="fb-page__subtitle">Get set up, then keep your streaks going to level up.</p>

      {status === 'loading' && <p className="fb-tools__note" role="status">Loading your achievements…</p>}
      {status === 'error' && (
        <section className="fb-card" role="alert">
          <h2 className="fb-card__title">Your achievements couldn&apos;t be loaded</h2>
          <p className="fb-card__desc">Check your internet connection, then try again.</p>
          <button type="button" className="fb-btn fb-btn--primary" onClick={load}>Try again</button>
        </section>
      )}

      {status === 'ready' && (
        <>
          <section className="fb-card fb-achievements__level">
            <div className="fb-achievements__badge" aria-hidden="true">{view.level}</div>
            <div>
              <h2 className="fb-card__title">You are on level {view.level} of {MAX_LEVEL}</h2>
              <p className="fb-card__desc" style={{ marginBottom: 0 }}>
                {view.stepsDone} of {view.stepsTotal} set-up steps done.
              </p>
            </div>
          </section>

          {view.checklists.map((group) => (
            <section key={group.level} className="fb-card">
              <div className="fb-row fb-row--between">
                <h2 className="fb-card__title">{group.title}</h2>
                <span className={`fb-pill${group.complete ? ' fb-pill--ok' : ''}`}>{group.count} / {group.total}</span>
              </div>
              <ul className="fb-achievements__steps">
                {group.steps.map((step) => (
                  <li key={step.key} className={step.done ? 'fb-achievements__step--done' : undefined}>
                    <span className="fb-achievements__tick" aria-hidden="true">{step.done ? '✓' : ''}</span>
                    <span className="fb-achievements__label">
                      {step.label}
                      <span className="fb-dayplan__sr">{step.done ? ' (done)' : ' (not done yet)'}</span>
                    </span>
                    {!step.done && step.page && (
                      <button type="button" className="fb-btn fb-btn--small" onClick={() => onOpen?.(step.page)}>Do this</button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <section className="fb-card">
            <h2 className="fb-card__title">Streaks towards your next level</h2>
            <p className="fb-card__desc">From level 3 on, levels come from doing your routines, breaks and focus sessions day after day.</p>
            <div className="fb-stats__tiles">
              {view.streaks.map((streak) => (
                <div key={streak.id} className="fb-achievements__streak">
                  <strong><span aria-hidden="true">{streak.icon} </span>{streak.label}</strong>
                  <span>{streak.days} {streak.days === 1 ? 'day' : 'days'} in a row</span>
                  <div className="fb-stats__bar" role="img" aria-label={`${streak.percent}% of this level's target`}>
                    <span style={{ width: `${streak.percent}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

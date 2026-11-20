import { useCallback, useEffect, useState } from 'react';
import './styles/distracting-sites.css'; // shared .fb-input
import './styles/tools.css';
import { toolsApi } from '../services/toolsApi.js';
import { MAX_GOALS, MAX_GOAL_LENGTH, cleanGoals } from '../services/onboardingModel.js';
import {
  DEFAULT_LEADERBOARD_SORT,
  LEADERBOARD_SORTS,
  focusLogRows,
  focusLogTotal,
  leaderboardTable,
  streakTiles,
  usernameError,
} from '../services/statsModel.js';

const TABS = [
  { id: 'streak', label: 'Streak' },
  { id: 'leaderboard', label: 'Leaderboard' },
  { id: 'goals', label: 'Goals' },
  { id: 'focus-log', label: 'Focus Log' },
];

const LOAD_FAILED = "This couldn't be loaded. Check your internet connection, then try again.";

function useLoad(loader, deps) {
  const [state, setState] = useState({ status: 'loading', data: null });
  const load = useCallback(async () => {
    setState((prev) => ({ status: prev.data ? 'ready' : 'loading', data: prev.data }));
    try {
      setState({ status: 'ready', data: await loader() });
    } catch (error) {
      console.error('[Stats] Load failed:', error);
      setState((prev) => ({ status: prev.data ? 'ready' : 'error', data: prev.data }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    load();
  }, [load]);
  return { ...state, reload: load, setData: (data) => setState({ status: 'ready', data }) };
}

function LoadState({ status, onRetry }) {
  if (status === 'loading') return <p className="fb-tools__note" role="status">Loading…</p>;
  if (status === 'error') {
    return (
      <div role="alert">
        <p className="fb-tools__note">{LOAD_FAILED}</p>
        <button type="button" className="fb-btn fb-btn--primary" onClick={onRetry}>Try again</button>
      </div>
    );
  }
  return null;
}

function StreakTab() {
  const { status, data, reload } = useLoad(() => toolsApi.getDetails(), []);
  if (status !== 'ready') return <LoadState status={status} onRetry={reload} />;
  return (
    <div className="fb-stats__tiles">
      {streakTiles(data).map((tile) => (
        <section key={tile.id} className="fb-card fb-stats__tile">
          <div className="fb-stats__tile-head">
            <span aria-hidden="true">{tile.icon}</span>
            <h2 className="fb-card__title">{tile.label}</h2>
          </div>
          <p className="fb-stats__big">
            {tile.streak} <span>day streak</span>
          </p>
          <div className="fb-stats__bar" role="img" aria-label={`${tile.percent}% of days completed`}>
            <span style={{ width: `${tile.percent}%` }} />
          </div>
          <p className="fb-card__desc" style={{ marginBottom: 0 }}>{tile.caption}</p>
        </section>
      ))}
    </div>
  );
}

function LeaderboardTab() {
  const [sort, setSort] = useState(DEFAULT_LEADERBOARD_SORT);
  const board = useLoad(() => toolsApi.getLeaderboard(sort), [sort]);
  const details = useLoad(() => toolsApi.getDetails(), []);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState(null);
  const [editingName, setEditingName] = useState(false);

  const username = String(details.data?.username || '').trim();
  const sortKind = LEADERBOARD_SORTS.find((option) => option.id === sort)?.kind || 'morning';
  const table = board.data ? leaderboardTable(board.data) : null;

  const saveName = async (event) => {
    event.preventDefault();
    const problem = usernameError(name);
    if (problem) {
      setNameError(problem);
      return;
    }
    setSaving(true);
    setNameError(null);
    try {
      await toolsApi.setUsername(name);
      details.setData({ ...(details.data || {}), username: name.trim() });
      setEditingName(false);
      board.reload();
    } catch (error) {
      console.error('[Stats] Could not save the username:', error);
      setNameError(error?.status === 409 || error?.status === 400 ? 'That username is taken or not allowed. Try another.' : "Couldn't save that. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  const row = (entry, extraClass = '') => {
    const streak = entry.streaks[sortKind];
    return (
      <tr key={`${entry.id}-${extraClass}`} className={`${entry.isYou ? 'fb-stats__you ' : ''}${extraClass}`}>
        <td className="fb-stats__rank">{entry.rank || '–'}</td>
        <td className="fb-stats__name">
          {entry.name}
          {entry.isYou && <span className="fb-pill"> You</span>}
        </td>
        {LEADERBOARD_SORTS.map((option) => (
          <td key={option.id} className={option.id === sort ? 'fb-stats__sorted' : undefined}>
            {entry.streaks[option.kind].streak}
          </td>
        ))}
        <td className="fb-stats__caption">
          <div className="fb-stats__bar" aria-hidden="true">
            <span style={{ width: `${streak.percent}%` }} />
          </div>
          {streak.caption}
        </td>
      </tr>
    );
  };

  return (
    <>
      {details.status === 'ready' && (!username || editingName) && (
        <section className="fb-card">
          <h2 className="fb-card__title">{username ? 'Change your leaderboard username' : "You haven't set a leaderboard username"}</h2>
          <p className="fb-card__desc">
            {username
              ? 'Other people see this name next to your streaks.'
              : "You won't appear on the leaderboard until you choose one. Other people see this name, so don't use your real name unless you want to."}
          </p>
          <form className="fb-tools__inline" onSubmit={saveName}>
            <input
              className="fb-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Username"
              aria-label="Leaderboard username"
              maxLength={30}
            />
            <button type="submit" className="fb-btn fb-btn--primary" disabled={saving || !name.trim()}>
              {saving ? 'Saving…' : 'Save username'}
            </button>
            {editingName && (
              <button type="button" className="fb-btn fb-btn--gray" onClick={() => setEditingName(false)}>Cancel</button>
            )}
          </form>
          {nameError && <p className="fb-tools__error" role="alert">{nameError}</p>}
        </section>
      )}

      <section className="fb-card">
        <div className="fb-row fb-row--between">
          <div className="fb-segmented" role="group" aria-label="Sort the leaderboard by">
            {LEADERBOARD_SORTS.map((option) => (
              <button key={option.id} type="button" aria-pressed={option.id === sort} onClick={() => setSort(option.id)}>
                {option.label}
              </button>
            ))}
          </div>
          {username && !editingName && (
            <span className="fb-tools__muted">
              You are <strong>{username}</strong>{' '}
              <button type="button" className="fb-tools__link" onClick={() => { setName(username); setEditingName(true); }}>Change</button>
            </span>
          )}
        </div>

        {board.status !== 'ready' && <LoadState status={board.status} onRetry={board.reload} />}
        {table && table.rows.length === 0 && <p className="fb-tools__note">Nobody is on the leaderboard yet.</p>}
        {table && table.rows.length > 0 && (
          <table className="fb-stats__table">
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Name</th>
                {LEADERBOARD_SORTS.map((option) => (
                  <th key={option.id} scope="col" aria-sort={option.id === sort ? 'descending' : undefined}>{option.label}</th>
                ))}
                <th scope="col">Last 90 days</th>
              </tr>
            </thead>
            <tbody>
              {table.rows.map((entry) => row(entry))}
              {table.you && row(table.you, 'fb-stats__position')}
            </tbody>
          </table>
        )}
        {table?.you && <p className="fb-tools__muted">The last row is your position.</p>}
        {table && username && !table.you && !table.listed && (
          <p className="fb-tools__muted">You aren&apos;t ranked yet. Keep your routines going and you&apos;ll show up here.</p>
        )}
      </section>
    </>
  );
}

function GoalsTab() {
  const { status, data, reload, setData } = useLoad(() => toolsApi.getGoals(), []);
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const goals = data || [];

  const save = async (next) => {
    const before = goals;
    const cleaned = cleanGoals(next);
    setData(cleaned);
    setError(null);
    try {
      await toolsApi.saveGoals(cleaned);
    } catch (err) {
      console.error('[Stats] Could not save the goals:', err);
      setData(before);
      setError("Couldn't save that. Check your connection and try again.");
    }
  };

  if (status !== 'ready') return <LoadState status={status} onRetry={reload} />;
  return (
    <section className="fb-card">
      <h2 className="fb-card__title">Your long-term goals</h2>
      <p className="fb-card__desc">What you are working towards. Habit suggestions use them.</p>
      {goals.length === 0 && <p className="fb-tools__note">No goals yet.</p>}
      <ul className="fb-stats__goals">
        {goals.map((goal) => (
          <li key={goal}>
            <span>{goal}</span>
            <button type="button" className="fb-btn fb-btn--gray fb-btn--small" onClick={() => save(goals.filter((item) => item !== goal))} aria-label={`Remove goal: ${goal}`}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {goals.length < MAX_GOALS && (
        <form
          className="fb-tools__inline"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            save([...goals, text]);
            setText('');
          }}
        >
          <input className="fb-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a goal" aria-label="Add a goal" maxLength={MAX_GOAL_LENGTH} />
          <button type="submit" className="fb-btn fb-btn--primary" disabled={!text.trim()}>Add goal</button>
        </form>
      )}
      {error && <p className="fb-tools__error" role="alert">{error}</p>}
    </section>
  );
}

function FocusLogTab() {
  const { status, data, reload } = useLoad(() => toolsApi.getFocusLog(30, 0), []);
  if (status !== 'ready') return <LoadState status={status} onRetry={reload} />;
  const rows = focusLogRows(data);
  const when = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <section className="fb-card">
      <h2 className="fb-card__title">Your last {rows.length} focus sessions</h2>
      <p className="fb-card__desc">{rows.length > 0 ? `${focusLogTotal(rows)} of focus in total.` : 'Finish a focus session to see it here.'}</p>
      {rows.length > 0 && (
        <table className="fb-stats__table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Session</th>
              <th scope="col">Length</th>
              <th scope="col">What you got done</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.start ? when.format(entry.start) : ''}</td>
                <td>{entry.title}</td>
                <td>{entry.duration}</td>
                <td>
                  {entry.stars > 0 && <span aria-label={`${entry.stars} of 5 stars`}>{'★'.repeat(entry.stars)} </span>}
                  {entry.achievements}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * TOOLS > Stats: streaks, the leaderboard, long-term goals and the focus log,
 * from the same API calls as the Windows Stats screen (Stats/StatsScreen.cs).
 */
export default function StatsPage() {
  const [tab, setTab] = useState('streak');
  return (
    <div className="fb-page fb-stats">
      <h1 className="fb-page__title">Stats</h1>
      <p className="fb-page__subtitle">How your routines, breaks and focus sessions are going.</p>
      <div className="fb-segmented fb-stats__tabs" role="tablist" aria-label="Stats">
        {TABS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={item.id === tab} aria-pressed={item.id === tab} onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      {tab === 'streak' && <StreakTab />}
      {tab === 'leaderboard' && <LeaderboardTab />}
      {tab === 'goals' && <GoalsTab />}
      {tab === 'focus-log' && <FocusLogTab />}
    </div>
  );
}

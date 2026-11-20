import { useEffect } from 'react';
import './styles/tools.css';
import { musicStore, useMusic } from '../services/musicStore.js';
import { formatPosition } from '../services/statsModel.js';

/**
 * TOOLS > Focus Music. Focus Bear's own tracks (the catalogue the Windows
 * player uses), streamed. The music carries on while other pages are open.
 */
export default function FocusMusicPage() {
  const { status, tracks, currentId, playing, position, duration, volume, error } = useMusic();

  useEffect(() => {
    musicStore.load();
  }, []);

  const current = tracks.find((track) => track.id === currentId) || null;

  return (
    <div className="fb-page fb-music">
      <h1 className="fb-page__title">Focus Music</h1>
      <p className="fb-page__subtitle">Music made for concentrating. It keeps playing while you use the rest of the app.</p>

      {status === 'loading' && <p className="fb-tools__note" role="status">Loading the tracks…</p>}
      {status === 'error' && (
        <section className="fb-card" role="alert">
          <h2 className="fb-card__title">The tracks couldn&apos;t be loaded</h2>
          <p className="fb-card__desc">Check your internet connection, then try again.</p>
          <button type="button" className="fb-btn fb-btn--primary" onClick={() => musicStore.load()}>Try again</button>
        </section>
      )}

      {status === 'ready' && (
        <>
          <section className="fb-card fb-music__player" aria-label="Player">
            {current?.image ? <img className="fb-music__art" src={current.image} alt="" /> : <div className="fb-music__art" aria-hidden="true">🎵</div>}
            <div className="fb-music__now">
              <strong>{current ? current.name : 'Nothing playing'}</strong>
              <span className="fb-tools__muted">
                {current ? `${formatPosition(position)} / ${formatPosition(duration || current.seconds)}` : 'Pick a track below.'}
              </span>
              <div className="fb-stats__bar" aria-hidden="true">
                <span style={{ width: `${duration > 0 ? Math.min(100, (position / duration) * 100) : 0}%` }} />
              </div>
            </div>
            <div className="fb-music__controls">
              <button type="button" className="fb-btn fb-btn--gray" onClick={() => musicStore.previous()} disabled={tracks.length === 0} aria-label="Previous track">⏮</button>
              <button type="button" className="fb-btn fb-btn--primary" onClick={() => musicStore.toggle()} disabled={tracks.length === 0}>
                {playing ? '⏸ Pause' : '▶ Play'}
              </button>
              <button type="button" className="fb-btn fb-btn--gray" onClick={() => musicStore.next()} disabled={tracks.length === 0} aria-label="Next track">⏭</button>
              <label className="fb-music__volume">
                <span>Volume</span>
                <input type="range" min="0" max="1" step="0.05" value={volume} onChange={(e) => musicStore.setVolume(e.target.value)} />
              </label>
            </div>
          </section>

          {error && <p className="fb-tools__error" role="alert">{error}</p>}
          {tracks.length === 0 && <p className="fb-tools__note">No tracks are available right now.</p>}

          <ul className="fb-music__tracks">
            {tracks.map((track) => {
              const active = track.id === currentId;
              return (
                <li key={track.id}>
                  <button
                    type="button"
                    className={`fb-music__track${active ? ' fb-music__track--on' : ''}`}
                    onClick={() => musicStore.toggle(track.id)}
                    aria-pressed={active && playing}
                    aria-label={`${active && playing ? 'Pause' : 'Play'} ${track.name}`}
                  >
                    {track.image ? <img src={track.image} alt="" loading="lazy" /> : <span className="fb-music__thumb" aria-hidden="true">🎵</span>}
                    <span className="fb-music__track-name">{track.name}</span>
                    <span className="fb-tools__muted">{active && playing ? 'Playing' : track.length}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

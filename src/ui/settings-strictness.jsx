import { useSyncedState } from '../services/sync.js';
import { BEAR_MODES, normaliseBearMode } from '../services/settingsModel.js';
import './styles/settings-extra.css';

/**
 * Settings > Strictness. Cuddly or Grizzly Bear (kCuddlyModeEnabled, shared
 * with the other Focus Bear apps, where Grizzly means a blocked site can't be
 * let through for a while). On Linux it does the same (the extensions drop
 * "Unblock temporarily") and sets the strictness a new focus session is
 * offered on when no level was picked before, as on Windows and Mac.
 */
export default function SettingsStrictnessPage({ onOpenFocus }) {
  const [saved, setSaved, isLoading] = useSyncedState('selectedBearMode');
  const mode = normaliseBearMode(saved);

  return (
    <div className="fb-page">
      <h1 className="fb-page__title">Strictness</h1>
      <p className="fb-page__subtitle">How firm Focus Bear is with you.</p>

      <section className="fb-card" aria-busy={isLoading}>
        <div className="fb-settings__options" role="radiogroup" aria-label="Bear mode">
          {BEAR_MODES.map((option) => (
            <label key={option.id} className={`fb-settings__option${mode === option.id ? ' fb-settings__option--on' : ''}`}>
              <input
                type="radio"
                name="bear-mode"
                checked={mode === option.id}
                onChange={() => setSaved(option.id)}
                disabled={isLoading}
              />
              <span>
                <strong>{option.label}</strong>
                <span className="fb-settings__option-text">{option.text}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="fb-card__desc" style={{ margin: '14px 0 0' }}>
          This is the same Cuddly / Grizzly setting as in the Mac and Windows apps: it is saved to your account and
          changes how they block too. For focus sessions, the level you picked last on the start screen is offered
          first.{' '}
          {onOpenFocus && (
            <button type="button" className="fb-settings__link" onClick={onOpenFocus}>Start a focus session</button>
          )}
        </p>
      </section>
    </div>
  );
}

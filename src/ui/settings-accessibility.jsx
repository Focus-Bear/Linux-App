import { useSyncedState } from '../services/sync.js';
import './styles/settings-extra.css';

/**
 * Settings > Accessibility. "Prefer reduced motion" (kIsReducedMotion, shared
 * with the other apps): the app stops animating and sliding (see
 * [data-reduced-motion] in styles/settings-extra.css).
 */
export default function SettingsAccessibilityPage() {
  const [reduced, setReduced, isLoading] = useSyncedState('reducedMotion');

  return (
    <div className="fb-page">
      <h1 className="fb-page__title">Accessibility</h1>
      <p className="fb-page__subtitle">Make Focus Bear easier to use.</p>

      <section className="fb-card" aria-busy={isLoading}>
        <label className="fb-settings__check">
          <input type="checkbox" checked={Boolean(reduced)} onChange={(e) => setReduced(e.target.checked)} disabled={isLoading} />
          <span>
            <strong>Prefer reduced motion</strong>
            <span className="fb-settings__option-text">
              No animations: the sidebar, progress bars and spinners change without moving. Saved to your account, so your
              other devices use it too.
            </span>
          </span>
        </label>
      </section>
    </div>
  );
}

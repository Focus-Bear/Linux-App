import { useTheme } from './useTheme.js';

const OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Settings > UI. Theme choice, like the Windows app's System / Light / Dark setting. */
export default function SettingsUIPage() {
  const { preference, resolved, setPreference } = useTheme();

  return (
    <div className="fb-page">
      <h1 className="fb-page__title">UI</h1>
      <p className="fb-page__subtitle">How Focus Bear looks on this computer.</p>

      <section className="fb-card" aria-labelledby="theme-title">
        <h2 id="theme-title" className="fb-card__title">Theme</h2>
        <p className="fb-card__desc">
          Dark mode is easier on the eyes at night. System follows your desktop's light or dark setting
          {preference === 'system' ? ` (currently ${resolved})` : ''}.
        </p>
        <div className="fb-segmented" role="group" aria-label="Theme">
          {OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={preference === option.value}
              onClick={() => setPreference(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

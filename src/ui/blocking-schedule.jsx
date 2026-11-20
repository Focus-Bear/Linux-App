import './styles/blocking-schedule.css';
import { useSyncedState } from '../services/sync';

const MODES = [
  {
    value: 'automatic',
    title: 'Automatically (until the end of the workday)',
    description:
      "Block distracting sites until you finish your work or study. You'll get some free time before bed (check your socials guilt free!). When it's time to sleep, sites are blocked again.",
  },
  {
    value: 'manual',
    title: 'Manually (when I switch it on)',
    description: 'Block distracting sites when you click Start Focus Session.',
  },
  {
    value: 'advanced',
    title: 'Advanced (customised blocking schedule)',
    description: 'Coming soon.',
    disabled: true,
  },
];

const BlockingSchedule = function () {
  const [selectedBlockMode, setSelectedBlockMode, isLoading] = useSyncedState('selectedBlockMode');

  return (
    <div className="fb-page">
      <h1 className="fb-page__title">Blocking Schedule</h1>
      <p className="fb-page__subtitle">When do you want to block distracting sites?</p>

      <section className="fb-card" aria-busy={isLoading}>
        {isLoading ? (
          <p className="fb-card__desc" style={{ margin: 0 }}>Loading your blocking schedule…</p>
        ) : (
          <div className="fb-options" role="radiogroup" aria-label="Blocking schedule">
            {MODES.map((mode) => {
              const checked = selectedBlockMode === mode.value;
              return (
                <label
                  key={mode.value}
                  className={`fb-option${checked ? ' fb-option--checked' : ''}${mode.disabled ? ' fb-option--disabled' : ''}`}
                >
                  <input
                    type="radio"
                    name="block-mode"
                    value={mode.value}
                    checked={checked}
                    disabled={mode.disabled}
                    onChange={(e) => setSelectedBlockMode(e.target.value)}
                  />
                  <span>
                    <span className="fb-option__title">{mode.title}</span>
                    <span className="fb-option__desc">{mode.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};

export default BlockingSchedule;

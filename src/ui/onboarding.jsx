import { useEffect, useMemo, useRef, useState } from 'react';
import './styles/distracting-sites.css'; // shared .fb-input
import './styles/onboarding.css';
import WebViewHost from './WebViewHost.jsx';
import { buildWebViewMetadata } from './webviewMetadata.js';
import { useTheme } from './useTheme.js';
import { webviewTheme } from './theme.js';
import { auth0Sync } from '../services/sync.js';
import { habitApi } from '../services/habitApi.js';
import { blockingApi } from '../services/blockingStore.js';
import { createOnboardingApi } from '../services/onboardingApiCore.js';
import { withEntries } from '../electron/blockingModel.js';
import {
  GOAL_IDEAS,
  HABIT_WEBVIEWS,
  MAX_GOALS,
  MAX_GOAL_LENGTH,
  OCCUPATIONS,
  PRIVACY_POINTS,
  PRIVACY_URL,
  STEPS,
  TERMS_URL,
  WORK_LIST_NAME,
  workListPlan,
  cleanGoals,
  cleanSite,
  distractionChoices,
  habitCount,
  mergeBlocked,
  nextStep,
  previousStep,
  routineMessageKind,
  workSiteChoices,
} from '../services/onboardingModel.js';

const LOGO = `${import.meta.env.BASE_URL}bear-icon.png`;

const onboardingApi = createOnboardingApi({
  request: (...args) => habitApi.request(...args),
  getDeviceId: () => habitApi.registerDevice(),
});

const SAVE_FAILED = "Couldn't save that. Check your connection and try again, or skip this step.";

/** A list of sites with a tick box each, plus a field to add another. */
function SitePicker({ sites, chosen, onToggle, onAdd, addLabel }) {
  const [text, setText] = useState('');
  const add = (event) => {
    event.preventDefault();
    const site = cleanSite(text);
    if (!site) return;
    onAdd(site);
    setText('');
  };
  return (
    <>
      <ul className="fb-onb__sites">
        {sites.map((site) => (
          <li key={site}>
            <label className="fb-onb__site">
              <input type="checkbox" checked={chosen.has(site)} onChange={() => onToggle(site)} />
              <span>{site}</span>
            </label>
          </li>
        ))}
      </ul>
      <form className="fb-onb__add" onSubmit={add}>
        <input
          className="fb-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="example.com"
          aria-label={addLabel}
        />
        <button type="submit" className="fb-btn" disabled={!cleanSite(text)}>Add</button>
      </form>
    </>
  );
}

/**
 * First-run onboarding for a new account, shown instead of the main window
 * right after sign-up. The steps follow the Windows app's onboarding pages
 * (see onboardingModel.js); every step after the privacy one can be skipped.
 * onFinish(pageId) hands over to the app.
 */
export default function OnboardingPage({ user, onFinish }) {
  const [step, setStep] = useState(STEPS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // privacy
  const [agreed, setAgreed] = useState(false);
  // goals
  const [goals, setGoals] = useState([]);
  const [goalText, setGoalText] = useState('');
  // blocking
  const [occupation, setOccupation] = useState('');
  const [occupationText, setOccupationText] = useState('');
  const [suggestions, setSuggestions] = useState(null);
  const [blockSites, setBlockSites] = useState([]);
  const [blockChosen, setBlockChosen] = useState(() => new Set());
  const [workSites, setWorkSites] = useState([]);
  const [workChosen, setWorkChosen] = useState(() => new Set());
  // habits
  const [habitMode, setHabitMode] = useState(null); // null | 'recommend' | 'import'
  const [habitResult, setHabitResult] = useState(null); // null | 'installed' | 'failed'
  const [habits, setHabits] = useState(0);
  const { resolved } = useTheme();
  const habitModeRef = useRef(null);
  habitModeRef.current = habitMode;

  const go = (target) => {
    setError(null);
    setStep(target);
  };
  const forward = () => go(nextStep(step));
  const back = () => go(previousStep(step));

  // Goals already on the account (e.g. set on the web) are shown, not overwritten.
  useEffect(() => {
    let cancelled = false;
    onboardingApi
      .getGoals()
      .then((saved) => {
        if (!cancelled && saved.length > 0) setGoals(cleanGoals(saved));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const goalExtra = useMemo(() => ({ long_term_goals: goals.length > 0 ? goals : [''] }), [goals]);

  // The habit ideas page reports when the chosen habits were added.
  useEffect(() => {
    const off = window.api?.onWebViewMessage?.((id, message) => {
      const mode = habitModeRef.current;
      if (!mode || id !== HABIT_WEBVIEWS[mode]) return;
      const kind = routineMessageKind(message);
      if (kind === 'resend') {
        buildWebViewMetadata(webviewTheme(resolved), goalExtra).then((metadata) => {
          if (metadata) window.api?.resendWebViewMetadata?.(id, metadata);
        });
      } else if (kind === 'installed' || kind === 'failed') {
        window.api?.destroyWebView?.(id);
        setHabitResult(kind);
        setHabitMode(null);
        go('done');
      }
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, [resolved, goalExtra]);

  // The dashboard page only posts that message to the Windows and Mac apps, so
  // while it is open the app also watches the account's routines: once their
  // habits change, the ideas were installed.
  useEffect(() => {
    if (!habitMode) return undefined;
    let cancelled = false;
    let baseline = null;
    const signature = (settings) =>
      JSON.stringify(
        ['morning_activities', 'evening_activities', 'break_activities'].map((key) =>
          (Array.isArray(settings?.[key]) ? settings[key] : []).map((habit) => habit?.id),
        ),
      );
    const check = async () => {
      try {
        const current = signature(await onboardingApi.getSettings());
        if (cancelled) return;
        if (baseline === null) baseline = current;
        else if (current !== baseline) {
          window.api?.destroyWebView?.(HABIT_WEBVIEWS[habitMode]);
          setHabitResult('installed');
          setHabitMode(null);
          go('done');
        }
      } catch {
        // try again on the next tick
      }
    };
    check();
    const timer = setInterval(check, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [habitMode]);

  // Count the account's habits for the last screen.
  useEffect(() => {
    if (step !== 'done') return;
    let cancelled = false;
    onboardingApi
      .getSettings()
      .then((settings) => {
        if (!cancelled) setHabits(habitCount(settings));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [step]);

  const run = async (work) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      console.error('[Onboarding] Step failed:', err);
      setError(SAVE_FAILED);
    } finally {
      setBusy(false);
    }
  };

  const acceptPrivacy = () =>
    run(async () => {
      await onboardingApi.sendConsent();
      forward();
    });

  const addGoal = (text) => {
    setGoals((prev) => cleanGoals([...prev, text]));
    setGoalText('');
  };

  const saveGoals = () =>
    run(async () => {
      const list = cleanGoals(goalText.trim() ? [...goals, goalText] : goals);
      setGoals(list);
      setGoalText('');
      if (list.length > 0) await onboardingApi.saveGoals(list);
      forward();
    });

  const offerSites = (found) => {
    const current = auth0Sync.getValue('urlList') || [];
    const offered = distractionChoices(found, current);
    setSuggestions(found);
    setBlockSites(offered);
    // Everything is ticked to begin with, as on Windows.
    setBlockChosen(new Set(offered));
    const work = workSiteChoices(found, current);
    setWorkSites(work);
    setWorkChosen(new Set(work));
  };

  const saveOccupation = () =>
    run(async () => {
      let found = { user_relevant_sites: [], user_typical_distractions: [] };
      try {
        found = await onboardingApi.suggestSites(occupation, occupationText);
      } catch (err) {
        // The suggestions are a nicety: carry on with the usual list.
        console.error('[Onboarding] No site suggestions:', err);
      }
      offerSites(found);
      forward();
    });

  const skipOccupation = () => {
    offerSites(null);
    forward();
  };

  const toggleIn = (setter) => (site) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(site)) next.delete(site);
      else next.add(site);
      return next;
    });

  const saveBlocked = () =>
    run(async () => {
      const current = auth0Sync.getValue('urlList') || [];
      const next = mergeBlocked(current, blockSites, [...blockChosen]);
      await auth0Sync.setValue('urlList', next);
      // Saved now, so a failure shows here ("Couldn't save that") instead of
      // being lost a second later.
      await auth0Sync.flush();
      // A site that is now blocked isn't offered as a work site.
      setWorkSites((prev) => prev.filter((site) => !blockChosen.has(site)));
      forward();
    });

  const saveWork = () =>
    run(async () => {
      const chosen = workSites.filter((site) => workChosen.has(site));
      if (chosen.length > 0) {
        const lists = await blockingApi.getLists();
        // Only an allow list called Work is reused; a block list with that name is left alone.
        const plan = workListPlan(lists);
        const list = plan.reuse || (await blockingApi.createList(plan.create, 'allow'));
        // Only this list is sent, from a copy read just now (not every list of the account).
        await blockingApi.updateList(list.id, (fresh) => withEntries(fresh, [...(fresh.allowed_urls || []), ...chosen]));
      }
      forward();
    });

  const leaveHabits = () => {
    if (habitMode) window.api?.destroyWebView?.(HABIT_WEBVIEWS[habitMode]);
    setHabitMode(null);
    go('done');
  };

  const finish = () =>
    run(async () => {
      try {
        await onboardingApi.finish();
      } catch (err) {
        // Not worth holding the person on the last screen for.
        console.error('[Onboarding] Could not save the settings at the end:', err);
      }
      await onFinish('focus-session');
    });

  const stepIndex = STEPS.indexOf(step);
  const dots = (
    <div className="fb-onb__dots" role="img" aria-label={`Step ${stepIndex + 1} of ${STEPS.length}`}>
      {STEPS.map((id, index) => (
        <span key={id} className={`fb-onb__dot${index <= stepIndex ? ' fb-onb__dot--on' : ''}`} />
      ))}
    </div>
  );

  const footer = (primary, { skip = true, canBack = true } = {}) => (
    <>
      {error && <p className="fb-onb__error" role="alert">{error}</p>}
      <div className="fb-onb__footer">
        {canBack && stepIndex > 0 && (
          <button type="button" className="fb-btn fb-btn--gray" onClick={back} disabled={busy}>Back</button>
        )}
        <span className="fb-onb__spacer" />
        {skip && (
          <button type="button" className="fb-btn fb-btn--gray" onClick={forward} disabled={busy}>Skip</button>
        )}
        {primary}
      </div>
    </>
  );

  // The habit ideas page fills the window, with a bar to leave it.
  if (step === 'habits' && habitMode) {
    return (
      <div className="fb-onb fb-onb--webview">
        <div className="fb-onb__bar">
          <button type="button" className="fb-btn fb-btn--gray fb-btn--small" onClick={() => {
            window.api?.destroyWebView?.(HABIT_WEBVIEWS[habitMode]);
            setHabitMode(null);
          }}>
            Back
          </button>
          <strong>Habit ideas</strong>
          <span className="fb-onb__spacer" />
          <button type="button" className="fb-btn fb-btn--primary fb-btn--small" onClick={leaveHabits}>
            I&apos;m done here
          </button>
        </div>
        <div className="fb-onb__webview">
          <WebViewHost key={habitMode} id={HABIT_WEBVIEWS[habitMode]} label="habit ideas" extra={goalExtra} />
        </div>
      </div>
    );
  }

  return (
    <div className="fb-onb">
      <div className="fb-onb__card fb-card">
        {dots}

        {step === 'privacy' && (
          <>
            <div className="fb-onb__brand">
              <img src={LOGO} alt="" width="44" height="44" />
              <span>Howdy! I&apos;m Focus Bear</span>
            </div>
            <h1 className="fb-page__title">Privacy and Security</h1>
            <p className="fb-page__subtitle">
              {user?.email ? `You're signed in as ${user.email}. ` : ''}Before we set things up, here is how your data is
              handled.
            </p>
            <ul className="fb-onb__points">
              {PRIVACY_POINTS.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
            <label className="fb-onb__agree">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <span>
                I agree to the terms of the{' '}
                <a href={TERMS_URL} target="_blank" rel="noreferrer">software license agreement</a> and{' '}
                <a href={PRIVACY_URL} target="_blank" rel="noreferrer">Privacy Policy</a>
              </span>
            </label>
            {footer(
              <button type="button" className="fb-btn fb-btn--primary" onClick={acceptPrivacy} disabled={!agreed || busy}>
                {busy ? 'Saving…' : 'Continue'}
              </button>,
              { skip: false },
            )}
          </>
        )}

        {step === 'goals' && (
          <>
            <h1 className="fb-page__title">What do you want to achieve?</h1>
            <p className="fb-page__subtitle">
              Your goals shape the habit ideas you get next. You can change them later under Stats.
            </p>
            {goals.length > 0 && (
              <ul className="fb-onb__goals">
                {goals.map((goal) => (
                  <li key={goal}>
                    <span>{goal}</span>
                    <button
                      type="button"
                      className="fb-icon-btn"
                      aria-label={`Remove goal: ${goal}`}
                      onClick={() => setGoals((prev) => prev.filter((item) => item !== goal))}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {goals.length < MAX_GOALS && (
              <>
                <form
                  className="fb-onb__add"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (goalText.trim()) addGoal(goalText);
                  }}
                >
                  <input
                    className="fb-input"
                    value={goalText}
                    onChange={(e) => setGoalText(e.target.value)}
                    placeholder="Type a goal"
                    aria-label="Type a goal"
                    maxLength={MAX_GOAL_LENGTH}
                  />
                  <button type="submit" className="fb-btn" disabled={!goalText.trim()}>Add</button>
                </form>
                <div className="fb-onb__chips" aria-label="Goal ideas">
                  {GOAL_IDEAS.filter((idea) => !goals.includes(idea)).map((idea) => (
                    <button key={idea} type="button" className="fb-onb__chip" onClick={() => addGoal(idea)}>
                      + {idea}
                    </button>
                  ))}
                </div>
              </>
            )}
            {footer(
              <button
                type="button"
                className="fb-btn fb-btn--primary"
                onClick={saveGoals}
                disabled={busy || (goals.length === 0 && !goalText.trim())}
              >
                {busy ? 'Saving…' : 'Continue'}
              </button>,
            )}
          </>
        )}

        {step === 'occupation' && (
          <>
            <h1 className="fb-page__title">What type of work do you do?</h1>
            <p className="fb-page__subtitle">
              Focus Bear suggests distracting websites to block, and the ones you need for work.
            </p>
            <div className="fb-onb__options" role="radiogroup" aria-label="Type of work">
              {OCCUPATIONS.map((option) => (
                <label key={option.id} className={`fb-onb__option${occupation === option.id ? ' fb-onb__option--on' : ''}`}>
                  <input
                    type="radio"
                    name="occupation"
                    checked={occupation === option.id}
                    onChange={() => setOccupation(option.id)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
            {occupation && (
              <input
                className="fb-input fb-onb__detail"
                value={occupationText}
                onChange={(e) => setOccupationText(e.target.value)}
                placeholder="Tell us more (optional), e.g. nursing student"
                aria-label="More about your work (optional)"
                maxLength={100}
              />
            )}
            {footer(
              <button type="button" className="fb-btn fb-btn--primary" onClick={saveOccupation} disabled={!occupation || busy}>
                {busy ? 'Finding websites…' : "That's me!"}
              </button>,
              { skip: false },
            )}
            {!busy && (
              <button type="button" className="fb-onb__link" onClick={skipOccupation}>
                Skip: I&apos;ll pick the websites myself
              </button>
            )}
          </>
        )}

        {step === 'sites' && (
          <>
            <h1 className="fb-page__title">Choose websites to block</h1>
            <p className="fb-page__subtitle">
              These go on your Super Distracting Sites list. Untick the ones you want to keep; you can change the list
              later under Blocking.
            </p>
            <SitePicker
              sites={blockSites}
              chosen={blockChosen}
              onToggle={toggleIn(setBlockChosen)}
              onAdd={(site) => {
                setBlockSites((prev) => (prev.includes(site) ? prev : [...prev, site]));
                setBlockChosen((prev) => new Set(prev).add(site));
              }}
              addLabel="Another website to block"
            />
            {footer(
              <button type="button" className="fb-btn fb-btn--primary" onClick={saveBlocked} disabled={busy}>
                {busy ? 'Saving…' : `Block ${blockChosen.size} ${blockChosen.size === 1 ? 'website' : 'websites'}`}
              </button>,
            )}
          </>
        )}

        {step === 'work' && (
          <>
            <h1 className="fb-page__title">What websites do you use for work?</h1>
            <p className="fb-page__subtitle">
              They become an allow list called &quot;{WORK_LIST_NAME}&quot;: pick it for a focus session and only these
              websites open.
            </p>
            {workSites.length === 0 && !suggestions?.user_relevant_sites?.length && (
              <p className="fb-onb__note">Add the websites you need, or skip this for now.</p>
            )}
            <SitePicker
              sites={workSites}
              chosen={workChosen}
              onToggle={toggleIn(setWorkChosen)}
              onAdd={(site) => {
                setWorkSites((prev) => (prev.includes(site) ? prev : [...prev, site]));
                setWorkChosen((prev) => new Set(prev).add(site));
              }}
              addLabel="Another website you use for work"
            />
            {footer(
              <button type="button" className="fb-btn fb-btn--primary" onClick={saveWork} disabled={busy || workChosen.size === 0}>
                {busy ? 'Saving…' : "That's all"}
              </button>,
            )}
          </>
        )}

        {step === 'habits' && (
          <>
            <h1 className="fb-page__title">Set up habits to focus better</h1>
            <p className="fb-page__subtitle">
              A short morning and evening routine keeps your day on track. Need some fresh ideas for habits?
            </p>
            <div className="fb-onb__choices">
              <button type="button" className="fb-btn fb-btn--primary fb-btn--block" onClick={() => setHabitMode('recommend')}>
                Yes, suggest habits for me
              </button>
              <button type="button" className="fb-btn fb-btn--block" onClick={() => setHabitMode('import')}>
                No, I&apos;ll add my own habits
              </button>
            </div>
            {footer(null)}
          </>
        )}

        {step === 'done' && (
          <>
            <div className="fb-onb__brand">
              <img src={LOGO} alt="" width="44" height="44" />
            </div>
            <h1 className="fb-page__title">Fantastic! We are all set.</h1>
            <p className="fb-page__subtitle">
              {habitResult === 'failed'
                ? "The habits couldn't be added this time. You can add them later under Edit Habits."
                : habits > 0
                  ? `Your routines have ${habits} ${habits === 1 ? 'habit' : 'habits'}. You'll find them on the Day Plan.`
                  : 'You can add habits any time under Edit Habits.'}{' '}
              Next up: your first focus session.
            </p>
            {footer(
              <button type="button" className="fb-btn fb-btn--primary" onClick={finish} disabled={busy}>
                {busy ? 'Starting…' : 'Start using Focus Bear'}
              </button>,
              { skip: false },
            )}
          </>
        )}
      </div>
    </div>
  );
}

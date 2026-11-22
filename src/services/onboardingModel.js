// First-run onboarding after sign-up: which steps there are, when to show them,
// and the request bodies. The steps and calls come from the Windows app
// (Onboarding/*.xaml.cs, App.xaml.cs ProceedAfterLogin / ExecutePostLoginTasks,
// Core/Onboarding/BlockListSetupFlow.cs):
//
//   Privacy and Security      PUT  /user/consent  (terms_of_service, privacy_policy)
//   Goals                     PATCH /user/long-term-goals  { goals: [] }
//   What type of work…        POST /user/generate-occupation-specific-relevant-sites
//   Choose websites to block  kArrBlockedUrls in the account's device settings
//   Websites used for work    POST /focus-mode  (an allow list called "Work")
//   Habit ideas               dashboard /webview/routine-suggestion-revamp
//   All set                   PUT  /user-settings?device_id=&is_onboarding=true
//
// Pure functions only (no React, no fetch), covered by node --test.

export const STEPS = ['privacy', 'goals', 'occupation', 'sites', 'work', 'habits', 'done'];

/** The step after `step` (the last one stays where it is). */
export function nextStep(step) {
  const index = STEPS.indexOf(step);
  if (index < 0) return STEPS[0];
  return STEPS[Math.min(index + 1, STEPS.length - 1)];
}

export function previousStep(step) {
  const index = STEPS.indexOf(step);
  return STEPS[Math.max(index - 1, 0)];
}

function parseObject(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

/**
 * Whether to show onboarding to the account that just signed in. Like the
 * Windows app: an account that already has desktop settings on the server (the
 * "MacOS" object of GET /user-local-device-settings) or that finished the web
 * onboarding is a returning user. `localSettings.onboardingDone[userId]` is set
 * once the flow was finished or skipped on this computer.
 */
export function needsOnboarding({ deviceSettings, localSettings, userId, force = false }) {
  if (force) return true;
  const done = localSettings && typeof localSettings.onboardingDone === 'object' && localSettings.onboardingDone;
  if (done && done[userId || '']) return false;
  // Settings couldn't be read: don't put an existing user through onboarding.
  if (!deviceSettings || typeof deviceSettings !== 'object') return false;
  if (Object.keys(parseObject(deviceSettings.MacOS)).length > 0) return false;
  const web = parseObject(deviceSettings.Web);
  if (web.onboarding && web.onboarding.currentStep === 'completed') return false;
  return true;
}

/** The `onboardingDone` value to save locally once `userId` is through (other accounts are kept). */
export function withOnboardingDone(localSettings, userId) {
  const done = localSettings && typeof localSettings.onboardingDone === 'object' && localSettings.onboardingDone;
  return { ...(done || {}), [userId || '']: true };
}

// --- privacy ------------------------------------------------------------------

export const TERMS_URL = 'https://www.focusbear.io/terms-of-service';
export const PRIVACY_URL = 'https://www.focusbear.io/privacy-policy';
export const PRIVACY_POINTS = [
  'We never track which sites or apps you visit.',
  'Your data syncs across devices so blocking works everywhere.',
  'Your data is encrypted and yours alone.',
];

/** Bodies of the two PUT /user/consent calls. consent_status is the string "true", as the other apps send it. */
export function consentBodies(operatingSystem = 'linux') {
  return ['terms_of_service', 'privacy_policy'].map((type) => ({
    consent_type: type,
    consent_status: 'true',
    metadata: { policy_version: '1.0.0', operating_system: operatingSystem },
  }));
}

// --- goals ----------------------------------------------------------------------

export const MAX_GOALS = 5;
export const MAX_GOAL_LENGTH = 200;
export const GOAL_IDEAS = [
  'Get more deep work done',
  'Spend less time on social media',
  'Build a morning routine',
  'Take regular breaks',
  'Finish work on time',
];

/** Trimmed, de-duplicated goals, at most five. */
export function cleanGoals(goals) {
  const seen = new Set();
  const list = [];
  for (const goal of Array.isArray(goals) ? goals : []) {
    const text = String(goal ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_GOAL_LENGTH);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    list.push(text);
    if (list.length === MAX_GOALS) break;
  }
  return list;
}

/** Body of PATCH /user/long-term-goals. */
export function goalsBody(goals) {
  return { goals: cleanGoals(goals) };
}

// --- blocking -------------------------------------------------------------------

/** "What type of work do you do?" (Onboarding/AskOccupation.xaml.cs). */
export const OCCUPATIONS = [
  { id: 'student', label: 'Student' },
  { id: 'business owner', label: 'Business owner' },
  { id: 'employee', label: 'Employee' },
  { id: 'freelancer', label: 'Freelancer' },
  { id: 'other', label: 'Other' },
];

/** Body of POST /user/generate-occupation-specific-relevant-sites: what was typed, else the chosen option. */
export function occupationBody(choiceId, typed = '') {
  const text = String(typed ?? '').trim().slice(0, 100);
  const known = OCCUPATIONS.some((option) => option.id === choiceId) ? choiceId : 'other';
  return { user_occupation: text || known };
}

/** The sites the Windows "Choose websites to block" page offers, all ticked. */
export const DEFAULT_DISTRACTIONS = [
  'facebook.com',
  'x.com',
  'instagram.com',
  'tiktok.com',
  'bbc.com',
  'cnn.com',
  'reddit.com',
  'youtube.com',
];

/** "https://www.YouTube.com/watch" -> "youtube.com". '' when it isn't a site. */
export function cleanSite(value) {
  let site = String(value ?? '').trim().toLowerCase();
  site = site.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '');
  site = site.split(/[/?#\s]/)[0];
  if (!site.includes('.') || site.startsWith('.') || site.endsWith('.')) return '';
  return site;
}

function uniqueSites(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const entry of Array.isArray(list) ? list : []) {
      const site = cleanSite(entry);
      if (!site || seen.has(site)) continue;
      seen.add(site);
      out.push(site);
    }
  }
  return out;
}

/**
 * The sites to offer for blocking: what is already blocked, the eight defaults,
 * then the server's suggestions for the occupation (`user_typical_distractions`).
 */
export function distractionChoices(suggestions, alreadyBlocked = []) {
  return uniqueSites(alreadyBlocked, DEFAULT_DISTRACTIONS, suggestions?.user_typical_distractions);
}

/** The work sites to offer (`user_relevant_sites`), minus anything chosen for blocking. */
export function workSiteChoices(suggestions, blocked = []) {
  const taken = new Set(uniqueSites(blocked));
  return uniqueSites(suggestions?.user_relevant_sites).filter((site) => !taken.has(site));
}

/**
 * The account's block list (kArrBlockedUrls: sites and keywords) after the
 * "Choose websites to block" step. Sites that were offered and unticked are
 * removed; keywords and sites that weren't offered are kept.
 */
export function mergeBlocked(current, offered, chosen) {
  const offeredSet = new Set(uniqueSites(offered));
  const chosenList = uniqueSites(chosen);
  const kept = (Array.isArray(current) ? current : []).filter(
    (entry) => typeof entry === 'string' && entry.trim() && !offeredSet.has(cleanSite(entry)),
  );
  return [...kept, ...chosenList.filter((site) => !kept.includes(site))];
}

export const WORK_LIST_NAME = 'Work';

/**
 * Where the "work sites" step puts its sites: { reuse: list } when the account
 * already has an allow list called Work (any case), else { create: name } with
 * a name no list has yet. A block list or a built-in list that happens to be
 * called "Work" is never reused: the step used to write the work sites into
 * it, replacing its blocked sites with sites that were then blocked.
 * `lists` are the account's block lists (GET /user/focus-modes).
 */
export function workListPlan(lists) {
  const all = (Array.isArray(lists) ? lists : []).filter((mode) => mode && typeof mode.name === 'string');
  const named = (name) => all.filter((mode) => mode.name.trim().toLowerCase() === name.toLowerCase());
  const isAllowList = (mode) => {
    const m = mode.metadata && typeof mode.metadata === 'object' ? mode.metadata : {};
    const builtIn = m.isDefault || m.isMeetings || m.isLockedFocus || m.isRelaxFocus || m.isDeepWorkFocus;
    return m.isAllowedListApproach === true && !builtIn;
  };
  const reuse = named(WORK_LIST_NAME).find(isAllowList);
  if (reuse) return { reuse };
  if (named(WORK_LIST_NAME).length === 0) return { create: WORK_LIST_NAME };
  for (const name of ['Work sites', ...Array.from({ length: 20 }, (_, i) => `Work sites ${i + 2}`)]) {
    const taken = named(name);
    const again = taken.find(isAllowList);
    if (again) return { reuse: again };
    if (taken.length === 0) return { create: name };
  }
  return { create: `Work sites ${Date.now()}` };
}

// --- habits ---------------------------------------------------------------------

/** Dashboard page ids (src/electron/webview-ids.js) for the two ways into the habit ideas page. */
export const HABIT_WEBVIEWS = { recommend: 'routine-suggestion-recommend', import: 'routine-suggestion-import' };

/**
 * What the habit ideas page told the app (the same strings the Windows app
 * listens for): 'installed' | 'failed' | 'resend' (send the sign-in data again) | null.
 */
export function routineMessageKind(message) {
  const text = typeof message === 'string' ? message : message && typeof message === 'object' ? message.type || message.message || message.event : '';
  if (text === 'routine-suggestions-installed-successfully') return 'installed';
  if (text === 'routine-suggestions-installation-failed') return 'failed';
  if (text === 'invoke-js-function') return 'resend';
  return null;
}

/** How many habits the account has in its routines (GET /user-settings). */
export function habitCount(settings) {
  const config = settings || {};
  let count = 0;
  for (const key of ['morning_activities', 'evening_activities']) {
    if (Array.isArray(config[key])) count += config[key].length;
  }
  for (const routine of Array.isArray(config.custom_routines) ? config.custom_routines : []) {
    if (Array.isArray(routine?.standalone_activities)) count += routine.standalone_activities.length;
  }
  return count;
}

/**
 * Body of the PUT /user-settings?is_onboarding=true that ends onboarding, or
 * null when nothing needs saving. An account that ends up without habits gets a
 * break every 60 minutes, as the Windows "All set" page does.
 */
export function finishSettingsBody(settings) {
  if (!settings || typeof settings !== 'object') return null;
  if (habitCount(settings) > 0) return null;
  return { ...settings, break_after_minutes: 60 };
}

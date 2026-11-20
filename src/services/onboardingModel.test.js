import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DISTRACTIONS,
  STEPS,
  cleanGoals,
  cleanSite,
  consentBodies,
  distractionChoices,
  finishSettingsBody,
  goalsBody,
  habitCount,
  mergeBlocked,
  needsOnboarding,
  nextStep,
  occupationBody,
  previousStep,
  routineMessageKind,
  withOnboardingDone,
  workSiteChoices,
} from './onboardingModel.js';
import { createOnboardingApi } from './onboardingApiCore.js';
import { parseWebViewMessage } from '../electron/webview-messages.js';

const USER = 'auth0|abc';

// --- when to show it ----------------------------------------------------------

test('a new account (no desktop settings on the server) gets onboarding', () => {
  assert.equal(needsOnboarding({ deviceSettings: {}, localSettings: {}, userId: USER }), true);
  assert.equal(needsOnboarding({ deviceSettings: { MacOS: null, Web: null }, localSettings: null, userId: USER }), true);
  assert.equal(needsOnboarding({ deviceSettings: { MacOS: {} }, localSettings: {}, userId: USER }), true);
  assert.equal(needsOnboarding({ deviceSettings: { MacOS: '{}' }, localSettings: {}, userId: USER }), true);
});

test('an account with desktop settings is a returning user', () => {
  const deviceSettings = { MacOS: { kArrBlockedUrls: ['facebook.com'] } };
  assert.equal(needsOnboarding({ deviceSettings, localSettings: {}, userId: USER }), false);
  assert.equal(needsOnboarding({ deviceSettings: { MacOS: '{"kCuddlyModeEnabled":true}' }, localSettings: {}, userId: USER }), false);
});

test('an account that finished the web onboarding is a returning user', () => {
  const deviceSettings = { MacOS: null, Web: { onboarding: { currentStep: 'completed' } } };
  assert.equal(needsOnboarding({ deviceSettings, localSettings: {}, userId: USER }), false);
  const halfway = { MacOS: null, Web: { onboarding: { currentStep: 'data-privacy' } } };
  assert.equal(needsOnboarding({ deviceSettings: halfway, localSettings: {}, userId: USER }), true);
});

test('onboarding is not shown again once done or skipped on this computer, per account', () => {
  const localSettings = { onboardingDone: withOnboardingDone({}, USER) };
  assert.equal(needsOnboarding({ deviceSettings: {}, localSettings, userId: USER }), false);
  assert.equal(needsOnboarding({ deviceSettings: {}, localSettings, userId: 'auth0|other' }), true);
  assert.deepEqual(withOnboardingDone({ onboardingDone: { 'auth0|other': true } }, USER), { 'auth0|other': true, [USER]: true });
});

test('when the settings could not be read nobody is put through onboarding, unless forced', () => {
  assert.equal(needsOnboarding({ deviceSettings: null, localSettings: {}, userId: USER }), false);
  assert.equal(needsOnboarding({ deviceSettings: null, localSettings: { onboardingDone: { [USER]: true } }, userId: USER, force: true }), true);
});

test('steps run in order and stop at the ends', () => {
  assert.equal(nextStep('privacy'), 'goals');
  assert.equal(nextStep('habits'), 'done');
  assert.equal(nextStep('done'), 'done');
  assert.equal(previousStep('privacy'), 'privacy');
  assert.equal(previousStep('sites'), 'occupation');
  assert.equal(nextStep('nonsense'), STEPS[0]);
});

// --- bodies -------------------------------------------------------------------

test('consent is sent for the terms and the privacy policy, with "true" as a string', () => {
  assert.deepEqual(consentBodies(), [
    { consent_type: 'terms_of_service', consent_status: 'true', metadata: { policy_version: '1.0.0', operating_system: 'linux' } },
    { consent_type: 'privacy_policy', consent_status: 'true', metadata: { policy_version: '1.0.0', operating_system: 'linux' } },
  ]);
});

test('goals are trimmed, de-duplicated and capped at five', () => {
  assert.deepEqual(cleanGoals(['  Ship  the app ', 'ship the app', '', null, 'Sleep']), ['Ship the app', 'Sleep']);
  assert.equal(cleanGoals(['a', 'b', 'c', 'd', 'e', 'f']).length, 5);
  assert.deepEqual(goalsBody(['One ']), { goals: ['One'] });
  assert.deepEqual(goalsBody(null), { goals: [] });
});

test('the occupation sent is what was typed, else the chosen option', () => {
  assert.deepEqual(occupationBody('student', ''), { user_occupation: 'student' });
  assert.deepEqual(occupationBody('employee', ' Nurse '), { user_occupation: 'Nurse' });
  assert.deepEqual(occupationBody('astronaut', ''), { user_occupation: 'other' });
});

// --- sites ----------------------------------------------------------------------

test('cleanSite strips the scheme, www and the path', () => {
  assert.equal(cleanSite('https://www.YouTube.com/watch?v=1'), 'youtube.com');
  assert.equal(cleanSite(' reddit.com '), 'reddit.com');
  assert.equal(cleanSite('gossip'), '');
  assert.equal(cleanSite(''), '');
  assert.equal(cleanSite('.com'), '');
});

test('the sites offered for blocking: already blocked, the eight defaults, then the suggestions', () => {
  const offered = distractionChoices({ user_typical_distractions: ['netflix.com', 'YouTube.com', 'twitch.tv'] }, ['news.example.com', 'gossip']);
  assert.equal(offered[0], 'news.example.com');
  assert.deepEqual(offered.slice(1, 9), DEFAULT_DISTRACTIONS);
  assert.deepEqual(offered.slice(9), ['netflix.com', 'twitch.tv']);
  assert.deepEqual(distractionChoices(null), DEFAULT_DISTRACTIONS);
});

test('work sites leave out anything that is blocked', () => {
  assert.deepEqual(workSiteChoices({ user_relevant_sites: ['moodle.org', 'youtube.com', 'moodle.org'] }, ['youtube.com']), ['moodle.org']);
  assert.deepEqual(workSiteChoices(null), []);
});

test('saving the blocked sites keeps keywords and sites that were not offered, and drops unticked ones', () => {
  const current = ['facebook.com', 'x.com', 'celebrity', 'intranet.example.com'];
  const offered = ['facebook.com', 'x.com', 'reddit.com'];
  assert.deepEqual(mergeBlocked(current, offered, ['facebook.com', 'reddit.com']), [
    'celebrity',
    'intranet.example.com',
    'facebook.com',
    'reddit.com',
  ]);
  assert.deepEqual(mergeBlocked(null, offered, []), []);
});

// --- habits ---------------------------------------------------------------------

test('messages of the habit ideas page', () => {
  assert.equal(routineMessageKind('routine-suggestions-installed-successfully'), 'installed');
  assert.equal(routineMessageKind('routine-suggestions-installation-failed'), 'failed');
  assert.equal(routineMessageKind('invoke-js-function'), 'resend');
  assert.equal(routineMessageKind({ type: 'routine-suggestions-installed-successfully' }), 'installed');
  assert.equal(routineMessageKind({ step: 2 }), null);
  assert.equal(routineMessageKind(null), null);
});

test('a page message travels through the console with a marker; other lines are ignored', () => {
  assert.equal(parseWebViewMessage('__focusbear_webview_message__"routine-suggestions-installed-successfully"'), 'routine-suggestions-installed-successfully');
  assert.deepEqual(parseWebViewMessage('__focusbear_webview_message__{"step":1}'), { step: 1 });
  assert.equal(parseWebViewMessage('hello'), undefined);
  assert.equal(parseWebViewMessage('__focusbear_webview_message__{broken'), undefined);
});

test('habits are counted across the morning, evening and custom routines', () => {
  assert.equal(habitCount(null), 0);
  assert.equal(
    habitCount({ morning_activities: [{}, {}], evening_activities: [{}], custom_routines: [{ standalone_activities: [{}] }, {}] }),
    4,
  );
});

test('an account that ends onboarding without habits gets a break every 60 minutes', () => {
  assert.deepEqual(finishSettingsBody({ break_after_minutes: 20, morning_activities: [] }), { break_after_minutes: 60, morning_activities: [] });
  assert.equal(finishSettingsBody({ break_after_minutes: 20, morning_activities: [{}] }), null);
  assert.equal(finishSettingsBody(null), null);
});

// --- API ------------------------------------------------------------------------

function recorder(answers = {}) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path.split('?')[0]}`;
    if (answers[key] instanceof Error) throw answers[key];
    return answers[key] ?? null;
  };
  return { request, calls };
}

test('the API sends both consents, the goals and the occupation', async () => {
  const { request, calls } = recorder({
    'POST /user/generate-occupation-specific-relevant-sites': { user_relevant_sites: ['moodle.org'] },
    'GET /user/long-term-goals': ['Ship it', { goal: 'Sleep' }],
  });
  const api = createOnboardingApi({ request, getDeviceId: async () => 'dev-1' });
  await api.sendConsent();
  await api.saveGoals(['Ship it']);
  assert.deepEqual(await api.getGoals(), ['Ship it', 'Sleep']);
  assert.deepEqual(await api.suggestSites('student', ''), { user_relevant_sites: ['moodle.org'], user_typical_distractions: [] });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      'PUT /user/consent',
      'PUT /user/consent',
      'PATCH /user/long-term-goals',
      'GET /user/long-term-goals',
      'POST /user/generate-occupation-specific-relevant-sites',
    ],
  );
  assert.deepEqual(calls[2].body, { goals: ['Ship it'] });
  assert.deepEqual(calls[4].body, { user_occupation: 'student' });
});

test('finishing saves the settings only for an account without habits', async () => {
  const empty = recorder({ 'GET /user-settings': { break_after_minutes: 15, morning_activities: [] } });
  await createOnboardingApi({ request: empty.request, getDeviceId: async () => 'dev-1' }).finish();
  assert.equal(empty.calls[1].method, 'PUT');
  assert.equal(empty.calls[1].path, '/user-settings?device_id=dev-1&is_onboarding=true');
  assert.equal(empty.calls[1].body.break_after_minutes, 60);

  const withHabits = recorder({ 'GET /user-settings': { break_after_minutes: 15, morning_activities: [{}] } });
  await createOnboardingApi({ request: withHabits.request, getDeviceId: async () => 'dev-1' }).finish();
  assert.equal(withHabits.calls.length, 1);
});

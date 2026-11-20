// Settings that do something on Linux (#144): Strictness, Accessibility, focus music, Account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELETE_WORD,
  autoPlayTrack,
  canDeleteAccount,
  hasPassword,
  musicAction,
  normaliseBearMode,
  normaliseMusicChoice,
  resetPasswordBody,
} from './settingsModel.js';
import { fromDeviceSettings, toDeviceSettings } from './blocklist.js';
import { defaultStrictness } from '../electron/focusSessionModel.js';

test('Cuddly or Grizzly decides the strictness a new focus session starts on', () => {
  assert.equal(normaliseBearMode('grizzly'), 'grizzly');
  assert.equal(normaliseBearMode(undefined), 'cuddly');
  assert.equal(defaultStrictness('', normaliseBearMode('grizzly')), 'pawfessor');
  assert.equal(defaultStrictness('', normaliseBearMode('cuddly')), 'junior');
});

test('the new settings use the keys of the other apps in the account settings', () => {
  const device = toDeviceSettings({ kOther: 1 }, { reducedMotion: true, focusMusicAutoStart: 'play', selectedBearMode: 'grizzly' });
  assert.deepEqual(device, { kOther: 1, kCuddlyModeEnabled: false, kIsReducedMotion: true, kFocusMusicAutoStartPreference: 'play' });
  assert.deepEqual(fromDeviceSettings({ kIsReducedMotion: true, kFocusMusicAutoStartPreference: 'off' }), {
    reducedMotion: true,
    focusMusicAutoStart: 'off',
  });
  // unknown values are left alone
  assert.deepEqual(fromDeviceSettings({ kIsReducedMotion: 'yes', kFocusMusicAutoStartPreference: 'loud' }), {});
  assert.deepEqual(toDeviceSettings({}, { focusMusicAutoStart: 'loud' }), {});
});

test('focus music at session start: play, ask or nothing, once per session', () => {
  assert.equal(normaliseMusicChoice(undefined), 'ask');
  assert.equal(normaliseMusicChoice('play'), 'play');
  const at = (extra) => musicAction({ choice: 'play', sessionKey: '100', handledKey: '', playing: false, ...extra });
  assert.equal(at({}), 'play');
  assert.equal(at({ choice: 'ask' }), 'ask');
  assert.equal(at({ choice: 'nonsense' }), 'ask');
  assert.equal(at({ choice: 'off' }), 'nothing');
  assert.equal(at({ playing: true }), 'nothing'); // music already on
  assert.equal(at({ handledKey: '100' }), 'nothing'); // the app restarted during the session
  assert.equal(at({ sessionKey: '' }), 'nothing'); // no session
});

test('the track that starts by itself: the last one played, else a random one', () => {
  const tracks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(autoPlayTrack(tracks, 'b').id, 'b');
  assert.equal(autoPlayTrack(tracks, 'gone', () => 0.99).id, 'c');
  assert.equal(autoPlayTrack(tracks, null, () => 0).id, 'a');
  assert.equal(autoPlayTrack([], 'a'), null);
});

test('deleting the account needs DELETE typed exactly', () => {
  assert.equal(DELETE_WORD, 'DELETE');
  assert.equal(canDeleteAccount('DELETE'), true);
  assert.equal(canDeleteAccount('delete'), false);
  assert.equal(canDeleteAccount(' DELETE'), false);
  assert.equal(canDeleteAccount(''), false);
});

test('a password reset goes to the account email, for password accounts only', () => {
  assert.deepEqual(resetPasswordBody(' qa@example.com '), { email: 'qa@example.com' });
  assert.equal(resetPasswordBody(''), null);
  assert.equal(resetPasswordBody(undefined), null);
  assert.equal(hasPassword({ sub: 'auth0|abc' }), true);
  assert.equal(hasPassword({ sub: 'google-oauth2|123' }), false);
  assert.equal(hasPassword(null), false);
});

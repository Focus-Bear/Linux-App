import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addEntry,
  fromDeviceSettings,
  isKeywordEntry,
  keywordError,
  keywordsOf,
  normaliseKeyword,
  parseDeviceSettings,
  removeFromView,
  siteError,
  sitesOf,
  toDeviceSettings,
} from './blocklist.js';

const LIST = ['facebook.com', 'celebrity', '*.reddit.com', 'gossip', 'x.com'];

test('an entry without a dot is a keyword, like the Mac and Windows block lists', () => {
  assert.equal(isKeywordEntry('celebrity'), true);
  assert.equal(isKeywordEntry('facebook.com'), false);
  assert.equal(isKeywordEntry('*.reddit.com'), false);
  assert.equal(isKeywordEntry(''), false);
  assert.equal(isKeywordEntry('   '), false);
  assert.equal(isKeywordEntry(undefined), false);
});

test('the two pages show disjoint views of one list (#147)', () => {
  assert.deepEqual(sitesOf(LIST), ['facebook.com', '*.reddit.com', 'x.com']);
  assert.deepEqual(keywordsOf(LIST), ['celebrity', 'gossip']);
  assert.equal(sitesOf(LIST).length + keywordsOf(LIST).length, LIST.length);
  assert.deepEqual(sitesOf(undefined), []);
  assert.deepEqual(keywordsOf(undefined), []);
});

test('adding keeps order and ignores blanks and duplicates', () => {
  assert.deepEqual(addEntry(['a.com'], ' news '), ['a.com', 'news']);
  assert.deepEqual(addEntry(['a.com'], 'a.com'), ['a.com']);
  assert.deepEqual(addEntry(['a.com'], '   '), ['a.com']);
  assert.deepEqual(addEntry(undefined, 'news'), ['news']);
});

test('removing a keyword by its position on the keyword page leaves the sites alone', () => {
  const next = removeFromView(LIST, keywordsOf(LIST), new Set([0]));
  assert.deepEqual(next, ['facebook.com', '*.reddit.com', 'gossip', 'x.com']);
});

test('removing sites by their position on the sites page leaves the keywords alone', () => {
  const next = removeFromView(LIST, sitesOf(LIST), new Set([0, 2]));
  assert.deepEqual(next, ['celebrity', '*.reddit.com', 'gossip']);
});

test('removing nothing returns the same list', () => {
  assert.equal(removeFromView(LIST, sitesOf(LIST), new Set()), LIST);
  assert.equal(removeFromView(LIST, sitesOf(LIST), new Set([99])), LIST);
});

test('keywords are trimmed and lower-cased', () => {
  assert.equal(normaliseKeyword('  Celebrity '), 'celebrity');
  assert.equal(normaliseKeyword(null), '');
});

test('keyword validation explains what is wrong', () => {
  assert.equal(keywordError('celebrity', LIST), 'That keyword is already on your list.');
  assert.equal(keywordError('CELEBRITY', LIST), 'That keyword is already on your list.');
  assert.match(keywordError('facebook.com', LIST), /website/);
  assert.match(keywordError('two words', LIST), /single word/);
  assert.match(keywordError('ab', LIST), /at least 3/);
  assert.match(keywordError('  ', LIST), /Type a keyword/);
  assert.equal(keywordError('shopping', LIST), null);
});

test('site validation sends single words to Keyword Blocking', () => {
  assert.match(siteError('facebook', LIST), /Keyword Blocking/);
  assert.equal(siteError('facebook.com', LIST), 'That site is already on your list.');
  assert.match(siteError('my site.com', LIST), /no spaces/);
  assert.match(siteError('', LIST), /Type a website/);
  assert.equal(siteError('news.example.org', LIST), null);
  assert.equal(siteError('*.example.org', LIST), null);
});

test('device settings parse from an object or a JSON string', () => {
  assert.deepEqual(parseDeviceSettings('{"kArrBlockedUrls":["a.com"]}'), { kArrBlockedUrls: ['a.com'] });
  assert.deepEqual(parseDeviceSettings({ kTabLimitCount: 3 }), { kTabLimitCount: 3 });
  assert.deepEqual(parseDeviceSettings('not json'), {});
  assert.deepEqual(parseDeviceSettings(null), {});
  assert.deepEqual(parseDeviceSettings('"text"'), {});
});

test('device settings map to synced states, keywords included', () => {
  const mapped = fromDeviceSettings({
    kArrBlockedUrls: ['facebook.com', 'celebrity', 7],
    kCuddlyModeEnabled: false,
    kImmediatelyBlockDistractingSites: true,
  });
  assert.deepEqual(mapped, {
    urlList: ['facebook.com', 'celebrity'],
    selectedBearMode: 'grizzly',
    immediatelyBlock: true,
  });
  assert.deepEqual(keywordsOf(mapped.urlList), ['celebrity']);
});

test('keys the server does not have are left to the defaults', () => {
  assert.deepEqual(fromDeviceSettings({}), {});
  assert.deepEqual(fromDeviceSettings({ kImmediatelyBlockDistractingSites: 'yes' }), {});
});

test('saving writes the block list and the immediate-block flag and keeps other keys (#148)', () => {
  const before = { kTabLimitCount: 3, kArrBlockedUrls: ['old.com'], kImmediatelyBlockDistractingSites: false };
  const after = toDeviceSettings(before, {
    urlList: ['facebook.com', 'celebrity'],
    selectedBearMode: 'cuddly',
    immediatelyBlock: true,
  });
  assert.deepEqual(after, {
    kTabLimitCount: 3,
    kArrBlockedUrls: ['facebook.com', 'celebrity'],
    kCuddlyModeEnabled: true,
    kImmediatelyBlockDistractingSites: true,
  });
  assert.equal(before.kImmediatelyBlockDistractingSites, false, 'input is not mutated');
});

test('a round trip through the device settings keeps the values', () => {
  const settings = { urlList: ['a.com', 'news'], selectedBearMode: 'grizzly', immediatelyBlock: true };
  assert.deepEqual(fromDeviceSettings(toDeviceSettings({}, settings)), settings);
});

test('the usual session length is read from and written as the string the other apps use', () => {
  assert.equal(fromDeviceSettings({ kPomodoroDurationMinutes: '45' }).pomodoroMinutes, 45);
  assert.equal(fromDeviceSettings({ kPomodoroDurationMinutes: 50 }).pomodoroMinutes, 50);
  assert.equal(fromDeviceSettings({ kPomodoroDurationMinutes: '9999' }).pomodoroMinutes, 480);
  assert.equal('pomodoroMinutes' in fromDeviceSettings({ kPomodoroDurationMinutes: 'x' }), false);
  assert.equal('pomodoroMinutes' in fromDeviceSettings({ kPomodoroDurationMinutes: null }), false);
  assert.equal('pomodoroMinutes' in fromDeviceSettings({ kPomodoroDurationMinutes: 0 }), false);
  assert.equal(toDeviceSettings({}, { pomodoroMinutes: 30 }).kPomodoroDurationMinutes, '30');
  assert.equal('kPomodoroDurationMinutes' in toDeviceSettings({}, {}), false);
  assert.equal(toDeviceSettings({ kPomodoroDurationMinutes: '50' }, { urlList: [] }).kPomodoroDurationMinutes, '50', 'kept when not being changed');
});

test('an empty list is saved as empty, not skipped', () => {
  assert.deepEqual(toDeviceSettings({ kArrBlockedUrls: ['a.com'] }, { urlList: [] }).kArrBlockedUrls, []);
});

test('Breaks settings use the Windows keys and keep their defaults when the account has none', () => {
  assert.deepEqual(fromDeviceSettings({ kUserdefaultsBreaksEnabledFromOnboarding: false, kBreakAutoStartEnabled: true }), {
    breaksEnabled: false,
    breakAutoStart: true,
  });
  assert.deepEqual(fromDeviceSettings({ kUserdefaultsBreaksEnabledFromOnboarding: 'no' }), {});
  const saved = toDeviceSettings({ kIsOfficeModeEnabled: true }, { breaksEnabled: false, breakAutoStart: true });
  assert.deepEqual(saved, {
    kIsOfficeModeEnabled: true,
    kUserdefaultsBreaksEnabledFromOnboarding: false,
    kBreakAutoStartEnabled: true,
  });
  assert.deepEqual(toDeviceSettings({ a: 1 }, {}), { a: 1 });
});

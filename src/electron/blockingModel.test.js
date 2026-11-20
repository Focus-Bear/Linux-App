import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeBlocking,
  allListsBody,
  daysSummary,
  effectiveBlocking,
  entryError,
  governingSchedule,
  isBuiltIn,
  isScheduleActive,
  listBody,
  listCount,
  listEntries,
  listKind,
  listNameError,
  listSummary,
  matchesEntry,
  minutesToWire,
  newListBody,
  normaliseEntry,
  overlappingSchedules,
  scheduleBody,
  scheduleDays,
  scheduleDraft,
  scheduleError,
  timeSummary,
  timeToMinutes,
  visibleLists,
  wireToInput,
  withEntries,
  withKind,
  withName,
} from './blockingModel.js';
import { ALLOW_ONLY_LIFETIME_MS, blockSettingsMessage, normaliseBlockSettings } from './blockSettings.js';
import { createBlockingApi } from '../services/blockingApiCore.js';

const ID = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const DEFAULT = { id: ID(1), name: 'Block super distracting sites/apps', allowed_urls: [], metadata: { isDefault: true, isAllowedListApproach: true, blockUrlsArray: [] } };
const SOCIAL = { id: ID(2), name: 'Social', allowed_urls: [], metadata: { isAllowedListApproach: false, blockUrlsArray: ['reddit.com', 'news'] } };
const STUDY = { id: ID(3), name: 'Study', allowed_urls: ['docs.google.com', 'wikipedia.org'], metadata: { isAllowedListApproach: true, blockUrlsArray: ['wikipedia.org/wiki/Special'] }, categories: [] };
const RELAX = { id: ID(4), name: 'Relax', allowed_urls: [], metadata: { isRelaxFocus: true } };
const MEETINGS = { id: ID(5), name: 'Meetings', allowed_urls: [], metadata: { isMeetings: true } };
const MODES = [SOCIAL, STUDY, DEFAULT, RELAX, MEETINGS];

// 2026-11-23 is a Monday.
const at = (day, time) => new Date(`2026-11-${day}T${time}:00`);
const schedule = (extra = {}) => ({
  id: 's1',
  name: 'Work hours',
  start_time: '09:00:00',
  end_time: '17:00:00',
  days_of_week: [1, 2, 3, 4, 5],
  focus_mode_id: SOCIAL.id,
  block_level: 'gentle',
  ...extra,
});

// --- lists ---------------------------------------------------------------------

test('a list is default, relax, an allow list or a block list', () => {
  assert.equal(listKind(DEFAULT), 'default'); // its allow-list flag is ignored, as on Windows
  assert.equal(listKind(RELAX), 'relax');
  assert.equal(listKind(STUDY), 'allow');
  assert.equal(listKind(SOCIAL), 'block');
  assert.equal(listKind({ id: 'x' }), 'block');
});

test('built-in lists cannot be renamed or deleted; Meetings and Locked Focus are not offered', () => {
  assert.equal(isBuiltIn(DEFAULT), true);
  assert.equal(isBuiltIn(RELAX), true);
  assert.equal(isBuiltIn({ metadata: { isDeepWorkFocus: true } }), true);
  assert.equal(isBuiltIn(SOCIAL), false);
  assert.deepEqual(visibleLists(MODES).map((m) => m.name), ['Block super distracting sites/apps', 'Social', 'Study', 'Relax']);
  assert.deepEqual(visibleLists([{ id: 'a', name: ' ' }, null, { name: 'no id' }]), []);
});

test('the editor shows allowed sites for an allow list and blocked sites for a block list', () => {
  assert.deepEqual(listEntries(STUDY), ['docs.google.com', 'wikipedia.org']);
  assert.deepEqual(listEntries(SOCIAL), ['reddit.com', 'news']);
  assert.deepEqual(listEntries(DEFAULT), []);
  assert.equal(listCount(STUDY), '2 allowed');
  assert.equal(listCount(SOCIAL), '2 blocks');
  assert.equal(listCount(withEntries(SOCIAL, ['a.com'])), '1 block');
  assert.equal(listCount(DEFAULT), '');
});

test('entries are stored without scheme, www and trailing slash, in lower case', () => {
  assert.equal(normaliseEntry(' https://www.Reddit.com/ '), 'reddit.com');
  assert.equal(normaliseEntry('http://google.com/Maps//'), 'google.com/maps');
  assert.equal(normaliseEntry(null), '');
});

test('entries that cannot be added', () => {
  assert.equal(entryError('', []), 'Type a website first.');
  assert.equal(entryError('two words', []), 'Web addresses have no spaces.');
  assert.equal(entryError('ab', []), 'Use at least 3 characters, or too many pages will match.');
  assert.equal(entryError('https://www.reddit.com/', ['reddit.com']), 'That is already on this list.');
  assert.equal(entryError('github.com', ['reddit.com']), null);
});

test('list names: required, at most 45 characters, no duplicates whatever the case', () => {
  assert.equal(listNameError('  ', MODES), 'Give the block list a name.');
  assert.equal(listNameError('x'.repeat(46), MODES), 'Use 45 characters or fewer.');
  assert.equal(listNameError('social', MODES), 'Focus Mode with the same name already exists.');
  assert.equal(listNameError('social', MODES, SOCIAL.id), null); // renaming itself
  assert.equal(listNameError('Writing', MODES), null);
});

test('a new list is created with the Windows defaults, as a block list or an allow list', () => {
  const block = newListBody(ID(9), ' Writing ', 'block');
  assert.equal(block.name, 'Writing');
  assert.deepEqual(block.allowed_urls, []);
  assert.equal(block.metadata.isAllowedListApproach, false);
  assert.equal(block.metadata.isDefault, false);
  assert.equal(block.metadata.isAllowedAllApps, true);
  assert.equal(block.metadata.color, 'A3FFA1');
  assert.equal(newListBody(ID(9), 'Study', 'allow').metadata.isAllowedListApproach, true);
});

test('editing a list changes only its own field and keeps the rest of the metadata', () => {
  const mode = { ...SOCIAL, metadata: { ...SOCIAL.metadata, color: 'FF0000', allowed_apps_win: [{ AppName: 'x' }] } };
  const edited = withEntries(mode, ['https://www.X.com/', 'x.com', 'tiktok.com']);
  assert.deepEqual(edited.metadata.blockUrlsArray, ['x.com', 'tiktok.com']);
  assert.equal(edited.metadata.color, 'FF0000');
  assert.deepEqual(edited.metadata.allowed_apps_win, [{ AppName: 'x' }]);
  assert.deepEqual(withEntries(STUDY, ['arxiv.org']).allowed_urls, ['arxiv.org']);
  assert.deepEqual(withEntries(STUDY, ['arxiv.org']).metadata.blockUrlsArray, ['wikipedia.org/wiki/Special']);
  assert.equal(withEntries(DEFAULT, ['a.com']), DEFAULT);
  assert.equal(withName(SOCIAL, ' Socials ').name, 'Socials');
});

test('switching a custom list between block list and allow list moves its sites', () => {
  const allow = withKind(SOCIAL, 'allow');
  assert.equal(listKind(allow), 'allow');
  assert.deepEqual(allow.allowed_urls, ['reddit.com', 'news']);
  assert.deepEqual(allow.metadata.blockUrlsArray, []);
  const back = withKind(allow, 'block');
  assert.deepEqual(back.metadata.blockUrlsArray, ['reddit.com', 'news']);
  assert.deepEqual(back.allowed_urls, []);
  assert.equal(withKind(SOCIAL, 'block'), SOCIAL);
  assert.equal(withKind(DEFAULT, 'block'), DEFAULT); // built-in lists keep their kind
});

test('saving sends every list with id, name, allowed_urls and its whole metadata', () => {
  assert.deepEqual(listBody(STUDY), { id: STUDY.id, name: 'Study', allowed_urls: STUDY.allowed_urls, metadata: STUDY.metadata, categories: [] });
  assert.deepEqual(Object.keys(listBody({ ...SOCIAL, user_id: 'u', created_at: 'x', tags: [] })), ['id', 'name', 'allowed_urls', 'metadata']);
  const body = allListsBody([...MODES, { id: 'accountability-buddy', name: 'Local only' }, null]);
  assert.equal(body.length, MODES.length);
});

// --- what is blocked -------------------------------------------------------------

test('without a list in force only the always-blocked sites are blocked', () => {
  assert.deepEqual(effectiveBlocking(['facebook.com', 'gossip'], null), { blocklist: ['facebook.com', 'gossip'], allowOnly: null });
  assert.deepEqual(effectiveBlocking(['facebook.com'], DEFAULT), { blocklist: ['facebook.com'], allowOnly: null });
  assert.deepEqual(effectiveBlocking(['facebook.com'], RELAX), { blocklist: ['facebook.com'], allowOnly: null });
});

test('a block list adds its sites; an allow list allows only its sites and still blocks the always-blocked ones', () => {
  assert.deepEqual(effectiveBlocking(['facebook.com', 'reddit.com'], SOCIAL), {
    blocklist: ['facebook.com', 'reddit.com', 'news'],
    allowOnly: null,
  });
  assert.deepEqual(effectiveBlocking(['facebook.com'], STUDY), {
    blocklist: ['facebook.com', 'wikipedia.org/wiki/special'],
    allowOnly: ['docs.google.com', 'wikipedia.org'],
  });
  // An allow list with nothing on it blocks everything.
  assert.deepEqual(effectiveBlocking([], { ...STUDY, allowed_urls: [] }).allowOnly, []);
});

test('an entry matches anywhere in the address, without scheme and www, with * as a wildcard', () => {
  assert.equal(matchesEntry('https://www.docs.google.com/document/d/1', 'docs.google.com'), true);
  assert.equal(matchesEntry('https://en.wikipedia.org/wiki/Bear', 'wikipedia.org'), true);
  assert.equal(matchesEntry('https://example.com/', 'wikipedia.org'), false);
  assert.equal(matchesEntry('https://Example.com/Path', 'EXAMPLE.com/path'), true);
  assert.equal(matchesEntry('https://mail.google.com/mail/u/0', 'google.com/*/settings'), false);
  assert.equal(matchesEntry('https://mail.google.com/mail/u/0', 'google.com/*/u'), true);
  assert.equal(matchesEntry('https://a.b.c/', '*.b.c'), true);
  assert.equal(matchesEntry('https://example.com', ''), false);
});

test('the extensions get the allow list only while one is in force, with an expiry', () => {
  assert.deepEqual(normaliseBlockSettings({ immediatelyBlock: true }), { immediatelyBlock: true });
  assert.deepEqual(normaliseBlockSettings({ allowOnly: null }), { immediatelyBlock: false });
  assert.deepEqual(normaliseBlockSettings({ allowOnly: ['a.com', '', 7, 'b.com'] }), { immediatelyBlock: false, allowOnly: ['a.com', 'b.com'] });
  const withList = JSON.parse(blockSettingsMessage({ allowOnly: [] }, 1000));
  assert.deepEqual(withList.data, { immediatelyBlock: false, allowOnly: [], allowOnlyUntil: 1000 + ALLOW_ONLY_LIFETIME_MS });
  assert.equal('allowOnlyUntil' in JSON.parse(blockSettingsMessage({}, 1000)).data, false);
});

// --- schedules -------------------------------------------------------------------

test('times convert between the form and the wire', () => {
  assert.equal(timeToMinutes('09:30:00'), 570);
  assert.equal(timeToMinutes('9:05'), 545);
  assert.equal(timeToMinutes('24:00'), null);
  assert.equal(timeToMinutes('soon'), null);
  assert.equal(minutesToWire(570), '09:30:00');
  assert.equal(wireToInput('17:00:00'), '17:00');
  assert.equal(wireToInput(''), '');
});

test('days of the week are 0 = Sunday on the wire, and "ALL" means every day', () => {
  assert.deepEqual(scheduleDays({ days_of_week: [5, 1, '3', 9, 1] }), [1, 3, 5]);
  assert.deepEqual(scheduleDays({ days_of_week: 'ALL' }), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(scheduleDays({ days_of_week: ['ALL'] }), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(scheduleDays({}), []);
});

test('a schedule is active on its days between its times, both ends included', () => {
  const work = schedule();
  assert.equal(isScheduleActive(work, at(23, '09:00')), true); // Monday
  assert.equal(isScheduleActive(work, at(23, '17:00')), true);
  assert.equal(isScheduleActive(work, at(23, '17:01')), false);
  assert.equal(isScheduleActive(work, at(23, '08:59')), false);
  assert.equal(isScheduleActive(work, at(22, '12:00')), false); // Sunday
  assert.equal(isScheduleActive(schedule({ end_time: '09:00:00' }), at(23, '09:00')), false); // same start and end
  assert.equal(isScheduleActive(schedule({ start_time: 'x' }), at(23, '12:00')), false);
});

test('an overnight schedule belongs to its start day', () => {
  const night = schedule({ start_time: '22:00:00', end_time: '06:00:00', days_of_week: [1] }); // Monday night
  assert.equal(isScheduleActive(night, at(23, '23:00')), true); // Monday 23:00
  assert.equal(isScheduleActive(night, at(24, '05:59')), true); // Tuesday morning
  assert.equal(isScheduleActive(night, at(24, '06:01')), false);
  assert.equal(isScheduleActive(night, at(23, '05:00')), false); // Monday morning belongs to Sunday night
  assert.equal(isScheduleActive(night, at(24, '23:00')), false); // Tuesday night
  const saturday = schedule({ start_time: '22:00:00', end_time: '02:00:00', days_of_week: [6] });
  assert.equal(isScheduleActive(saturday, at(22, '01:00')), true); // Sunday 01:00 after Saturday night
});

test('the strictest active schedule governs; the first wins a tie', () => {
  const gentle = schedule({ id: 'a' });
  const strict = schedule({ id: 'b', block_level: 'strict' });
  const alsoStrict = schedule({ id: 'c', block_level: 'strict' });
  const off = schedule({ id: 'd', block_level: 'super-strict', days_of_week: [0] });
  assert.equal(governingSchedule([gentle, strict, alsoStrict, off], at(23, '10:00')).id, 'b');
  assert.equal(governingSchedule([gentle], at(23, '10:00')).id, 'a');
  assert.equal(governingSchedule([gentle], at(23, '20:00')), null);
  assert.equal(governingSchedule(null, at(23, '10:00')), null);
});

test("a focus session's list is in force over a gentle schedule; a strict schedule keeps its own", () => {
  const date = at(23, '10:00');
  const none = activeBlocking({ modes: MODES, schedules: [], sessionModeId: null, date });
  assert.deepEqual(none, { mode: null, schedule: null, source: null });

  const session = activeBlocking({ modes: MODES, schedules: [], sessionModeId: STUDY.id, date });
  assert.equal(session.mode.id, STUDY.id);
  assert.equal(session.source, 'session');

  const scheduled = activeBlocking({ modes: MODES, schedules: [schedule()], sessionModeId: null, date });
  assert.equal(scheduled.mode.id, SOCIAL.id);
  assert.equal(scheduled.source, 'schedule');

  const both = activeBlocking({ modes: MODES, schedules: [schedule()], sessionModeId: STUDY.id, date });
  assert.equal(both.mode.id, STUDY.id);

  const strict = activeBlocking({ modes: MODES, schedules: [schedule({ block_level: 'strict' })], sessionModeId: STUDY.id, date });
  assert.equal(strict.mode.id, SOCIAL.id);
  assert.equal(strict.source, 'schedule');

  // A schedule whose list was deleted, and a session whose list is unknown, block nothing extra.
  const orphan = activeBlocking({ modes: MODES, schedules: [schedule({ focus_mode_id: 'gone' })], sessionModeId: 'gone', date });
  assert.equal(orphan.mode, null);
});

test('days and times read naturally', () => {
  assert.equal(daysSummary([1, 2, 3, 4, 5]), 'Weekdays');
  assert.equal(daysSummary([0, 6]), 'Weekends');
  assert.equal(daysSummary([0, 1, 2, 3, 4, 5, 6]), 'Every day');
  assert.equal(daysSummary([1, 2, 3]), 'Mon-Wed');
  assert.equal(daysSummary([5, 6, 0]), 'Fri-Sun');
  assert.equal(daysSummary([1, 3, 5]), 'Mon, Wed, Fri');
  assert.equal(daysSummary([0, 1]), 'Mon, Sun');
  assert.equal(daysSummary([]), 'No days');
  assert.equal(timeSummary(schedule()), '09:00 to 17:00');
  assert.equal(timeSummary(schedule({ start_time: '22:00:00', end_time: '06:00:00' })), '22:00 to 06:00 (next day)');
});

test('the form starts on weekdays 9 to 5 with the first list, or on the schedule being edited', () => {
  assert.deepEqual(scheduleDraft(null, DEFAULT.id), { name: '', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', modeId: DEFAULT.id });
  assert.deepEqual(scheduleDraft(schedule({ days_of_week: 'ALL' })), {
    name: 'Work hours',
    days: [0, 1, 2, 3, 4, 5, 6],
    start: '09:00',
    end: '17:00',
    modeId: SOCIAL.id,
  });
});

test('a schedule needs a name, a list, a day and two different times', () => {
  const draft = scheduleDraft(schedule());
  assert.equal(scheduleError(draft), null);
  assert.equal(scheduleError({ ...draft, name: ' ' }), 'Please enter a name for your custom schedule before saving.');
  assert.equal(scheduleError({ ...draft, modeId: '' }), 'Please select block list.');
  assert.equal(scheduleError({ ...draft, days: [] }), 'Please select at least one day for this schedule.');
  assert.equal(scheduleError({ ...draft, end: '09:00' }), "The start and end time can't be the same.");
  assert.equal(scheduleError({ ...draft, start: '' }), 'Please enter a start and an end time.');
});

test('a new schedule is sent with the Windows defaults; an edit keeps what this app does not change', () => {
  const draft = { name: ' Evenings ', days: [5, 1, 1], start: '18:00', end: '21:30', modeId: STUDY.id };
  assert.deepEqual(scheduleBody(draft, 'new-id'), {
    id: 'new-id',
    name: 'Evenings',
    start_time: '18:00:00',
    end_time: '21:30:00',
    days_of_week: [1, 5],
    focus_mode_id: STUDY.id,
    pause_friction: 'none',
    block_level: 'gentle',
    is_ai_blocking_enabled: false,
    emoji: null,
    metadata: { is_micro_breaks_enabled: false },
  });
  const existing = schedule({ block_level: 'super-strict', emoji: '📚', is_ai_blocking_enabled: true, metadata: { is_micro_breaks_enabled: true }, pause_friction: 'password' });
  const edited = scheduleBody(draft, existing.id, existing);
  assert.equal(edited.block_level, 'super-strict');
  assert.equal(edited.emoji, '📚');
  assert.equal(edited.is_ai_blocking_enabled, true);
  assert.deepEqual(edited.metadata, { is_micro_breaks_enabled: true });
  assert.equal(edited.pause_friction, 'password');
});

test('overlaps are found on shared days, across midnight and round the week', () => {
  const others = [schedule(), schedule({ id: 's2', name: 'Late', start_time: '22:00:00', end_time: '02:00:00', days_of_week: [6] })];
  const draft = (extra) => ({ name: 'x', days: [1], start: '16:00', end: '18:00', modeId: 'm', ...extra });
  assert.deepEqual(overlappingSchedules(draft(), others), ['Work hours']);
  assert.deepEqual(overlappingSchedules(draft(), others, 's1'), []); // itself
  assert.deepEqual(overlappingSchedules(draft({ start: '17:00', end: '18:00' }), others), []); // touching is fine
  assert.deepEqual(overlappingSchedules(draft({ days: [6] }), others), []); // Saturday afternoon
  assert.deepEqual(overlappingSchedules(draft({ days: [0], start: '01:00', end: '03:00' }), others), ['Late']); // Sunday 01:00
  assert.deepEqual(overlappingSchedules(draft({ days: [0], start: '03:00', end: '04:00' }), others), []);
});

// --- API ---------------------------------------------------------------------------

function recorder(answers = {}) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    const answer = answers[`${method} ${path.split('?')[0]}`];
    if (answer instanceof Error) throw answer;
    return answer ?? null;
  };
  return { calls, request };
}

test('lists: read, create with a new id, save all of them, delete by query id', async () => {
  const { calls, request } = recorder({ 'GET /user/focus-modes': MODES });
  const api = createBlockingApi({ request, getDeviceId: async () => 'dev-1', newId: () => ID(9) });
  assert.equal((await api.getLists()).length, MODES.length);
  const created = await api.createList('Writing', 'allow');
  assert.equal(created.id, ID(9));
  await api.saveLists([SOCIAL, STUDY]);
  await api.deleteList(SOCIAL.id);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'GET /user/focus-modes',
    'POST /focus-mode',
    'PUT /focus-mode',
    `DELETE /focus-mode?id=${SOCIAL.id}`,
  ]);
  assert.equal(calls[1].body.metadata.isAllowedListApproach, true);
  assert.deepEqual(calls[2].body.map((m) => m.id), [SOCIAL.id, STUDY.id]);
});

test('a list that is already gone counts as deleted; other failures are passed on', async () => {
  const gone = Object.assign(new Error('gone'), { status: 404 });
  const broken = Object.assign(new Error('down'), { status: 500 });
  await createBlockingApi({ request: recorder({ 'DELETE /focus-mode': gone }).request, getDeviceId: async () => 'd' }).deleteList('x');
  await assert.rejects(
    createBlockingApi({ request: recorder({ 'DELETE /focus-mode': broken }).request, getDeviceId: async () => 'd' }).deleteList('x'),
    /down/,
  );
});

test('schedules: create, update and delete carry the device id; they still work without one', async () => {
  const { calls, request } = recorder({ 'GET /blocking-schedules': [schedule()] });
  const api = createBlockingApi({ request, getDeviceId: async () => 'dev 1', newId: () => 'new-id' });
  assert.equal((await api.getSchedules()).length, 1);
  const draft = { name: 'Evenings', days: [1], start: '18:00', end: '21:00', modeId: STUDY.id };
  const created = await api.saveSchedule(draft);
  assert.equal(created.id, 'new-id');
  const updated = await api.saveSchedule({ ...draft, name: 'Nights' }, { ...schedule(), user_id: 'u' });
  assert.equal(updated.name, 'Nights');
  assert.equal(updated.user_id, 'u');
  await api.deleteSchedule('s1');
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'GET /blocking-schedules',
    'POST /blocking-schedules?device_id=dev%201',
    'PUT /blocking-schedules/s1?device_id=dev%201',
    'DELETE /blocking-schedules/s1?device_id=dev%201',
  ]);

  const offline = recorder();
  const noDevice = createBlockingApi({
    request: offline.request,
    getDeviceId: async () => {
      throw new Error('not registered');
    },
    newId: () => 'n',
  });
  await noDevice.saveSchedule(draft);
  assert.equal(offline.calls[0].path, '/blocking-schedules');
});

test('the start screen says what the chosen list blocks', () => {
  assert.equal(listSummary(DEFAULT), 'Blocks your Super Distracting Sites.');
  assert.equal(listSummary(RELAX), 'Blocks nothing extra.');
  assert.equal(listSummary(STUDY), 'Blocks everything except the 2 sites on this list.');
  assert.equal(listSummary(withEntries(SOCIAL, ['a.com'])), 'Blocks the 1 site on this list as well as your Super Distracting Sites.');
});

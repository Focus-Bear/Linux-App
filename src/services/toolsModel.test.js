import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRAIN_DUMP_PLACEHOLDER_ID,
  arrangeNotes,
  isLocalNoteId,
  noteBody,
  noteError,
  pinBody,
  plainText,
  preview,
  textToHtml,
} from './notesModel.js';
import {
  achievementsView,
  localAchievements,
  completionCaption,
  focusLogRows,
  focusLogTotal,
  formatPosition,
  formatSeconds,
  leaderboardPath,
  leaderboardTable,
  neighbourTrack,
  parseHiddenTools,
  streakTiles,
  toggleHiddenTool,
  trackList,
  usernameError,
} from './statsModel.js';
import { createToolsApi } from './toolsApiCore.js';
import { toolIds, visibleSections } from '../ui/navigation.js';

// --- notes ----------------------------------------------------------------------

test('note bodies are HTML; the list shows them as plain text', () => {
  assert.equal(plainText('<p>Hello <b>there</b></p><p>Tom &amp; Jerry&nbsp;&lt;3</p>'), 'Hello there Tom & Jerry <3');
  assert.equal(plainText('<ul><li>one</li><li>two</li></ul>'), 'one two');
  assert.equal(plainText(null), '');
  assert.equal(preview({ body: `<p>${'word '.repeat(40)}</p>` }, 20).length, 20);
  assert.equal(textToHtml('a <b>\n\nc'), '<p>a &lt;b&gt;</p><p><br></p><p>c</p>');
});

test('the brain dump comes first, then pinned notes, then the newest', () => {
  const notes = [
    { id: 'old', created_at: '2026-11-01T00:00:00Z' },
    { id: 'new', created_at: '2026-11-20T00:00:00Z' },
    { id: 'pinned', created_at: '2026-10-01T00:00:00Z', pinned_at: '2026-11-02T00:00:00Z' },
    { id: 'dump', created_at: '2026-09-01T00:00:00Z', is_brain_dump: true },
    { id: 'new', created_at: '2026-11-20T00:00:00Z' },
  ];
  assert.deepEqual(arrangeNotes(notes).map((note) => note.id), ['dump', 'pinned', 'new', 'old']);
});

test('an account without a brain dump gets a placeholder row, except in search results', () => {
  const notes = [{ id: 'a', created_at: '2026-11-01T00:00:00Z' }];
  assert.deepEqual(arrangeNotes(notes).map((note) => note.id), [BRAIN_DUMP_PLACEHOLDER_ID, 'a']);
  assert.deepEqual(arrangeNotes(notes, { withBrainDump: false }).map((note) => note.id), ['a']);
  assert.equal(arrangeNotes(null)[0].is_brain_dump, true);
});

test('a new note is created without an id; a saved one is updated by id', () => {
  assert.deepEqual(noteBody({ id: 'draft-1' }, { title: ' Plan ', body: '<p>x</p>' }), { title: 'Plan', body: '<p>x</p>' });
  assert.deepEqual(noteBody({ id: 'n1' }, { title: 'Plan', body: '' }), { title: 'Plan', body: '', id: 'n1' });
  assert.equal(isLocalNoteId('draft-5'), true);
  assert.equal(isLocalNoteId(undefined), true);
  assert.equal(isLocalNoteId('32746af1-de8f-436a-9e19-fa489f3f8b82'), false);
});

test('saving the brain dump placeholder creates the brain dump', () => {
  const placeholder = arrangeNotes([])[0];
  assert.deepEqual(noteBody(placeholder, { title: 'Brain Dump', body: '<p>x</p>' }), { title: 'Brain Dump', body: '<p>x</p>', is_brain_dump: true });
  assert.deepEqual(noteBody({ id: 'd1', is_brain_dump: true }, { title: 'Brain Dump', body: '' }), { title: 'Brain Dump', body: '', id: 'd1', is_brain_dump: true });
});

test('note limits', () => {
  assert.equal(noteError('', 'x'), 'Give the note a title.');
  assert.equal(noteError('ok', 'x'), null);
  assert.match(noteError('t'.repeat(501), ''), /500/);
  assert.match(noteError('t', 'b'.repeat(50001)), /too long/);
  assert.deepEqual(pinBody({ id: 'n1' }, true), { id: 'n1', pinned: true });
});

// --- stats ----------------------------------------------------------------------

test('streak tiles read the numbers the server sends as strings', () => {
  const tiles = streakTiles({ morning_routines_streak: '135', morning_number_days_completed: '90', morning_num_days_of_stats: '90', focus_modes_streak: 2 });
  assert.deepEqual(tiles.map((tile) => tile.id), ['morning', 'breaks', 'evening', 'focus']);
  assert.equal(tiles[0].streak, 135);
  assert.equal(tiles[0].percent, 100);
  assert.equal(tiles[0].caption, '90 days completed out of last 90');
  assert.equal(tiles[3].streak, 2);
  assert.equal(tiles[1].caption, 'No days tracked yet');
  assert.equal(completionCaption(1, 7), '1 day completed out of last 7');
});

test('the leaderboard asks for one of the four streaks, 20 rows', () => {
  assert.equal(leaderboardPath('focus_modes_streak'), '/user-stats/leaderboard?limit=20&streak_type=focus_modes_streak');
  assert.equal(leaderboardPath('nonsense'), '/user-stats/leaderboard?limit=20&streak_type=morning_routines_streak');
});

test('leaderboard rows are ranked; "Your position" is added when you are outside the top', () => {
  const response = {
    user_rank: { id: 'me', username: 'qa', rank: '57', morning_routines_streak: '1' },
    users_rankings: [
      { id: 'b', username: '', rank: '2', morning_routines_streak: '8', is_current_user: false },
      { id: 'a', username: 'top', rank: '1', morning_routines_streak: '135', is_current_user: false },
    ],
  };
  const table = leaderboardTable(response);
  assert.deepEqual(table.rows.map((row) => row.name), ['top', 'Anonymous bear']);
  assert.equal(table.rows[0].streaks.morning.streak, 135);
  assert.equal(table.you.rank, 57);
  assert.equal(table.you.isYou, true);

  const listed = leaderboardTable({ user_rank: { id: 'a', rank: 1 }, users_rankings: [{ id: 'a', username: 'me', rank: 1, is_current_user: true }] });
  assert.equal(listed.you, null);
  assert.equal(listed.rows[0].isYou, true);
  assert.deepEqual(leaderboardTable(null), { rows: [], you: null, listed: false });
});

test('leaderboard usernames', () => {
  assert.equal(usernameError('qa_bear-1'), null);
  assert.match(usernameError(''), /first/);
  assert.match(usernameError('ab'), /3/);
  assert.match(usernameError('has space'), /only/);
  assert.match(usernameError('x'.repeat(31)), /30/);
});

test('the focus log decodes the text, falls back to the block list name and sorts newest first', () => {
  const rows = focusLogRows([
    { id: '1', start_time: '2026-11-20T10:00:00Z', focus_duration_seconds: '1500', intention: 'Write%20report', achievements: 'Done%21', metadata: { focus_stars: 4 } },
    { id: '2', start_time: '2026-11-21T10:00:00Z', focus_duration_seconds: 8, intention: '', focus_mode: { name: 'Study' } },
    { id: '3', start_time: '2026-11-19T10:00:00Z', focus_duration_seconds: 4000, intention: '100% done' },
    null,
  ]);
  assert.deepEqual(rows.map((row) => row.id), ['2', '1', '3']);
  assert.equal(rows[0].title, 'Study');
  assert.equal(rows[1].title, 'Write report');
  assert.equal(rows[1].achievements, 'Done!');
  assert.equal(rows[1].stars, 4);
  assert.equal(rows[2].title, '100% done'); // not valid URL-encoding: shown as it is
  assert.equal(rows[2].duration, '1h 6m');
  assert.equal(focusLogTotal(rows), '1h 31m');
  assert.equal(formatSeconds(8), '8s');
  assert.equal(formatSeconds(3600), '1h');
});

// --- achievements ---------------------------------------------------------------

test('achievements: the two checklists are ticked from the server, with the level and streaks', () => {
  const view = achievementsView({
    level: 1,
    achievements: { create_account: true, first_focus_session: true, block_list: false, allow_list: true, habits: true, breaks: true },
    morning_routine_completion_streak_days: 3,
    morning_routines_completion_percentage_for_current_level: 140,
  });
  assert.equal(view.level, 1);
  assert.equal(view.checklists[0].count, 3);
  assert.equal(view.checklists[0].total, 6);
  assert.equal(view.checklists[0].complete, false);
  assert.equal(view.checklists[1].complete, true);
  assert.equal(view.stepsDone, 5);
  assert.equal(view.stepsTotal, 8);
  assert.equal(view.streaks[0].days, 3);
  assert.equal(view.streaks[0].percent, 100);
  const blockList = view.checklists[0].steps.find((step) => step.key === 'block_list');
  assert.deepEqual(blockList.page, ['blocking', 'super-distracting-sites']);
});

test('steps this app can see are done are ticked even when the server says no', () => {
  const local = localAchievements({
    blockedSites: ['gossip', 'facebook.com'],
    schedules: [],
    modes: [{ metadata: { isAllowedListApproach: true }, allowed_urls: ['moodle.org'] }],
  });
  assert.deepEqual(local, { block_list: true, blocking_schedule: false, allow_list: true });
  assert.equal(localAchievements({ blockedSites: ['gossip'] }).block_list, false);
  const view = achievementsView({ achievements: { block_list: false, blocking_schedule: true } }, local);
  const ticked = view.checklists[0].steps.filter((step) => step.done).map((step) => step.key);
  assert.deepEqual(ticked, ['block_list', 'blocking_schedule', 'allow_list']);
});

test('achievements without data: level 1, nothing ticked', () => {
  const view = achievementsView(null);
  assert.equal(view.level, 1);
  assert.equal(view.stepsDone, 0);
  assert.equal(achievementsView({ level: 42 }).level, 9);
});

// --- focus music ----------------------------------------------------------------

test('tracks are listed by name, without the ones that have no link', () => {
  const tracks = trackList([
    { id: 'b', name: 'Quantum Focus 10', download_url: 'https://x/b.mp3', duration: '5400' },
    { id: 'a', name: 'Quantum Focus 6', download_url: 'https://x/a.mp3', thumbnail_download_url: 'https://x/a.png', duration: '90' },
    { id: 'c', name: 'Broken' },
  ]);
  assert.deepEqual(tracks.map((track) => track.id), ['a', 'b']);
  assert.equal(tracks[1].length, '1h 30m');
  assert.equal(tracks[0].image, 'https://x/a.png');
  assert.equal(neighbourTrack(tracks, 'b', 1).id, 'a');
  assert.equal(neighbourTrack(tracks, 'a', -1).id, 'b');
  assert.equal(neighbourTrack(tracks, 'gone', 1).id, 'a');
  assert.equal(neighbourTrack([], 'a'), null);
  assert.equal(formatPosition(65), '1:05');
  assert.equal(formatPosition(3909), '1:05:09');
});

// --- hiding tools ---------------------------------------------------------------

test('hidden tools: unknown ids are dropped, hidden tools leave the menu, the open one stays', () => {
  const ids = toolIds();
  assert.ok(ids.includes('notes') && ids.includes('stats') && ids.includes('focus-music'));
  assert.deepEqual(parseHiddenTools('notes, nonsense,stats', ids), ['notes', 'stats']);
  assert.deepEqual(parseHiddenTools(null, ids), []);
  assert.deepEqual(toggleHiddenTool(['notes'], 'stats'), ['notes', 'stats']);
  assert.deepEqual(toggleHiddenTool(['notes'], 'notes'), []);
  const tools = (sections) => sections.find((section) => section.id === 'tools').items.map((item) => item.id);
  assert.ok(!tools(visibleSections(['notes'])).includes('notes'));
  assert.ok(tools(visibleSections(['notes'], 'notes')).includes('notes'));
  const main = visibleSections(['notes']).find((section) => section.id === 'main');
  assert.equal(main.items[0].id, 'achievements');
});

// --- API ------------------------------------------------------------------------

test('the tools API uses the Windows paths', async () => {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (path.startsWith('/note?page')) return { data: [{ id: 'n1' }], meta: { hasNextPage: true } };
    if (path.startsWith('/note/search')) return [{ id: 'n2' }];
    if (method === 'DELETE') throw Object.assign(new Error('gone'), { status: 404 });
    return body ?? null;
  };
  const api = createToolsApi({ request });
  assert.deepEqual(await api.getNotes(2), { notes: [{ id: 'n1' }], hasNextPage: true });
  assert.deepEqual(await api.searchNotes(' deep work '), [{ id: 'n2' }]);
  await api.getPinnedNotes();
  await api.saveNote({ id: 'draft-1' }, { title: 'T', body: '' });
  await api.setNotePinned({ id: 'n1' }, true);
  await api.deleteNote('n1'); // 404 = already gone
  await api.getLeaderboard('micro_breaks_streak');
  await api.setUsername(' qa_bear ');
  await api.getFocusLog();
  await api.getTracks();
  await api.getLevelStats();
  assert.deepEqual(calls, [
    'GET /note?page=2&take=10&order=DESC',
    'GET /note/search?query=deep%20work&take=20',
    'GET /note?page=1&take=50&order=DESC&pinned=true',
    'PUT /note',
    'PUT /note',
    'DELETE /note?note_id=n1',
    'GET /user-stats/leaderboard?limit=20&streak_type=micro_breaks_streak',
    'PUT /user/username',
    'GET /user/weekly-focus-block-summary?limit=30&offset=0',
    'GET /tracks',
    'GET /user/stats/onboarding',
  ]);
});

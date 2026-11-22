import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolsApi } from './toolsApiCore.js';
import { BRAIN_DUMP_FULL, MAX_BODY, arrangeNotes, latestBrainDump, noteBody } from './notesModel.js';

/** The account's notes behind GET /note (newest first, paged), GET /note/{id} and PUT /note. */
function fakeNotes(notes) {
  const account = {
    notes,
    calls: [],
    async request(method, path, body) {
      account.calls.push(`${method} ${path}`);
      const url = new URL(path, 'https://api.test');
      if (method === 'GET' && url.pathname === '/note') {
        const take = Number(url.searchParams.get('take'));
        const page = Number(url.searchParams.get('page'));
        const rows = [...account.notes].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
        return { data: rows.slice((page - 1) * take, page * take), meta: { hasNextPage: page * take < rows.length } };
      }
      if (method === 'GET' && url.pathname.startsWith('/note/')) {
        const found = account.notes.find((note) => note.id === url.pathname.slice(6));
        if (!found) throw Object.assign(new Error('not found'), { status: 404 });
        return found;
      }
      if (method === 'PUT') {
        let saved = account.notes.find((note) => note.id === body.id);
        if (!saved) {
          saved = { id: `new-${account.notes.length}`, created_at: '2026-11-22T10:00:00Z' };
          account.notes.push(saved);
        }
        Object.assign(saved, body);
        return saved;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    dumps: () => account.notes.filter((note) => note.is_brain_dump),
  };
  return account;
}

const minute = (i) => new Date(Date.parse('2026-06-01T00:00:00Z') + i * 60000).toISOString();
const habitNotes = (count) => Array.from({ length: count }, (_, i) => ({ id: `n${i}`, title: 'Habit note', body: '', created_at: minute(i) }));
const oldDump = () => ({ id: 'dump', title: 'Brain Dump', body: '<p>old</p>', is_brain_dump: true, created_at: '2025-01-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' });

test('the brain dump box finds a Brain Dump older than the newest 50 notes and adds to it', async () => {
  const account = fakeNotes([oldDump(), ...habitNotes(130)]);
  const api = createToolsApi({ request: account.request });
  await api.appendBrainDump('call the bank');
  assert.equal(account.dumps().length, 1, 'no second Brain Dump');
  assert.equal(account.notes[0].body, '<p>old</p><p>call the bank</p>');
  assert.deepEqual(account.calls, [
    'GET /note?page=1&take=50&order=DESC',
    'GET /note?page=2&take=50&order=DESC',
    'GET /note?page=3&take=50&order=DESC',
    'PUT /note',
  ]);
  // The next thought goes straight to the note found the first time.
  account.calls.length = 0;
  await api.appendBrainDump('and the dentist');
  assert.deepEqual(account.calls, ['GET /note/dump', 'PUT /note']);
  assert.equal(account.notes[0].body, '<p>old</p><p>call the bank</p><p>and the dentist</p>');
});

test('a Brain Dump is created only when the whole list was read and has none', async () => {
  const account = fakeNotes(habitNotes(60));
  const api = createToolsApi({ request: account.request });
  assert.deepEqual(await api.findBrainDump(), { note: null, complete: true });
  await api.appendBrainDump('first thought');
  assert.equal(account.dumps().length, 1);
  assert.equal(account.dumps()[0].title, 'Brain Dump');
  await api.appendBrainDump('second thought');
  assert.equal(account.dumps().length, 1);
  assert.equal(account.dumps()[0].body, '<p>first thought</p><p>second thought</p>');
});

test('when a page of the list cannot be read, nothing is created', async () => {
  const account = fakeNotes(habitNotes(60));
  const api = createToolsApi({
    request: async (method, path, body) => {
      if (path.includes('page=2')) throw Object.assign(new Error('offline'), { status: 0 });
      return account.request(method, path, body);
    },
  });
  await assert.rejects(api.appendBrainDump('thought'), /offline/);
  assert.equal(account.dumps().length, 0);
});

test('a server that sends no paging details: a full page means "look further"', async () => {
  const account = fakeNotes([oldDump(), ...habitNotes(50)]);
  const api = createToolsApi({ request: async (...args) => (await account.request(...args)).data ?? account.request(...args) });
  const { note } = await api.findBrainDump();
  assert.equal(note.id, 'dump');
});

test('a remembered Brain Dump that was deleted elsewhere is looked for again', async () => {
  const account = fakeNotes([oldDump()]);
  const api = createToolsApi({ request: account.request });
  await api.appendBrainDump('one');
  account.notes = [{ ...oldDump(), id: 'dump-2', body: '<p>other</p>' }];
  await api.appendBrainDump('two');
  assert.equal(account.dumps().length, 1);
  assert.equal(account.notes[0].body, '<p>other</p><p>two</p>');
});

test('two thoughts sent at once both end up in the one Brain Dump', async () => {
  const account = fakeNotes([]);
  const api = createToolsApi({ request: account.request });
  await Promise.all([api.appendBrainDump('one'), api.appendBrainDump('two')]);
  assert.equal(account.dumps().length, 1);
  assert.equal(account.dumps()[0].body, '<p>one</p><p>two</p>');
});

test('a full Brain Dump refuses more text and says so, instead of dropping it', async () => {
  const full = { ...oldDump(), body: 'x'.repeat(MAX_BODY - 10) };
  const account = fakeNotes([full]);
  const api = createToolsApi({ request: account.request });
  await assert.rejects(api.appendBrainDump('one thought too many'), (error) => error.code === 'NOTE_FULL' && error.message === BRAIN_DUMP_FULL);
  assert.equal(account.calls.filter((call) => call.startsWith('PUT')).length, 0);
  assert.equal(account.notes[0].body.length, MAX_BODY - 10);
});

test('the request body is never cut short', () => {
  const body = 'x'.repeat(MAX_BODY + 5);
  assert.equal(noteBody({ id: 'n1' }, { title: 'T', body }).body.length, MAX_BODY + 5);
});

test('among several Brain Dumps the most recently updated is the one in use', () => {
  const notes = [
    { id: 'a', created_at: '2026-11-20T00:00:00Z' },
    { id: 'd1', is_brain_dump: true, created_at: '2026-11-10T00:00:00Z', updated_at: '2026-11-11T00:00:00Z' },
    { id: 'd2', is_brain_dump: true, created_at: '2025-01-01T00:00:00Z', updated_at: '2026-11-21T00:00:00Z' },
  ];
  assert.equal(latestBrainDump(notes).id, 'd2');
  assert.equal(latestBrainDump([notes[0]]), null);
  assert.deepEqual(arrangeNotes(notes).map((note) => note.id), ['d2', 'd1', 'a']);
});

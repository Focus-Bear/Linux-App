import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolsApi } from './toolsApiCore.js';
import { BRAIN_DUMP_PLACEHOLDER_ID, MAX_BODY } from './notesModel.js';
import { DELETE_FAILED, PIN_EMPTY, SAVE_FAILED, UNTITLED, createNotesStore } from './notesStoreCore.js';

const day = (n) => `2026-10-${String(n).padStart(2, '0')}T09:00:00.000Z`;
const note = (id, n, extra = {}) => ({ id, title: `Note ${id}`, body: `<p>${id} text</p>`, created_at: day(n), updated_at: day(n), is_brain_dump: false, ...extra });
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A stand-in for the account's notes, behind the real request paths. `hold(method)`
 * makes those requests wait until the test lets each one through (`waiting[i].release()`),
 * so answers can be late or in any order.
 */
function fakeAccount(notes = []) {
  let clock = Date.parse('2026-11-22T10:00:00.000Z');
  let made = 0;
  const account = {
    notes: notes.map((item) => ({ ...item })),
    calls: [],
    held: new Set(),
    waiting: [],
    online: true,
    hold: (method) => account.held.add(method),
    letGo: (method) => account.held.delete(method),
    async request(method, path, body) {
      const sent = body === undefined ? undefined : JSON.parse(JSON.stringify(body));
      account.calls.push({ method, path, body: sent });
      if (account.held.has(method)) {
        await new Promise((resolve) => account.waiting.push({ method, path, body: sent, release: resolve }));
      }
      if (!account.online) throw Object.assign(new Error('offline'), { status: 0 });
      const url = new URL(path, 'https://api.test');
      const copy = (value) => JSON.parse(JSON.stringify(value));
      if (method === 'GET' && url.pathname === '/note') {
        const take = Number(url.searchParams.get('take'));
        const page = Number(url.searchParams.get('page'));
        let rows = [...account.notes].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
        if (url.searchParams.get('pinned') === 'true') rows = rows.filter((item) => item.pinned_at);
        const data = rows.slice((page - 1) * take, page * take);
        return copy({ data, meta: { hasNextPage: page * take < rows.length } });
      }
      if (method === 'GET' && url.pathname === '/note/search') {
        const query = url.searchParams.get('query').toLowerCase();
        return copy(account.notes.filter((item) => `${item.title} ${item.body}`.toLowerCase().includes(query)));
      }
      if (method === 'GET' && url.pathname.startsWith('/note/')) {
        const found = account.notes.find((item) => item.id === url.pathname.slice(6));
        if (!found) throw Object.assign(new Error('not found'), { status: 404 });
        return copy(found);
      }
      if (method === 'PUT' && url.pathname === '/note') {
        clock += 1000;
        const { pinned, ...fields } = sent;
        if (pinned !== undefined) fields.pinned_at = pinned ? new Date(clock).toISOString() : null;
        let saved = account.notes.find((item) => item.id === sent.id);
        if (sent.id && !saved) throw Object.assign(new Error('not found'), { status: 404 });
        if (!saved) {
          if (!sent.title) throw Object.assign(new Error('title is required'), { status: 400 });
          made += 1;
          saved = { id: `srv-${made}`, is_brain_dump: false, created_at: new Date(clock).toISOString() };
          account.notes.push(saved);
        }
        Object.assign(saved, fields, { updated_at: new Date(clock).toISOString() });
        return copy(saved);
      }
      if (method === 'DELETE' && url.pathname === '/note') {
        const id = url.searchParams.get('note_id');
        if (!account.notes.some((item) => item.id === id)) throw Object.assign(new Error('not found'), { status: 404 });
        account.notes = account.notes.filter((item) => item.id !== id);
        return undefined;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    puts: () => account.calls.filter((call) => call.method === 'PUT'),
    deletes: () => account.calls.filter((call) => call.method === 'DELETE'),
    byId: (id) => account.notes.find((item) => item.id === id),
    dumps: () => account.notes.filter((item) => item.is_brain_dump),
  };
  return account;
}

/** Timers the test runs by hand: `timers.run(ms)` fires the ones set for that delay. */
function fakeTimers() {
  const timers = {
    list: [],
    set(fn, ms) {
      const timer = { fn, ms };
      timers.list.push(timer);
      return timer;
    },
    clear(timer) {
      timers.list = timers.list.filter((item) => item !== timer);
    },
    async run(ms) {
      const due = timers.list.filter((timer) => timer.ms === ms);
      timers.list = timers.list.filter((timer) => timer.ms !== ms);
      due.forEach((timer) => timer.fn());
      await tick();
    },
  };
  return timers;
}

// The page's HTML check, reduced to one rule: <font> can't be kept.
const inspect = (html) => ({ html: String(html).replace(/<\/?font[^>]*>/g, ''), lost: /<font/.test(html) ? ['<font>'] : [] });

async function setup(notes = [note('a', 1), note('b', 2)]) {
  const account = fakeAccount(notes);
  const timers = fakeTimers();
  const store = createNotesStore({
    api: createToolsApi({ request: (...args) => account.request(...args) }),
    inspect,
    saveDelayMs: 1200,
    maxWaitMs: 10000,
    searchDelayMs: 300,
    setTimer: timers.set,
    clearTimer: timers.clear,
    log: { error() {} },
  });
  await store.load();
  return { account, timers, store };
}

const ids = (store) => store.get().shown.map((item) => item.id);

// --- opening --------------------------------------------------------------------

test('clicking the open note again does not put its older copy back into the editor', async () => {
  const { account, store } = await setup();
  store.open('a');
  const opened = store.get().opened;
  store.edit({ body: '<p>a text and a new paragraph</p>' });
  store.flush(); // the editor lost focus: the save has started
  store.open('a'); // its own row, clicked before the save came back
  assert.equal(store.get().opened, opened, 'the editor was not filled again');
  await store.flush();
  store.edit({ body: '<p>a text and a new paragraph!</p>' });
  await store.flush();
  assert.equal(account.byId('a').body, '<p>a text and a new paragraph!</p>');
});

test('a note saved from a search result is reopened with its new text, and the result row shows it', async () => {
  const { account, timers, store } = await setup([note('x', 1, { title: 'plan x' }), note('y', 2, { title: 'plan y' })]);
  store.setQuery('plan');
  await timers.run(300);
  assert.deepEqual(ids(store), ['y', 'x']);
  store.open('x');
  store.edit({ body: '<p>x text EDIT1</p>' });
  await store.flush();
  assert.equal(store.get().saveState, 'saved');
  store.open('y');
  store.open('x');
  assert.equal(store.get().body, '<p>x text EDIT1</p>');
  assert.equal(store.get().shown.find((item) => item.id === 'x').body, '<p>x text EDIT1</p>');
  store.edit({ body: '<p>x text EDIT1 and more</p>' });
  await store.flush();
  assert.equal(account.byId('x').body, '<p>x text EDIT1 and more</p>');
});

test('a search answer from before a save does not replace the saved copy', async () => {
  const { account, timers, store } = await setup([note('x', 1, { title: 'plan x' }), note('y', 2, { title: 'plan y' })]);
  store.open('x');
  store.setQuery('plan');
  account.hold('GET');
  await timers.run(300); // the search is on its way, held
  const old = [note('x', 1, { title: 'plan x' }), note('y', 2, { title: 'plan y' })];
  account.letGo('GET');
  store.edit({ body: '<p>newer</p>' });
  await store.flush();
  // The held search now answers with what the account had before the save.
  account.notes = old;
  account.waiting.shift().release();
  await tick();
  assert.equal(store.get().shown.find((item) => item.id === 'x').body, '<p>newer</p>');
  store.open('y');
  store.open('x');
  assert.equal(store.get().body, '<p>newer</p>');
});

// --- saving in order --------------------------------------------------------------

test('a new note that is saved again before its first save answered is created once', async () => {
  const { account, store } = await setup();
  store.newNote();
  store.edit({ body: '<p>first words</p>' });
  account.hold('PUT');
  store.flush();
  await tick();
  store.edit({ body: '<p>first words and more</p>' });
  store.flush(); // 1.2 s later, the create still has not answered
  await tick();
  assert.equal(account.waiting.length, 1, 'the second save waits for the first');
  account.letGo('PUT');
  account.waiting.shift().release();
  await store.flush();
  const puts = account.puts();
  assert.equal(puts.length, 2);
  assert.equal(puts[0].body.id, undefined);
  assert.equal(puts[1].body.id, 'srv-1', 'the second save updates the note the first one created');
  assert.equal(account.notes.length, 3);
  assert.equal(account.byId('srv-1').body, '<p>first words and more</p>');
  assert.equal(store.get().selectedId, 'srv-1');
  assert.deepEqual(ids(store).filter((id) => id.startsWith('draft-')), []);
});

test('two saves of one note are sent one after the other, with the newest text last', async () => {
  const { account, store } = await setup();
  store.open('a');
  account.hold('PUT');
  store.edit({ body: '<p>one</p>' });
  store.flush();
  await tick();
  store.edit({ body: '<p>one two</p>' });
  store.flush();
  store.edit({ body: '<p>one two three</p>' });
  store.flush();
  await tick();
  assert.equal(account.waiting.length, 1, 'only one request is in flight');
  assert.equal(store.get().saveState, 'dirty');
  account.waiting.shift().release();
  await tick();
  assert.equal(account.waiting.length, 1, 'the next one went out when the first came back');
  assert.equal(account.waiting[0].body.body, '<p>one two three</p>', 'and carries the newest text, once');
  account.waiting.shift().release();
  await store.flush();
  assert.equal(account.puts().length, 2);
  assert.equal(account.byId('a').body, '<p>one two three</p>');
  assert.equal(store.get().saveState, 'saved');
});

test('typing in an empty Brain Dump twice quickly creates one Brain Dump', async () => {
  const { account, store } = await setup();
  assert.equal(ids(store)[0], BRAIN_DUMP_PLACEHOLDER_ID);
  store.open(BRAIN_DUMP_PLACEHOLDER_ID);
  account.hold('PUT');
  store.edit({ body: '<p>thought</p>' });
  store.flush();
  await tick();
  store.edit({ body: '<p>thought two</p>' });
  store.flush();
  await tick();
  account.letGo('PUT');
  account.waiting.shift().release();
  await store.flush();
  assert.equal(account.dumps().length, 1);
  assert.equal(account.dumps()[0].body, '<p>thought two</p>');
  assert.equal(account.dumps()[0].title, 'Brain Dump');
  assert.ok(!ids(store).includes(BRAIN_DUMP_PLACEHOLDER_ID));
});

test('leaving a note while it is being saved still saves it, and the list gets the saved copy', async () => {
  const { account, store } = await setup();
  store.open('a');
  store.edit({ body: '<p>left behind</p>' });
  account.hold('PUT');
  store.open('b'); // sends a's text on the way out
  await tick();
  assert.equal(store.get().selectedId, 'b');
  account.letGo('PUT');
  account.waiting.shift().release();
  await tick();
  assert.equal(account.byId('a').body, '<p>left behind</p>');
  assert.equal(store.get().selectedId, 'b', 'the save of a does not pull the editor back to a');
  assert.equal(store.get().shown.find((item) => item.id === 'a').body, '<p>left behind</p>');
});

test('a save that fails keeps the text: it is shown again and sent with the next save', async () => {
  const { account, store } = await setup();
  store.open('a');
  store.edit({ body: '<p>typed offline</p>' });
  account.online = false;
  await store.flush();
  assert.equal(store.get().saveState, 'error');
  assert.equal(store.get().message, SAVE_FAILED);
  store.open('b');
  await tick();
  account.online = true;
  store.open('a');
  assert.equal(store.get().body, '<p>typed offline</p>');
  await store.flush();
  assert.equal(account.byId('a').body, '<p>typed offline</p>');
});

test('the text is saved a moment after the last key, and at the latest every ten seconds while typing', async () => {
  const { account, timers, store } = await setup();
  store.open('a');
  store.edit({ body: '<p>1</p>' });
  store.edit({ body: '<p>12</p>' });
  assert.equal(timers.list.filter((timer) => timer.ms === 1200).length, 1);
  assert.equal(account.puts().length, 0);
  await timers.run(10000); // never paused for 1.2 s
  assert.equal(account.byId('a').body, '<p>12</p>');
  store.edit({ body: '<p>123</p>' });
  await timers.run(1200);
  assert.equal(account.byId('a').body, '<p>123</p>');
});

test('leaving the page sends the latest text', async () => {
  const { account, timers, store } = await setup();
  store.open('a');
  store.edit({ body: '<p>typed just before leaving</p>' });
  await store.close();
  assert.equal(account.byId('a').body, '<p>typed just before leaving</p>');
  assert.deepEqual(timers.list, []);
});

// --- deleting ---------------------------------------------------------------------

test('deleting a new note while its first save is on its way deletes it by its real id', async () => {
  const { account, store } = await setup();
  store.newNote();
  store.edit({ body: '<p>changed my mind</p>' });
  account.hold('PUT');
  store.flush();
  await tick();
  const removing = store.remove();
  await tick();
  assert.equal(account.deletes().length, 0, 'nothing to delete yet: the note has no id');
  assert.equal(store.get().selectedId, null);
  account.waiting.shift().release();
  await removing;
  assert.deepEqual(account.deletes().map((call) => call.path), ['/note?note_id=srv-1']);
  assert.equal(account.byId('srv-1'), undefined);
  assert.deepEqual(ids(store), [BRAIN_DUMP_PLACEHOLDER_ID, 'b', 'a']);
});

test('deleting a note with unsaved text does not save it first', async () => {
  const { account, store } = await setup();
  store.open('a');
  store.edit({ body: '<p>never mind</p>' });
  await store.remove();
  assert.equal(account.puts().length, 0);
  assert.equal(account.byId('a'), undefined);
  assert.deepEqual(ids(store), [BRAIN_DUMP_PLACEHOLDER_ID, 'b']);
});

test('a delete that fails says so and puts the note back', async () => {
  const { account, store } = await setup();
  store.open('b');
  account.online = false;
  await store.remove();
  assert.equal(store.get().message, DELETE_FAILED);
  assert.equal(store.get().status, 'ready');
  assert.deepEqual(ids(store), [BRAIN_DUMP_PLACEHOLDER_ID, 'b', 'a']);
  account.online = true;
  store.open('b');
  await store.remove();
  assert.equal(account.byId('b'), undefined);
});

// --- new notes --------------------------------------------------------------------

test('unused new notes do not pile up in the list', async () => {
  const { account, store } = await setup();
  store.newNote();
  store.newNote();
  store.newNote();
  assert.equal(ids(store).filter((id) => id.startsWith('draft-')).length, 1);
  store.open('a');
  assert.equal(ids(store).filter((id) => id.startsWith('draft-')).length, 0);
  // Typed in, then cleared again: still nothing to keep.
  store.newNote();
  store.edit({ body: '<p>x</p>' });
  store.edit({ body: '' });
  store.open('a');
  await tick();
  assert.equal(ids(store).filter((id) => id.startsWith('draft-')).length, 0);
  assert.equal(account.puts().length, 0);
});

test('a new note is named after its first words; an empty one cannot be pinned', async () => {
  const { account, store } = await setup();
  store.newNote();
  await store.togglePin();
  assert.equal(store.get().message, PIN_EMPTY);
  store.edit({ body: '<p>Call the bank about the card</p>' });
  await store.flush();
  assert.equal(account.byId('srv-1').title, 'Call the bank about the card');
  assert.equal(store.get().title, 'Call the bank about the card');
  await store.togglePin();
  assert.ok(account.byId('srv-1').pinned_at);
  assert.ok(store.get().note.pinned_at);
});

test('a saved note can be emptied', async () => {
  const { account, store } = await setup();
  store.open('a');
  store.edit({ title: '', body: '' });
  await store.flush();
  assert.equal(account.byId('a').body, '');
  assert.equal(account.byId('a').title, UNTITLED);
  assert.equal(store.get().saveState, 'saved');
});

test('a note over the limit is refused with a reason and nothing is cut off', async () => {
  const { account, store } = await setup();
  store.open('a');
  store.edit({ body: 'x'.repeat(MAX_BODY + 1) });
  await store.flush();
  assert.equal(account.puts().length, 0);
  assert.equal(store.get().saveState, 'error');
  assert.match(store.get().message, /too long/);
  store.edit({ body: 'x'.repeat(MAX_BODY) });
  await store.flush();
  assert.equal(account.byId('a').body.length, MAX_BODY);
});

// --- formatting this editor can't keep ----------------------------------------------

test('a note with formatting the editor would flatten opens read-only and is never saved from here', async () => {
  const { account, store } = await setup([note('web', 1, { body: '<p><font color="red">made on the web</font></p>' }), note('b', 2)]);
  store.open('web');
  assert.equal(store.get().readOnly, true);
  store.edit({ title: 'x', body: '<p>made on the web!</p>' });
  await store.flush();
  await store.close();
  assert.equal(account.puts().length, 0);
  assert.equal(account.byId('web').body, '<p><font color="red">made on the web</font></p>');
  store.open('b');
  assert.equal(store.get().readOnly, false);
});

test('what is saved is the text as it will be shown again', async () => {
  const { account, store } = await setup();
  store.open('a');
  store.edit({ body: '<p><font>pasted</font></p>' });
  await store.flush();
  assert.equal(account.byId('a').body, '<p>pasted</p>');
  store.open('b');
  store.open('a');
  assert.equal(store.get().readOnly, false, 'a note edited here stays editable here');
});

// --- the Brain Dump ---------------------------------------------------------------

const manyNotes = (count) => Array.from({ length: count }, (_, i) => note(`n${i}`, 1, { created_at: new Date(Date.parse('2026-06-01T00:00:00Z') + i * 60000).toISOString() }));

test('a Brain Dump older than the first page is found and used: no second one is created', async () => {
  const old = note('dump', 1, { title: 'Brain Dump', body: '<p>old thoughts</p>', is_brain_dump: true, created_at: '2025-01-01T00:00:00.000Z' });
  const { account, store } = await setup([old, ...manyNotes(120)]);
  assert.equal(ids(store)[0], 'dump');
  assert.ok(!ids(store).includes(BRAIN_DUMP_PLACEHOLDER_ID));
  store.open('dump');
  assert.equal(store.get().body, '<p>old thoughts</p>');
  store.edit({ body: '<p>old thoughts</p><p>new one</p>' });
  await store.flush();
  assert.equal(account.dumps().length, 1);
  assert.equal(account.byId('dump').body, '<p>old thoughts</p><p>new one</p>');
});

test('the empty Brain Dump row is only offered once the whole list was read', async () => {
  const account = fakeAccount(manyNotes(60));
  const store = createNotesStore({ api: createToolsApi({ request: (...args) => account.request(...args) }), log: { error() {} } });
  account.hold('GET');
  const loading = store.load();
  await tick();
  account.waiting.splice(0).forEach((call) => call.release()); // page 1 and the pinned notes
  await tick();
  assert.equal(store.get().status, 'ready');
  assert.ok(!ids(store).includes(BRAIN_DUMP_PLACEHOLDER_ID), 'still looking');
  account.waiting.shift().release(); // notes 1-50
  await tick();
  assert.ok(!ids(store).includes(BRAIN_DUMP_PLACEHOLDER_ID), 'there is another page');
  account.waiting.shift().release(); // notes 51-60
  await loading;
  assert.equal(ids(store)[0], BRAIN_DUMP_PLACEHOLDER_ID);
});

test('when the search for the Brain Dump fails, no empty one is offered', async () => {
  const account = fakeAccount(manyNotes(60));
  const realRequest = account.request;
  account.request = async (method, path, body) => {
    if (path.includes('take=50&order=DESC') && !path.includes('pinned') && path.includes('page=2')) throw Object.assign(new Error('offline'), { status: 0 });
    return realRequest(method, path, body);
  };
  const store = createNotesStore({ api: createToolsApi({ request: (...args) => account.request(...args) }), log: { error() {} } });
  await store.load();
  assert.equal(store.get().status, 'ready');
  assert.ok(!ids(store).includes(BRAIN_DUMP_PLACEHOLDER_ID));
  store.open(BRAIN_DUMP_PLACEHOLDER_ID);
  assert.equal(store.get().selectedId, null);
});

test('with several Brain Dumps the most recently updated one is on top', async () => {
  const { store } = await setup([
    note('d-old', 3, { is_brain_dump: true, updated_at: day(4) }),
    note('d-used', 1, { is_brain_dump: true, updated_at: day(20) }),
    note('a', 5),
  ]);
  assert.deepEqual(ids(store), ['d-used', 'd-old', 'a']);
});

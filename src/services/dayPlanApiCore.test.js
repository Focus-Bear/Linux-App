import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDayPlanApi, DayPlanApiError } from './dayPlanApiCore.js';

const DAY = '2026-11-21';

/** A fetch that answers by URL: routes is [[substring, status, body], ...]; first match wins. */
function routedFetch(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const route = routes.find(([part]) => url.includes(part));
    const [, status, body] = route || ['', 404, { message: 'no route' }];
    return { ok: status >= 200 && status < 300, status, text: async () => (body === null ? '' : JSON.stringify(body)) };
  };
  return { fetch, calls };
}

const make = (routes, extra = {}) => {
  const { fetch, calls } = routedFetch(routes);
  return { calls, api: createDayPlanApi({ fetch, getToken: async () => 'tok', baseUrl: 'https://api.test', ...extra }) };
};

const BASE_ROUTES = [
  ['/day-plan/', 200, { events: [] }],
  ['/user-settings', 200, { startup_time: '07:00', morning_activities: [] }],
  ['/routine-progress', 200, { morning_routine: null }],
  ['/calendar/google/calendar-datas', 200, { calendars: [] }],
  ['/calendar/microsoft/calendar-datas', 200, { calendars: [] }],
  ['/to-do', 200, { data: [{ id: 't1' }], meta: { hasNextPage: false } }],
];

test('a day loads settings, progress, meetings and tasks with the bearer token', async () => {
  const { api, calls } = make(BASE_ROUTES);
  const result = await api.loadDay(DAY, 660);
  assert.equal(result.settings.startup_time, '07:00');
  assert.deepEqual(result.tasks, [{ id: 't1' }]);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.failed, []);
  assert.ok(calls.every((c) => c.headers.Authorization === 'Bearer tok'));
  const urls = calls.map((c) => c.url);
  assert.ok(urls.includes('https://api.test/user-settings?language=en'));
  assert.ok(urls.includes(`https://api.test/completed-activity-sequence/routine-progress?date=${DAY}&timezone=UTC%2B11%3A00`));
  assert.ok(urls.includes('https://api.test/to-do?page=1&take=50&order=DESC&sort_mode=DUE_DATE&exclude_completed=true'));
});

test('meetings are fetched per connected account, skipping accounts that need re-authorising', async () => {
  const { api, calls } = make([
    ['/calendar/google/calendar-datas', 200, { calendars: [{ account: 'a@example.com' }, { account: 'a@example.com' }, { email: 'b@example.com', requires_reauth: true }] }],
    ['/calendar/microsoft/calendar-datas', 200, { calendars: [{ email: 'c@example.com' }] }],
    ['/calendar/google/events', 200, [{ external_id: 'g1' }]],
    ['/calendar/microsoft/events', 200, { events: [{ id: 'm1' }] }],
  ]);
  const events = await api.getEvents(DAY);
  assert.deepEqual(events, [{ external_id: 'g1' }, { id: 'm1' }]);
  const eventCalls = calls.filter((c) => c.url.includes('/events')).map((c) => c.url);
  assert.deepEqual(eventCalls, [
    `https://api.test/calendar/google/events?account=a%40example.com&day=${DAY}`,
    `https://api.test/calendar/microsoft/events?account=c%40example.com&day=${DAY}`,
  ]);
});

test('one calendar failing does not lose the other', async () => {
  const { api } = make([
    ['/calendar/google/calendar-datas', 500, null],
    ['/calendar/microsoft/calendar-datas', 200, { calendars: [{ email: 'c@example.com' }] }],
    ['/calendar/microsoft/events', 200, [{ id: 'm1' }]],
  ]);
  assert.deepEqual(await api.getEvents(DAY), [{ id: 'm1' }]);
});

test('tasks follow the paging to the last page', async () => {
  const { api, calls } = make([
    ['page=1&', 200, { data: [{ id: 'a' }], meta: { hasNextPage: true } }],
    ['page=2&', 200, { data: [{ id: 'b' }], meta: { hasNextPage: false } }],
  ]);
  assert.deepEqual(await api.getOpenTasks(), [{ id: 'a' }, { id: 'b' }]);
  assert.equal(calls.length, 2);
});

test('paging stops after 10 pages even if the server keeps saying there is more', async () => {
  const { api, calls } = make([['/to-do', 200, { data: [{ id: 'x' }], meta: { hasNextPage: true } }]]);
  assert.equal((await api.getOpenTasks()).length, 10);
  assert.equal(calls.length, 10);
});

test('tasks or meetings failing still shows the day, and says which part is missing', async () => {
  const { api } = make([
    ['/user-settings', 200, { morning_activities: [] }],
    ['/routine-progress', 500, null],
    ['/calendar/', 200, { calendars: [] }],
    ['/to-do', 503, null],
  ]);
  const result = await api.loadDay(DAY, 0);
  assert.deepEqual(result.tasks, []);
  assert.equal(result.progress, null);
  assert.deepEqual(result.failed.sort(), ['events', 'progress', 'tasks']);
});

test('without the settings there is no day to show', async () => {
  const { api } = make([['/user-settings', 500, null]]);
  await assert.rejects(api.loadDay(DAY, 0), (error) => error instanceof DayPlanApiError && error.status === 500);
});

test('ticking a task off is a PUT /to-do upsert', async () => {
  const { api, calls } = make([['/to-do', 200, {}]]);
  await api.setTaskCompleted({ id: 't1', title: 'Send it', quadrant: 2 }, true);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url, 'https://api.test/to-do');
  assert.deepEqual(calls[0].body, { id: 't1', title: 'Send it', eisenhower_quadrant: 2, status: 'COMPLETED' });
});

test('adding a task plans it for the day; a blank title sends nothing', async () => {
  const { api, calls } = make([['/to-do', 200, { id: 'new', title: 'Call the bank' }]]);
  const created = await api.addTask(' Call the bank ', DAY);
  assert.equal(created.id, 'new');
  assert.deepEqual(calls[0].body, { title: 'Call the bank', eisenhower_quadrant: 1, due_date: DAY, planned_date: DAY, duration: 600 });
  assert.equal(await api.addTask('  ', DAY), null);
  assert.equal(calls.length, 1);
});

// --- own events and the account's timezone ----------------------------------------

/**
 * A server that files own events by day the way day-plan.service.ts does for an
 * account with no timezone: by the UTC day of their start.
 */
function utcDayServer(stored, { failing = [] } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(`${init.method} ${url.replace('https://api.test', '')}`);
    if (failing.some((part) => url.includes(part))) return { ok: false, status: 500, text: async () => '' };
    const day = url.split('/day/')[1];
    const pick = (list) => list.filter((event) => event.event_begins.slice(0, 10) === day);
    const body = url.includes('/event-series/') ? { day, events: pick(stored.series || []) } : { day, events: pick(stored.single || []), has_more: false };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { calls, api: createDayPlanApi({ fetch, getToken: async () => 'tok', baseUrl: 'https://api.test' }) };
}

test('an event the server files under a neighbouring day is still read (Sydney PC, account on UTC)', async () => {
  // 08:00 on 23 Nov in Sydney (UTC+11) is 21:00Z on the 22nd; 15:00 is 04:00Z on the 23rd.
  const morning = { id: 'e-morning', title: 'Dentist', event_begins: '2026-11-22T21:00:00.000Z', event_ends: '2026-11-22T22:00:00.000Z' };
  const afternoon = { id: 'e-afternoon', title: 'School run', event_begins: '2026-11-23T04:00:00.000Z', event_ends: '2026-11-23T04:30:00.000Z' };
  const { api } = utcDayServer({ single: [morning, afternoon] });
  const events = await api.getPlanEvents('2026-11-23');
  assert.deepEqual(events.map((event) => event.id).sort(), ['e-afternoon', 'e-morning']);
});

test('the same holds west of UTC, and for the repeats of a series', async () => {
  // 20:00 on 22 Nov in Los Angeles (UTC-8) is 04:00Z on the 23rd.
  const evening = { id: 'e-evening', title: 'Choir', event_begins: '2026-11-23T04:00:00.000Z', event_ends: '2026-11-23T05:00:00.000Z' };
  const repeat = { occurrence_id: 's1:2026-11-23T03:00:00.000Z', series_id: 's1', summary: 'Walk', event_begins: '2026-11-23T03:00:00.000Z', event_ends: '2026-11-23T03:30:00.000Z' };
  const { api } = utcDayServer({ single: [evening], series: [repeat] });
  const events = await api.getPlanEvents('2026-11-22');
  assert.deepEqual(events, [evening, { ...repeat, is_series: true }]);
});

test('an event listed under two days is kept once; a neighbouring day failing loses only that day', async () => {
  const fetchFor = (routes) => make(routes);
  const crossing = { id: 'x', title: 'Night shift', event_begins: '2026-11-21T22:00:00.000Z', event_ends: '2026-11-22T02:00:00.000Z' };
  const twice = fetchFor([['/day-plan/events/day/', 200, { events: [crossing] }], ['/day-plan/event-series/', 200, { events: [] }]]);
  assert.deepEqual(await twice.api.getPlanEvents(DAY), [crossing]);

  const own = { id: 'own', title: 'Lunch', event_begins: `${DAY}T12:00:00.000Z`, event_ends: `${DAY}T13:00:00.000Z` };
  const partly = utcDayServer({ single: [own] }, { failing: ['/day/2026-11-20', '/day/2026-11-22', '/event-series/'] });
  assert.deepEqual(await partly.api.getPlanEvents(DAY), [own]);
  // The day itself failing is still an error (the page then says the events are missing).
  const broken = utcDayServer({ single: [own] }, { failing: [`/events/day/${DAY}`] });
  await assert.rejects(broken.api.getPlanEvents(DAY), (error) => error.status === 500);
});

test('the account is told its IANA timezone; an offset or a bare UTC is not sent', async () => {
  const { api, calls } = make([['/user/timezone', 200, { timezone: 'Australia/Sydney' }]]);
  assert.equal(await api.declareTimezone('Australia/Sydney'), true);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].url, 'https://api.test/user/timezone');
  assert.deepEqual(calls[0].body, { timezone: 'Australia/Sydney' });
  for (const useless of ['UTC', 'UTC+11:00', '', null, undefined]) assert.equal(await api.declareTimezone(useless), false);
  assert.equal(calls.length, 1);
});

test('without a token nothing is sent', async () => {
  const { api, calls } = make(BASE_ROUTES, { getToken: async () => null });
  await assert.rejects(api.getSettings(), (error) => error.status === 401);
  assert.equal(calls.length, 0);
});

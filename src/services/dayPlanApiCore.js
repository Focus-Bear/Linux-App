// Focus Bear API calls behind the Day Plan, the same ones the Windows Day Plan
// makes (Habits/DayPlan/DayPlanDataSource.cs, DayPlanCalendar.cs,
// HabitsDayPlan.Tasks.cs):
//
//   GET /user-settings?language=en                                routines and habits
//   GET /completed-activity-sequence/routine-progress?date&timezone  habits done / skipped today
//   GET /calendar/{google|microsoft}/calendar-datas               connected calendar accounts
//   GET /calendar/{platform}/events?account=&day=                 that day's meetings
//   GET /to-do?page=&take=50&order=DESC&sort_mode=DUE_DATE&exclude_completed=true   unfinished tasks
//   PUT /to-do                                                    tick a task off, or add one
//   GET /day-plan/events/day/{day}, /day-plan/event-series/day/{day}   your own events
//   PATCH /user/timezone                                          the account's IANA timezone
//
// `fetch` and `getToken` are passed in, so this file can be tested with node --test.
import { newTaskBody, taskStatusBody, timezoneParam } from './dayPlanModel.js';
import { eventBody, routineBody, shiftDay } from './dayPlanExtras.js';

export const API_BASE_URL = 'https://api.focusbear.io';
export const CALENDAR_PLATFORMS = ['google', 'microsoft'];
const MAX_TASK_PAGES = 10; // 500 unfinished tasks

export class DayPlanApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'DayPlanApiError';
    this.status = status;
  }
}

export function createDayPlanApi({ fetch, getToken, baseUrl = API_BASE_URL }) {
  async function request(method, path, body) {
    const token = await getToken();
    if (!token) throw new DayPlanApiError('Not signed in', 401);
    // No Content-Type without a body: the server answers 400 to a DELETE that
    // announces JSON and sends none.
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new DayPlanApiError(`${method} ${path} failed: ${response.status}`, response.status);
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function getSettings() {
    return request('GET', '/user-settings?language=en');
  }

  function getRoutineProgress(day, offsetMinutesEast) {
    const timezone = encodeURIComponent(timezoneParam(offsetMinutesEast));
    return request('GET', `/completed-activity-sequence/routine-progress?date=${day}&timezone=${timezone}`);
  }

  /** Meetings of `day` from every connected calendar account. A failing account is skipped. */
  async function getEvents(day) {
    const events = [];
    for (const platform of CALENDAR_PLATFORMS) {
      let accounts = [];
      try {
        const data = await request('GET', `/calendar/${platform}/calendar-datas`);
        accounts = [
          ...new Set(
            (data?.calendars || [])
              .filter((calendar) => calendar && !calendar.requires_reauth)
              .map((calendar) => calendar.account || calendar.email)
              .filter(Boolean),
          ),
        ];
      } catch {
        continue;
      }
      for (const account of accounts) {
        try {
          const result = await request('GET', `/calendar/${platform}/events?account=${encodeURIComponent(account)}&day=${day}`);
          const list = Array.isArray(result) ? result : result?.events || result?.data || [];
          events.push(...list);
        } catch {
          // this account's meetings are left out
        }
      }
    }
    return events;
  }

  /**
   * Events added in the Day Plan around `day`: one-off ones and the repeats of
   * a series, from the day before to the day after.
   *
   * The server cuts "the day" in the account's timezone (`iana_timezone`, else
   * the offset a phone last synced, else UTC: day-plan.service.ts
   * getEventsForDay), which need not be this PC's. In Sydney with an account on
   * UTC, an 08:00 event is listed under the day before. So the neighbouring
   * days are read too and the page keeps what falls on its own local day
   * (meetingCards). A neighbour that fails is left out; the day itself must load.
   */
  async function getPlanEvents(day) {
    const days = [shiftDay(day, -1), day, shiftDay(day, 1)];
    const optional = (promise) => promise.catch(() => null);
    const results = await Promise.all(
      days.flatMap((each) => {
        const single = request('GET', `/day-plan/events/day/${each}`);
        return [each === day ? single : optional(single), optional(request('GET', `/day-plan/event-series/day/${each}`))];
      }),
    );
    const events = [];
    const seen = new Set();
    results.forEach((result, index) => {
      const isSeries = index % 2 === 1;
      for (const event of Array.isArray(result?.events) ? result.events : []) {
        if (!event) continue;
        // An event that crosses midnight is listed under both days.
        const key = event.id || event.occurrence_id || `${event.event_begins}-${event.summary || event.title || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push(isSeries ? { ...event, is_series: true } : event);
      }
    });
    return events;
  }

  /** Every unfinished task, following the paging until the last page. */
  async function getOpenTasks() {
    const tasks = [];
    for (let page = 1; page <= MAX_TASK_PAGES; page += 1) {
      const result = await request('GET', `/to-do?page=${page}&take=50&order=DESC&sort_mode=DUE_DATE&exclude_completed=true`);
      tasks.push(...(Array.isArray(result?.data) ? result.data : []));
      if (!result?.meta?.hasNextPage) break;
    }
    return tasks;
  }

  const sequencePath = (id) => `/completed-activity-sequence/${encodeURIComponent(id)}`;

  return {
    getSettings,
    getRoutineProgress,
    getEvents,
    getPlanEvents,
    getOpenTasks,

    /** Adds an event to the Day Plan; returns it as the server stored it. */
    async addEvent(fields, day, timezone, id = crypto.randomUUID()) {
      const result = await request('POST', '/day-plan/events', eventBody(fields, day, timezone, id));
      return Array.isArray(result?.events) ? result.events[0] || null : null;
    },

    async deleteEvent(id) {
      try {
        await request('DELETE', `/day-plan/events/${encodeURIComponent(id)}`);
      } catch (error) {
        if (error?.status !== 404) throw error; // already deleted elsewhere
      }
    },

    /** "Skip routine for today": the routine counts as over and its habits aren't asked for again today. */
    skipRoutine(sequenceId) {
      return request('POST', `${sequencePath(sequenceId)}/force-complete-current-sequence?cancel_habits_for_today=true`, routineBody());
    },

    /** Undoes skipRoutine. */
    undoSkipRoutine(sequenceId) {
      return request('POST', `${sequencePath(sequenceId)}/uncomplete`, routineBody());
    },

    /**
     * Everything the page needs for one day. Settings are required; the other
     * parts fall back to empty and are named in `failed` so the page can say so.
     */
    async loadDay(day, offsetMinutesEast) {
      const failed = [];
      const optional = (name, promise, fallback) =>
        promise.catch(() => {
          failed.push(name);
          return fallback;
        });
      const [settings, progress, events, planEvents, tasks] = await Promise.all([
        getSettings(),
        optional('progress', getRoutineProgress(day, offsetMinutesEast), null),
        optional('meetings', getEvents(day), []),
        optional('events', getPlanEvents(day), []),
        optional('tasks', getOpenTasks(), []),
      ]);
      return { day, settings, progress, events, planEvents, tasks, failed };
    },

    /**
     * Tells the account its IANA timezone ('Australia/Sydney'), which the
     * server prefers when it cuts a Day Plan day. Offsets and bare 'UTC' are
     * refused by the server (UpdateUserTimezoneDto), so they aren't sent.
     * Resolves false when nothing was sent.
     */
    async declareTimezone(name) {
      const timezone = String(name ?? '').trim();
      if (!timezone.includes('/')) return false;
      await request('PATCH', '/user/timezone', { timezone });
      return true;
    },

    setTaskCompleted(task, completed) {
      return request('PUT', '/to-do', taskStatusBody(task, completed));
    },

    async addTask(title, day) {
      const body = newTaskBody(title, day);
      if (!body) return null;
      return request('PUT', '/to-do', body);
    },
  };
}

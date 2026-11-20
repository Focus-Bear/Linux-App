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
//
// `fetch` and `getToken` are passed in, so this file can be tested with node --test.
import { newTaskBody, taskStatusBody, timezoneParam } from './dayPlanModel.js';

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
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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

  return {
    getSettings,
    getRoutineProgress,
    getEvents,
    getOpenTasks,

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
      const [settings, progress, events, tasks] = await Promise.all([
        getSettings(),
        optional('progress', getRoutineProgress(day, offsetMinutesEast), null),
        optional('meetings', getEvents(day), []),
        optional('tasks', getOpenTasks(), []),
      ]);
      return { settings, progress, events, tasks, failed };
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

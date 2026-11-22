// Which day the Day Plan shows and what has been loaded for it.
//
// Several loads can be in the air at once (› pressed twice, a refresh during a
// day change, midnight). Only the answer to the latest request is shown: an
// older one that arrives late is for a day the page has left, and showing it
// left the page empty.
//
// No React and no fetch here: `loadDay(day)` is passed in, so the order of
// answers can be tested with a fake (dayPlanLoader.test.js).

export function createDayLoader({ loadDay, onError = () => {} }) {
  // status: loading | ready | error. `data` is always for `day`.
  let state = { day: null, data: null, status: 'loading' };
  let latest = 0;
  const listeners = new Set();

  function set(next) {
    state = next;
    listeners.forEach((listener) => listener());
  }

  return {
    get: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Shows `day` and loads it. Going to another day clears the page first;
     * loading the same day again keeps what is shown until the answer is in
     * (and if that fails). Resolves true when this request's answer is the one
     * now shown, false when it failed or a newer request took over.
     */
    async show(day) {
      latest += 1;
      const request = latest;
      const sameDay = state.day === day;
      set({
        day,
        data: sameDay ? state.data : null,
        status: sameDay && state.status === 'ready' ? 'ready' : 'loading',
      });
      try {
        const data = await loadDay(day);
        if (request !== latest) return false;
        set({ day, data, status: 'ready' });
        return true;
      } catch (error) {
        if (request !== latest) return false;
        onError(error);
        set({ ...state, status: state.data ? 'ready' : 'error' });
        return false;
      }
    },

    /** Changes the loaded data in place (an event added or deleted on the page). */
    update(change) {
      if (state.data) set({ ...state, data: change(state.data) });
    },
  };
}

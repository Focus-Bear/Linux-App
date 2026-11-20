// Focus Bear API calls of the first-run onboarding (see onboardingModel.js for
// where each comes from in the Windows app).
//
// `request(method, path, body)` and `getDeviceId()` are passed in, for node --test.
import { consentBodies, finishSettingsBody, goalsBody, occupationBody } from './onboardingModel.js';

export function createOnboardingApi({ request, getDeviceId }) {
  return {
    /** Records that the person agreed to the terms and the privacy policy. */
    async sendConsent() {
      for (const body of consentBodies()) await request('PUT', '/user/consent', body);
    },

    async getGoals() {
      const goals = await request('GET', '/user/long-term-goals');
      const list = Array.isArray(goals) ? goals : Array.isArray(goals?.goals) ? goals.goals : [];
      return list.map((goal) => (typeof goal === 'string' ? goal : goal?.goal || goal?.text || '')).filter(Boolean);
    },

    saveGoals(goals) {
      return request('PATCH', '/user/long-term-goals', goalsBody(goals));
    },

    /** { user_relevant_sites: [], user_typical_distractions: [] } for an occupation. */
    async suggestSites(choiceId, typed) {
      const result = await request('POST', '/user/generate-occupation-specific-relevant-sites', occupationBody(choiceId, typed));
      return {
        user_relevant_sites: Array.isArray(result?.user_relevant_sites) ? result.user_relevant_sites : [],
        user_typical_distractions: Array.isArray(result?.user_typical_distractions) ? result.user_typical_distractions : [],
      };
    },

    getSettings() {
      return request('GET', '/user-settings?language=en');
    },

    /**
     * The "All set" save. Returns the settings that were read, so the caller
     * knows whether the account has habits.
     */
    async finish() {
      const settings = await request('GET', '/user-settings?language=en');
      const body = finishSettingsBody(settings);
      if (body) {
        const deviceId = await getDeviceId().catch(() => null);
        const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}&is_onboarding=true` : '?is_onboarding=true';
        await request('PUT', `/user-settings${query}`, body);
        return body;
      }
      return settings;
    },
  };
}

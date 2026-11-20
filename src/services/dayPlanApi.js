// The Day Plan API bound to the signed-in user (see dayPlanApiCore.js).
import { nativeAuthService } from './nativeAuth.js';
import { createDayPlanApi } from './dayPlanApiCore.js';

export const dayPlanApi = createDayPlanApi({
  fetch: (...args) => window.fetch(...args),
  getToken: () => nativeAuthService.getToken(),
});

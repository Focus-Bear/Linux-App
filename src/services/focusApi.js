// The focus session API bound to the signed-in user (see focusApiCore.js).
import { nativeAuthService } from './nativeAuth.js';
import { createFocusApi } from './focusApiCore.js';

export const focusApi = createFocusApi({
  fetch: (...args) => window.fetch(...args),
  getToken: () => nativeAuthService.getToken(),
});

// What an embedded dashboard page is handed when it loads: the sign-in and the
// look of the app. `extra` adds page-specific fields (e.g. long_term_goals).
import { nativeAuthService } from '../services/nativeAuth.js';

export async function buildWebViewMetadata(theme, extra = null) {
  try {
    return {
      access_token: await nativeAuthService.getToken(),
      id_token: nativeAuthService.idToken,
      client_id: nativeAuthService.clientId,
      user: nativeAuthService.getUser(),
      theme,
      lang: 'en',
      font: 'default',
      flags: [],
      tasks: '[]',
      total_duration: 0,
      intention: '',
      brain_dump: '',
      ...(extra || {}),
    };
  } catch (error) {
    console.error('[WebViewHost] Failed to build webview metadata:', error);
    return null;
  }
}

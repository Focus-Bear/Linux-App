// Light / dark / follow-the-system theme, matching the Windows app's
// AppThemePreference (Core/Ui/AppThemePreference.cs). Pure functions so they can
// be unit-tested with node --test; ThemeContext.jsx wires them into React.

export const THEME_PREFERENCES = ['system', 'light', 'dark'];
export const THEME_STORAGE_KEY = 'fb_theme_preference';

/** Background the embedded dashboard pages paint before they load (Theme/*.xaml BackgroundColor). */
export const WEBVIEW_BACKGROUND = { light: '#FFFFFF', dark: '#282828' };

export function normalizePreference(value) {
  return THEME_PREFERENCES.includes(value) ? value : 'system';
}

/** 'light' | 'dark' for a stored preference and the OS colour scheme. */
export function resolveTheme(preference, systemPrefersDark) {
  const pref = normalizePreference(preference);
  if (pref === 'system') return systemPrefersDark ? 'dark' : 'light';
  return pref;
}

/** The dashboard webviews take the theme as 'LIGHT' / 'DARK' (same as the Windows and Mac apps). */
export function webviewTheme(resolved) {
  return resolved === 'dark' ? 'DARK' : 'LIGHT';
}

export function readPreference(storage) {
  try {
    return normalizePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

export function writePreference(storage, preference) {
  try {
    storage?.setItem(THEME_STORAGE_KEY, normalizePreference(preference));
  } catch {
    // storage unavailable (private mode / sandbox): the choice just won't persist
  }
}

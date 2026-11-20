import { useCallback, useEffect, useMemo, useState } from 'react';
import { normalizePreference, readPreference, resolveTheme, writePreference } from './theme.js';
import { ThemeContext } from './useTheme.js';

const darkQuery = () => window.matchMedia?.('(prefers-color-scheme: dark)');

/** Applies the chosen theme to <html data-theme> and keeps following the OS when set to System. */
export default function ThemeProvider({ children }) {
  const [preference, setPreferenceState] = useState(() => readPreference(window.localStorage));
  const [systemDark, setSystemDark] = useState(() => !!darkQuery()?.matches);

  useEffect(() => {
    const query = darkQuery();
    if (!query) return undefined;
    const onChange = (event) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const resolved = resolveTheme(preference, systemDark);

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    window.api?.setTheme?.(resolved); // the tray popup follows the same theme
  }, [resolved]);

  const setPreference = useCallback((next) => {
    writePreference(window.localStorage, next);
    setPreferenceState(normalizePreference(next));
  }, []);

  const value = useMemo(() => ({ preference, resolved, setPreference }), [preference, resolved, setPreference]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

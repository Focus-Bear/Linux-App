import { createContext, useContext } from 'react';

export const ThemeContext = createContext({
  preference: 'system',
  resolved: 'light',
  setPreference: () => {},
});

/** { preference: 'system'|'light'|'dark', resolved: 'light'|'dark', setPreference } */
export function useTheme() {
  return useContext(ThemeContext);
}

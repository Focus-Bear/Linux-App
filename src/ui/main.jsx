import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ThemeProvider from './ThemeProvider.jsx'
import { readPreference, resolveTheme } from './theme.js'

// Apply the theme before the first paint so dark mode doesn't flash white.
document.documentElement.dataset.theme = resolveTheme(
  readPreference(window.localStorage),
  window.matchMedia?.('(prefers-color-scheme: dark)').matches,
)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
)

import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'dist-react', 'release']),
  {
    files: ['**/*.{js,jsx,mjs,cjs}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  // Electron main/preload, the native-messaging host, build config, dev scripts and tests run in Node.
  {
    files: [
      'src/electron/**/*.{js,cjs}',
      'src/native-messaging/**/*.js',
      'scripts/**/*.{js,mjs}',
      '*.config.js',
      '**/*.test.js',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  // The browser extensions use the WebExtensions APIs (browser.*, chrome.*).
  {
    files: ['src/extension/**/*.js', 'src/extension-chrome/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
])

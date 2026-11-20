// Sidebar navigation model. Mirrors the Windows app's left menu
// (FocusBearMainWindow.xaml + Core/Navigation/LeftMenuRules.cs): sections
// MAIN / TOOLS / PREFERENCES, labels from config.json "leftMenuVcInfo".
// Entries the Linux app doesn't have yet (Day Plan, Habits, Micro Breaks,
// Brain Dump, Focus Music, Time Tracker, ...) are tracked as GitHub issues.
//
// Each page is either a React page (`page`) or an embedded dashboard webview
// (`webview`, a key of webViewConfigs in src/electron/webview-handler.js).
// `action` entries don't open a page; the shell runs them (e.g. focus session).

export const NAV_SECTIONS = [
  {
    id: 'main',
    title: 'MAIN',
    items: [
      { id: 'focus-session', label: 'Start Focus Session', activeLabel: 'Stop Focus Session', icon: 'focus', action: 'toggle-focus-session' },
    ],
  },
  {
    id: 'tools',
    title: 'TOOLS',
    items: [
      { id: 'todo-list', label: 'Todo List', icon: 'todo', webview: 'todo-list' },
      { id: 'stats', label: 'Stats', icon: 'stats', webview: 'stats' },
      { id: 'motivation', label: 'Motivation', icon: 'motivation', webview: 'motivation' },
    ],
  },
  {
    id: 'preferences',
    title: 'PREFERENCES',
    items: [
      {
        id: 'blocking',
        label: 'Blocking',
        icon: 'blocking',
        children: [
          { id: 'blocking-schedule', label: 'Blocking Schedule', icon: 'schedule', page: 'blocking-schedule' },
          { id: 'super-distracting-sites', label: 'Super Distracting Sites', icon: 'globe', page: 'super-distracting-sites' },
          { id: 'keyword-blocking', label: 'Keyword Blocking', icon: 'keyword', page: 'keyword-blocking' },
        ],
      },
      {
        id: 'settings',
        label: 'Settings',
        icon: 'settings',
        children: [
          { id: 'settings-ui', label: 'UI', icon: 'ui', page: 'settings-ui' },
          { id: 'settings-account', label: 'Account', icon: 'account', page: 'settings-account' },
          { id: 'settings-uninstall', label: 'Uninstall', icon: 'uninstall', page: 'settings-uninstall' },
        ],
      },
      { id: 'edit-habits', label: 'Edit Habits', icon: 'habits', webview: 'edit_habits' },
      { id: 'help', label: 'Help & Support', icon: 'help', webview: 'get_support' },
    ],
  },
];

/** Opens on Blocking (issue #48): the Linux app's main job is distraction blocking. */
export const DEFAULT_ITEM_ID = 'blocking';

export function allItems(sections = NAV_SECTIONS) {
  return sections.flatMap((section) => section.items);
}

export function findItem(id, sections = NAV_SECTIONS) {
  return allItems(sections).find((item) => item.id === id) || null;
}

/**
 * The page or webview to show for a top-level item and the remembered sub-page.
 * Returns { item, child, page, webview } (child is null for items without children).
 */
export function resolveDestination(itemId, childId, sections = NAV_SECTIONS) {
  const item = findItem(itemId, sections) || findItem(DEFAULT_ITEM_ID, sections);
  if (!item.children) {
    return { item, child: null, page: item.page || null, webview: item.webview || null };
  }
  const child = item.children.find((c) => c.id === childId) || item.children[0];
  return { item, child, page: child.page || null, webview: child.webview || null };
}

/** Label for an item, taking a running focus session into account. */
export function itemLabel(item, { focusActive = false } = {}) {
  return focusActive && item.activeLabel ? item.activeLabel : item.label;
}

/**
 * Interprets the main process's 'focus-session-result' message
 * (src/electron/main.js) as the new focus state, or null if unknown.
 */
export function focusStateFromResult(message) {
  if (typeof message !== 'string') return null;
  if (/started|already active/i.test(message)) return true;
  if (/stopped|already inactive/i.test(message)) return false;
  return null;
}

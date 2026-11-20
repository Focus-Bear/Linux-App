// Sidebar navigation model. Mirrors the Windows app's left menu
// (FocusBearMainWindow.xaml + Core/Navigation/LeftMenuRules.cs): sections
// MAIN / TOOLS / PREFERENCES, labels from config.json "leftMenuVcInfo".
// Entries the Linux app doesn't have yet (Revise, Time Tracker, ...) are
// tracked as GitHub issues. TOOLS entries can be hidden with the cog.
//
// Each page is either a React page (`page`) or an embedded dashboard webview
// (`webview`, a key of webViewConfigs in src/electron/webview-handler.js).
// `action` entries don't open a page; the shell runs them.

export const NAV_SECTIONS = [
  {
    id: 'main',
    title: 'MAIN',
    items: [
      // Set-up checklist and levels (src/ui/achievements.jsx).
      { id: 'achievements', label: 'Achievements', icon: 'achievements', page: 'achievements' },
      // Today's routines, meetings and tasks (src/ui/day-plan.jsx).
      { id: 'day-plan', label: 'Day Plan', icon: 'dayplan', page: 'day-plan' },
      // Start / running / end screens (src/ui/focus-session.jsx).
      { id: 'focus-session', label: 'Start Focus Session', activeLabel: 'Focusing', icon: 'focus', page: 'focus-session' },
      // The break itself: start, playing, finished (src/ui/micro-break.jsx).
      { id: 'micro-break', label: 'Start Micro Break', icon: 'break', page: 'micro-break' },
    ],
  },
  {
    id: 'tools',
    title: 'TOOLS',
    items: [
      { id: 'todo-list', label: 'Todo List', icon: 'todo', webview: 'todo-list' },
      // Notes and the Brain Dump (src/ui/notes.jsx).
      { id: 'notes', label: 'Notes', icon: 'notes', page: 'notes' },
      { id: 'focus-music', label: 'Focus Music', icon: 'music', page: 'focus-music' },
      // Streaks, leaderboard, goals and the focus log (src/ui/stats.jsx).
      { id: 'stats', label: 'Stats', icon: 'stats', page: 'stats' },
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
          // The account's block lists ("focus modes"), used by focus sessions and schedules.
          { id: 'block-lists', label: 'Block Lists', icon: 'blocking', page: 'block-lists' },
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
          // Cuddly / Grizzly: the strictness a new focus session starts on.
          { id: 'settings-strictness', label: 'Strictness', icon: 'blocking', page: 'settings-strictness' },
          { id: 'settings-focus', label: 'Focus Sessions', icon: 'focus', page: 'settings-focus' },
          { id: 'settings-breaks', label: 'Breaks', icon: 'break', page: 'settings-breaks' },
          { id: 'settings-accessibility', label: 'Accessibility', icon: 'account', page: 'settings-accessibility' },
          { id: 'settings-account', label: 'Account', icon: 'account', page: 'settings-account' },
          { id: 'settings-subscription', label: 'Subscription', icon: 'motivation', webview: 'upgrade-now' },
          { id: 'settings-about', label: 'About', icon: 'help', page: 'settings-about' },
          { id: 'settings-uninstall', label: 'Uninstall', icon: 'uninstall', page: 'settings-uninstall' },
        ],
      },
      { id: 'edit-habits', label: 'Edit Habits', icon: 'habits', webview: 'edit_habits' },
      { id: 'help', label: 'Help & Support', icon: 'help', webview: 'get_support' },
    ],
  },
];

/** Opens on the Day Plan, like the Windows app (it used to open on Blocking, #48). */
export const DEFAULT_ITEM_ID = 'day-plan';

/** Ids of the TOOLS entries (the ones that can be hidden). */
export function toolIds(sections = NAV_SECTIONS) {
  return (sections.find((section) => section.id === 'tools')?.items || []).map((item) => item.id);
}

/** The sections without the hidden tools. A hidden tool that is open stays listed until another page is opened. */
export function visibleSections(hidden = [], activeId = null, sections = NAV_SECTIONS) {
  const gone = new Set(hidden);
  return sections.map((section) =>
    section.id === 'tools'
      ? { ...section, items: section.items.filter((item) => !gone.has(item.id) || item.id === activeId) }
      : section,
  );
}

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

/**
 * Label for an item, taking a running focus session into account.
 * `focusClock` is the time left ("24:10"), shown after the active label.
 */
export function itemLabel(item, { focusActive = false, focusClock = '' } = {}) {
  if (!focusActive || !item.activeLabel) return item.label;
  return focusClock ? `${item.activeLabel} · ${focusClock}` : item.activeLabel;
}

/** True for the ids the main process may ask the window to show ('navigate-to'). */
export function isNavigable(id, sections = NAV_SECTIONS) {
  return Boolean(findItem(id, sections));
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

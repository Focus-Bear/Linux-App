import { useEffect, useState } from 'react';
import Sidebar from './Sidebar.jsx';
import WebViewHost from './WebViewHost.jsx';
import Icon from './icons.jsx';
import { DEFAULT_ITEM_ID, isNavigable, resolveDestination } from './navigation.js';
import { useFocusSession } from './useFocusSession.js';
import { clockMs, formatClock } from '../electron/focusSessionModel.js';
import FocusSessionPage from './focus-session.jsx';
import DayPlanPage from './day-plan.jsx';
import SettingsFocusPage from './settings-focus.jsx';
import SettingsAboutPage from './settings-about.jsx';
import SettingsBreaksPage from './settings-breaks.jsx';
import MicroBreakPage from './micro-break.jsx';
import { useBreaks } from './useBreaks.js';
import { useBlocking } from './useBlocking.js';
import BlockListsPage from './block-lists.jsx';
import Distracting_sites_page from './distracting-sites';
import BlockingSchedule from './blocking-schedule';
import Keywords_page from './keyword-page';
import UninstallPage from './uninstall-page';
import AccountPage from './account';
import SettingsUIPage from './settings-ui.jsx';
import NotesPage from './notes.jsx';
import StatsPage from './stats.jsx';
import FocusMusicPage from './focus-music.jsx';
import AchievementsPage from './achievements.jsx';
import { toolIds } from './navigation.js';
import { HIDDEN_TOOLS_KEY, parseHiddenTools, toggleHiddenTool } from '../services/statsModel.js';

const COLLAPSED_KEY = 'fb_sidebar_collapsed';

// Hidden tools are kept on this computer only, as on Windows (HiddenToolIds).
const readHiddenTools = () => {
  try {
    return parseHiddenTools(window.localStorage.getItem(HIDDEN_TOOLS_KEY), toolIds());
  } catch {
    return [];
  }
};

const readCollapsed = () => {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * Main window after sign-in: Windows-style sidebar on the left, an optional
 * second column for pages with sub-pages (Blocking, Settings), and the page.
 */
const PreferencesPage = function ({ user, syncStatus, onForceSync, onLogout, initialPage = null }) {
  const [activeId, setActiveId] = useState(() => (initialPage && isNavigable(initialPage) ? initialPage : DEFAULT_ITEM_ID));
  const [childIds, setChildIds] = useState({});
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [hiddenTools, setHiddenTools] = useState(readHiddenTools);

  const toggleTool = (id) => {
    setHiddenTools((prev) => {
      const next = toggleHiddenTool(prev, id);
      try {
        window.localStorage.setItem(HIDDEN_TOOLS_KEY, next.join(','));
      } catch {
        // not persisted
      }
      return next;
    });
  };
  const focus = useFocusSession();
  const focusActive = focus.active;
  const breaks = useBreaks();
  const blocking = useBlocking(focus.session);

  const { item, child, page, webview } = resolveDestination(activeId, childIds[activeId]);

  // The main process sends the window to a page: tray > Start Focus Session,
  // or the end screen when a session's time runs out.
  useEffect(() => {
    const off = window.api?.onNavigate?.((pageId) => {
      if (isNavigable(pageId)) setActiveId(pageId);
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      try {
        window.localStorage.setItem(COLLAPSED_KEY, prev ? '0' : '1');
      } catch {
        // not persisted
      }
      return !prev;
    });
  };

  const openChild = (itemId, childId) => {
    setChildIds((prev) => ({ ...prev, [itemId]: childId }));
    setActiveId(itemId);
  };

  // No sidebar entry is an action at the moment; kept for entries that run
  // something instead of opening a page.
  const handleAction = () => {};

  const renderPage = () => {
    switch (page) {
      case 'day-plan':
        return (
          <DayPlanPage
            onOpenTodoList={() => setActiveId('todo-list')}
            onEditHabits={() => setActiveId('edit-habits')}
          />
        );
      case 'notes':
        return <NotesPage />;
      case 'stats':
        return <StatsPage />;
      case 'focus-music':
        return <FocusMusicPage />;
      case 'achievements':
        return (
          <AchievementsPage
            blocking={blocking}
            onOpen={([itemId, childId]) => (childId ? openChild(itemId, childId) : setActiveId(itemId))}
          />
        );
      case 'micro-break':
        return (
          <MicroBreakPage
            breaks={breaks}
            onEditHabits={() => setActiveId('edit-habits')}
            onOpenSettings={() => openChild('settings', 'settings-breaks')}
            onLeave={() => setActiveId('day-plan')}
          />
        );
      case 'settings-breaks':
        return (
          <SettingsBreaksPage
            breaks={breaks}
            onEditHabits={() => setActiveId('edit-habits')}
            onStartBreak={() => setActiveId('micro-break')}
          />
        );
      case 'focus-session':
        return (
          <FocusSessionPage
            session={focus.session}
            now={focus.now}
            loaded={focus.loaded}
            blocking={blocking}
            onEditBlockLists={() => openChild('blocking', 'block-lists')}
          />
        );
      case 'blocking-schedule':
        return <BlockingSchedule blocking={blocking} onEditBlockLists={() => openChild('blocking', 'block-lists')} />;
      case 'block-lists':
        return <BlockListsPage blocking={blocking} onOpenDistractingSites={() => openChild('blocking', 'super-distracting-sites')} />;
      case 'super-distracting-sites':
        return <Distracting_sites_page />;
      case 'keyword-blocking':
        return <Keywords_page />;
      case 'settings-ui':
        return <SettingsUIPage />;
      case 'settings-focus':
        return <SettingsFocusPage />;
      case 'settings-about':
        return <SettingsAboutPage />;
      case 'settings-account':
        return <AccountPage user={user} syncStatus={syncStatus} onForceSync={onForceSync} onLogout={onLogout} />;
      case 'settings-uninstall':
        return <UninstallPage />;
      default:
        return null;
    }
  };

  const syncText = { synced: 'Synced', error: 'Sync error', syncing: 'Syncing…', loading: 'Syncing…' }[syncStatus] || 'Local only';

  return (
    <div className="fb-shell">
      <Sidebar
        activeId={item.id}
        onSelect={(navItem) => setActiveId(navItem.id)}
        onAction={handleAction}
        focusActive={focusActive}
        focusClock={focusActive ? formatClock(Math.floor(clockMs(focus.session, focus.now) / 1000) * 1000) : ''}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        hiddenTools={hiddenTools}
        onToggleTool={toggleTool}
        footer={
          user && (
            <>
              <div className="fb-sidebar__user" title={user.email || user.name}>{user.email || user.name}</div>
              <div>{syncText}</div>
            </>
          )
        }
      />

      <main className="fb-main">
        {item.children && (
          <nav className="fb-subnav" aria-label={item.label}>
            <h2 className="fb-subnav__title">{item.label}</h2>
            {item.children.map((sub) => (
              <button
                key={sub.id}
                type="button"
                className="fb-nav-item"
                aria-current={sub.id === child?.id ? 'page' : undefined}
                onClick={() => setChildIds((prev) => ({ ...prev, [item.id]: sub.id }))}
              >
                <Icon name={sub.icon} />
                <span className="fb-nav-item__label">{sub.label}</span>
              </button>
            ))}
          </nav>
        )}

        {webview ? (
          <section className="fb-content fb-content--flush">
            <WebViewHost key={webview} id={webview} label={(child || item).label} />
          </section>
        ) : (
          <section className="fb-content">{renderPage()}</section>
        )}
      </main>
    </div>
  );
};

export default PreferencesPage;

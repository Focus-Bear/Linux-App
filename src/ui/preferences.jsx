import { useEffect, useState } from 'react';
import Sidebar from './Sidebar.jsx';
import WebViewHost from './WebViewHost.jsx';
import Icon from './icons.jsx';
import { DEFAULT_ITEM_ID, isNavigable, resolveDestination } from './navigation.js';
import { useFocusSession } from './useFocusSession.js';
import { clockMs, formatClock, hasStopFriction, strictnessLevel } from '../electron/focusSessionModel.js';
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
import SettingsStrictnessPage from './settings-strictness.jsx';
import SettingsAccessibilityPage from './settings-accessibility.jsx';
import { SYNC_TEXT, useSyncedState } from '../services/sync.js';
import { musicStore } from '../services/musicStore.js';
import { musicAction } from '../services/settingsModel.js';
import { postponeStore } from '../services/postponeStore.js';
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

  // A postponed routine: when its time comes, open the Day Plan and say so.
  useEffect(() => {
    const check = () => {
      const entry = postponeStore.get();
      if (!entry || Date.now() < entry.until) return;
      postponeStore.clear();
      setActiveId('day-plan');
      window.api?.showPreferences?.();
      try {
        new Notification('Focus Bear', { body: `Time for your ${String(entry.title || 'routine').toLowerCase()}.` });
      } catch {
        // no notifications on this desktop: the window coming up is the reminder
      }
    };
    const timer = setInterval(check, 15000);
    return () => clearInterval(timer);
  }, []);

  // Settings > Accessibility: "Prefer reduced motion" switches the animations off.
  const [reducedMotion] = useSyncedState('reducedMotion');
  useEffect(() => {
    if (reducedMotion) document.documentElement.dataset.reducedMotion = '1';
    else delete document.documentElement.dataset.reducedMotion;
  }, [reducedMotion]);

  // Focus music when a session starts (Settings > Focus Sessions): play it, or
  // ask on the session screen. A session is handled once, also across a restart.
  const [musicChoice, setMusicChoice] = useSyncedState('focusMusicAutoStart');
  const [askMusic, setAskMusic] = useState(false);
  const sessionKey = focusActive && focus.session ? String(focus.session.startTime) : '';
  useEffect(() => {
    if (!focusActive) setAskMusic(false);
    if (!sessionKey) return;
    let handledKey = '';
    try {
      handledKey = window.sessionStorage.getItem('fb_music_session') || '';
    } catch {
      // asked again after a reload
    }
    const action = musicAction({ choice: musicChoice, sessionKey, handledKey, playing: musicStore.get().playing });
    if (action === 'nothing') return;
    try {
      window.sessionStorage.setItem('fb_music_session', sessionKey);
    } catch {
      // not remembered
    }
    if (action === 'play') musicStore.autoPlay();
    else setAskMusic(true);
    // The choice is read when the session starts; changing it later doesn't start music.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, focusActive]);

  const answerMusic = (play, remember) => {
    setAskMusic(false);
    if (play) musicStore.autoPlay();
    if (remember) setMusicChoice(play ? 'play' : 'off');
  };

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
            onStartFocus={() => setActiveId('focus-session')}
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
            askMusic={askMusic}
            onAnswerMusic={answerMusic}
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
      case 'settings-strictness':
        return <SettingsStrictnessPage onOpenFocus={() => setActiveId('focus-session')} />;
      case 'settings-accessibility':
        return <SettingsAccessibilityPage />;
      case 'settings-focus':
        return <SettingsFocusPage />;
      case 'settings-about':
        return <SettingsAboutPage />;
      case 'settings-account':
        return (
          <AccountPage
            user={user}
            syncStatus={syncStatus}
            onForceSync={onForceSync}
            onLogout={onLogout}
            sessionLock={focusActive && hasStopFriction(focus.session) ? strictnessLevel(focus.session.strictness)?.label || 'strict' : ''}
          />
        );
      case 'settings-uninstall':
        return <UninstallPage />;
      default:
        return null;
    }
  };

  const syncText = SYNC_TEXT[syncStatus] || 'Not synced';
  const syncHelp = {
    offline: "Your account's settings couldn't be loaded. Focus Bear is using the copy saved on this computer and will try again.",
    pending: "A change you made here hasn't reached your account yet. Focus Bear will keep trying.",
  }[syncStatus];

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
              <div className={syncHelp ? 'fb-sidebar__sync fb-sidebar__sync--warn' : 'fb-sidebar__sync'} title={syncHelp} role="status">{syncText}</div>
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

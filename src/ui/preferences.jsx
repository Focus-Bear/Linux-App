import { useEffect, useState } from 'react';
import Sidebar from './Sidebar.jsx';
import WebViewHost from './WebViewHost.jsx';
import Icon from './icons.jsx';
import { DEFAULT_ITEM_ID, focusStateFromResult, resolveDestination } from './navigation.js';
import Distracting_sites_page from './distracting-sites';
import BlockingSchedule from './blocking-schedule';
import Keywords_page from './keyword-page';
import UninstallPage from './uninstall-page';
import AccountPage from './account';
import SettingsUIPage from './settings-ui.jsx';

const COLLAPSED_KEY = 'fb_sidebar_collapsed';

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
const PreferencesPage = function ({ user, syncStatus, onForceSync, onLogout }) {
  const [activeId, setActiveId] = useState(DEFAULT_ITEM_ID);
  const [childIds, setChildIds] = useState({});
  const [focusActive, setFocusActive] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const { item, child, page, webview } = resolveDestination(activeId, childIds[activeId]);

  useEffect(() => {
    window.api?.getFocusState?.().then((active) => setFocusActive(Boolean(active))).catch(() => {});
    const offState = window.api?.onFocusStateChanged?.((active) => setFocusActive(Boolean(active)));
    window.api?.onFocusSessionResult?.((message) => {
      const next = focusStateFromResult(message);
      if (next !== null) setFocusActive(next);
    });
    return () => {
      if (typeof offState === 'function') offState();
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

  const handleAction = (navItem) => {
    if (navItem.action === 'toggle-focus-session') {
      window.api?.toggleFocusSession?.(!focusActive);
    }
  };

  const renderPage = () => {
    switch (page) {
      case 'blocking-schedule':
        return <BlockingSchedule />;
      case 'super-distracting-sites':
        return <Distracting_sites_page />;
      case 'keyword-blocking':
        return <Keywords_page />;
      case 'settings-ui':
        return <SettingsUIPage />;
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
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
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

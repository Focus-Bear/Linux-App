import { useState } from 'react';
import Icon from './icons.jsx';
import { itemLabel, NAV_SECTIONS } from './navigation.js';

const LOGO = `${import.meta.env.BASE_URL}bear-icon.png`;

/**
 * Left menu, laid out like the Windows app (FocusBearMainWindow.xaml):
 * logo + collapse button, MAIN / TOOLS / PREFERENCES sections that fold,
 * orange line icons, selected entry as a cream pill with an orange border.
 */
export default function Sidebar({ activeId, onSelect, onAction, focusActive, collapsed, onToggleCollapsed, footer }) {
  const [closedSections, setClosedSections] = useState(() => new Set());

  const toggleSection = (id) =>
    setClosedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <nav className={`fb-sidebar${collapsed ? ' fb-sidebar--collapsed' : ''}`} aria-label="Main menu">
      <div className="fb-sidebar__header">
        {!collapsed && (
          <div className="fb-sidebar__brand">
            <img src={LOGO} alt="" />
            <span>focus bear</span>
          </div>
        )}
        <button
          type="button"
          className="fb-icon-btn"
          onClick={onToggleCollapsed}
          title={collapsed ? 'Expand menu' : 'Collapse menu'}
          aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
        >
          <Icon name={collapsed ? 'expand' : 'collapse'} />
        </button>
      </div>

      <div className="fb-sidebar__scroll">
        {NAV_SECTIONS.map((section) => {
          const closed = closedSections.has(section.id) && !collapsed;
          return (
            <div key={section.id} className={`fb-nav-section${closed ? ' fb-nav-section--closed' : ''}`}>
              <button
                type="button"
                className="fb-nav-section__title"
                onClick={() => toggleSection(section.id)}
                aria-expanded={!closed}
              >
                <span>{section.title}</span>
                <Icon name="chevronDown" size={16} />
              </button>
              {!closed &&
                section.items.map((item) => {
                  const label = itemLabel(item, { focusActive });
                  const isAction = Boolean(item.action);
                  const current = !isAction && item.id === activeId;
                  const sessionRunning = isAction && item.action === 'toggle-focus-session' && focusActive;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`fb-nav-item${sessionRunning ? ' fb-nav-item--active-session' : ''}`}
                      aria-current={current ? 'page' : undefined}
                      title={collapsed ? label : undefined}
                      onClick={() => (isAction ? onAction(item) : onSelect(item))}
                    >
                      <Icon name={item.icon} />
                      <span className="fb-nav-item__label">{label}</span>
                    </button>
                  );
                })}
            </div>
          );
        })}
      </div>

      {footer && <div className="fb-sidebar__footer">{footer}</div>}
    </nav>
  );
}

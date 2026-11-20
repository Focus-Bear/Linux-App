// Script of the tray popup (src/ui/tray.html). Shows the focus session held by
// the main process and sends the user's choices back through the preload API.
import { trayFocusView, normaliseTheme } from './trayModel.js';

const api = window.api;
let session = null;
let tick = null;

const el = (id) => document.getElementById(id);

function render() {
    const view = trayFocusView(session, Date.now());
    el('focus-card').dataset.state = view.state;
    el('focus-title').textContent = view.title;
    el('focus-subtitle').textContent = view.subtitle;
    el('focus-subtitle').title = view.subtitle;

    const primary = el('focus-primary');
    primary.textContent = view.primaryLabel;
    primary.dataset.action = view.primaryAction;
    primary.className = `fb-btn fb-btn--block ${view.primaryAction === 'start' ? 'fb-btn--primary' : 'fb-btn--gray'}`;

    const pause = el('focus-pause');
    pause.hidden = !view.pauseLabel;
    pause.textContent = view.pauseLabel || '';
    pause.dataset.action = view.pauseAction || '';
    pause.className = `fb-btn fb-btn--block ${view.pauseAction === 'resume' ? 'fb-btn--primary' : 'fb-btn--gray'}`;

    // Count down only while a session runs.
    const running = view.state === 'running';
    if (running && !tick) tick = setInterval(render, 1000);
    if (!running && tick) {
        clearInterval(tick);
        tick = null;
    }
}

function setSession(next) {
    session = next || null;
    render();
}

function applyTheme(theme) {
    document.documentElement.dataset.theme = normaliseTheme(theme);
}

function init() {
    el('focus-primary').addEventListener('click', (event) => {
        // Start opens the start screen in the main window; Stop ends the
        // session and shows its summary there.
        api?.toggleFocusSession?.(event.currentTarget.dataset.action === 'start');
    });

    el('focus-pause').addEventListener('click', (event) => {
        const action = event.currentTarget.dataset.action;
        if (action === 'pause') api?.focusSession?.pause?.().then(setSession);
        if (action === 'resume') api?.focusSession?.resume?.().then(setSession);
    });

    document.querySelectorAll('[data-open]').forEach((button) => {
        button.addEventListener('click', () => api?.openPage?.(button.dataset.open));
    });
    el('open-app').addEventListener('click', () => api?.showPreferences?.());
    el('quit').addEventListener('click', () => api?.showQuitDialog?.());

    api?.focusSession?.get?.().then(setSession).catch(() => render());
    api?.focusSession?.onChanged?.(setSession);

    api?.getTheme?.().then(applyTheme).catch(() => {});
    api?.onThemeChanged?.(applyTheme);

    render();
}

init();

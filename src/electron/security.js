// Checks the main process makes before it trusts a URL or the sender of an IPC
// message. Pure functions (security.test.js); main.js and ipcGuard.js use them.
//
// Addresses are parsed, never searched: the old navigation rule let the main
// window (which carries the preload API) go to any address that merely
// contained "auth0.com", such as https://evil.example/?auth0.com.

function parse(url) {
  try {
    return new URL(String(url));
  } catch {
    return null;
  }
}

const hostIs = (host, domain) => host === domain || host.endsWith(`.${domain}`);

/** The Vite dev server the window is loaded from in development. */
export const DEV_ORIGIN = 'http://localhost:5173';

/**
 * Whether the main window may navigate to `url`: the app's own page, and the
 * Auth0 tenant's sign-out page (sign-in happens in its own window).
 * `auth0Domain` is the tenant host (VITE_AUTH0_DOMAIN), when known.
 */
export function isAllowedNavigation(url, { dev = false, auth0Domain = '' } = {}) {
  const parsed = parse(url);
  if (!parsed) return false;
  if (parsed.protocol === 'file:') return true;
  if (dev && parsed.origin === DEV_ORIGIN) return true;
  // Production sign-out returns to http://localhost, which main.js intercepts.
  if (!dev && parsed.origin === 'http://localhost') return true;
  if (parsed.protocol !== 'https:') return false;
  if (auth0Domain) return parsed.hostname === auth0Domain.toLowerCase();
  return hostIs(parsed.hostname, 'auth0.com');
}

/**
 * Whether an IPC message comes from one of the app's own pages: a file inside
 * the app folder, or the dev server in development. Pages from anywhere else
 * (a site the window was navigated to, an embedded dashboard page) are refused.
 * `appPath` is app.getAppPath().
 */
export function isTrustedSender(url, { dev = false, appPath = '' } = {}) {
  const parsed = parse(url);
  if (!parsed) return false;
  if (dev && parsed.origin === DEV_ORIGIN) return true;
  if (parsed.protocol !== 'file:' || !appPath) return false;
  let path;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return false;
  }
  const root = appPath.endsWith('/') ? appPath : `${appPath}/`;
  return path.startsWith(root) && !path.includes('/../');
}

/** Links the app opens in the browser: https pages of focusbear.io and its subdomains. */
export function isFocusBearLink(url) {
  const parsed = parse(url);
  return Boolean(parsed) && parsed.protocol === 'https:' && hostIs(parsed.hostname, 'focusbear.io');
}

/** An update download: a release asset of this repository on GitHub, over https. */
export function isReleaseDownload(url, repo = 'Focus-Bear/Linux-App') {
  const parsed = parse(url);
  if (!parsed || parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return false;
  return parsed.pathname.toLowerCase().startsWith(`/${repo.toLowerCase()}/releases/`);
}

/** Where the embedded dashboard pages may go: the dashboard and its sign-in. */
export function isDashboardNavigation(url) {
  const parsed = parse(url);
  if (!parsed || parsed.protocol !== 'https:') return false;
  // (The subscription page pays through Stripe.)
  return hostIs(parsed.hostname, "focusbear.io") || hostIs(parsed.hostname, "auth0.com") || hostIs(parsed.hostname, "stripe.com");
}

/** True when a dashboard page (and not a frame or another site in the view) may post messages to the app. */
export function isDashboardOrigin(url) {
  const parsed = parse(url);
  return Boolean(parsed) && parsed.origin === 'https://dashboard.focusbear.io';
}

/** A URL for the log: no query and no fragment (they carry sign-in codes and tokens). */
export function redactUrl(url) {
  const parsed = parse(url);
  if (!parsed) return '(unreadable address)';
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search ? '?…' : ''}`;
}

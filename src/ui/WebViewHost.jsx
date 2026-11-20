import { useEffect, useRef } from 'react';
import { nativeAuthService } from '../services/nativeAuth.js';
import { webviewTheme } from './theme.js';
import { useTheme } from './useTheme.js';

const rectOf = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};

async function buildWebViewMetadata(theme) {
  try {
    return {
      access_token: await nativeAuthService.getToken(),
      id_token: nativeAuthService.idToken,
      client_id: nativeAuthService.clientId,
      user: nativeAuthService.getUser(),
      theme,
      lang: 'en',
      font: 'default',
      flags: [],
      tasks: '[]',
      total_duration: 0,
      intention: '',
      brain_dump: '',
    };
  } catch (error) {
    console.error('[WebViewHost] Failed to build webview metadata:', error);
    return null;
  }
}

/**
 * Placeholder that an embedded dashboard page (Electron WebContentsView) is laid
 * over. Reports its on-screen rectangle to the main process so the page lines up
 * with the sidebar layout, and follows the app theme.
 */
export default function WebViewHost({ id, label }) {
  const ref = useRef(null);
  const { resolved } = useTheme();
  const theme = webviewTheme(resolved);

  useEffect(() => {
    let cancelled = false;
    buildWebViewMetadata(theme).then((metadata) => {
      if (cancelled || !ref.current) return;
      window.api?.switchWebView?.(id, metadata, rectOf(ref.current));
    });
    return () => {
      cancelled = true;
    };
  }, [id, theme]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => window.api?.setWebViewBounds?.(rectOf(el)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => window.api?.hideAllWebViews?.(), []);

  return (
    <div ref={ref} className="fb-webview-host" aria-busy="true">
      Loading {label || 'page'}…
    </div>
  );
}

import { useEffect, useRef } from 'react';
import { buildWebViewMetadata } from './webviewMetadata.js';
import { webviewTheme } from './theme.js';
import { useTheme } from './useTheme.js';

const rectOf = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};

/**
 * Placeholder that an embedded dashboard page (Electron WebContentsView) is laid
 * over. Reports its on-screen rectangle to the main process so the page lines up
 * with the sidebar layout, and follows the app theme. `extra` adds page-specific
 * fields to what the page is handed (keep it the same object between renders).
 */
export default function WebViewHost({ id, label, extra = null }) {
  const ref = useRef(null);
  const { resolved } = useTheme();
  const theme = webviewTheme(resolved);

  useEffect(() => {
    let cancelled = false;
    buildWebViewMetadata(theme, extra).then((metadata) => {
      if (cancelled || !ref.current) return;
      window.api?.switchWebView?.(id, metadata, rectOf(ref.current));
    });
    return () => {
      cancelled = true;
    };
  }, [id, theme, extra]);

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

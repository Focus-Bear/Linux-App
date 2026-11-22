import { useEffect, useRef, useState } from 'react';
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
  // The sign-in couldn't be read (the token refresh failed): the page is not
  // opened without it, because a signed-out page would be kept for the session.
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    buildWebViewMetadata(theme, extra).then((metadata) => {
      if (cancelled || !ref.current) return;
      if (!metadata || !metadata.access_token) {
        setFailed(true);
        return;
      }
      setFailed(false);
      window.api?.switchWebView?.(id, metadata, rectOf(ref.current));
    });
    return () => {
      cancelled = true;
    };
  }, [id, theme, extra, attempt]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => window.api?.setWebViewBounds?.(rectOf(el)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => window.api?.hideAllWebViews?.(), []);

  return (
    <div ref={ref} className="fb-webview-host" aria-busy={!failed}>
      {failed ? (
        <div role="alert">
          <p>Couldn&apos;t open {label || 'this page'}: your sign-in couldn&apos;t be checked. Check your connection.</p>
          <button type="button" className="fb-btn fb-btn--primary" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </div>
      ) : (
        <>Loading {label || 'page'}…</>
      )}
    </div>
  );
}

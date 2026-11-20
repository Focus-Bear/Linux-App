import { useEffect, useState } from 'react';
import { updateStatusText } from '../electron/updateVersion.js';

/**
 * Settings > About: the installed version and "Check for updates", like the
 * footer of the Windows Settings column. Updates are downloaded from the
 * GitHub release page; the app doesn't update itself.
 */
export default function SettingsAboutPage() {
  const [info, setInfo] = useState(null);
  const [result, setResult] = useState(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.api?.getAppInfo?.().then((value) => !cancelled && setInfo(value)).catch(() => {});
    window.api?.getLastUpdateStatus?.().then((value) => !cancelled && value && setResult(value)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const check = async () => {
    setChecking(true);
    try {
      setResult(await window.api.checkForUpdates());
    } catch (error) {
      console.error('[About] Update check failed:', error);
      setResult({ status: 'error', error: String(error?.message || error) });
    } finally {
      setChecking(false);
    }
  };

  const updateAvailable = result?.status === 'update-available';

  return (
    <div className="fb-page">
      <h1 className="fb-page__title">About</h1>
      <p className="fb-page__subtitle">Version and updates.</p>

      <section className="fb-card" aria-labelledby="about-version">
        <h2 id="about-version" className="fb-card__title">Focus Bear for Linux</h2>
        <p className="fb-card__desc" style={{ fontSize: 15, color: 'var(--fb-text)' }}>
          Version <strong>{info?.version || '…'}</strong>
        </p>

        <div className="fb-row">
          <button type="button" className="fb-btn fb-btn--primary" onClick={check} disabled={checking}>
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
          {updateAvailable && result.downloadUrl && (
            <button type="button" className="fb-btn" onClick={() => window.api.openUpdateDownload(result.downloadUrl)}>
              Download {result.latestVersion}
            </button>
          )}
        </div>
        <p className="fb-card__desc" role="status" style={{ margin: '12px 0 0' }}>
          {checking ? 'Checking for updates…' : updateStatusText(result)}
        </p>
      </section>
    </div>
  );
}

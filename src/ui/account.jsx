import { useState } from 'react';

const SYNC_STATUS = {
  loading: { text: 'Syncing…', tone: '' },
  syncing: { text: 'Syncing…', tone: '' },
  synced: { text: 'Synced with the cloud', tone: 'fb-pill--ok' },
  error: { text: 'Sync error', tone: 'fb-pill--error' },
  idle: { text: 'Local only', tone: '' },
};

/** Settings > Account: who is signed in, cloud sync, sign out (was the green bar above the tabs). */
const AccountPage = function ({ user, syncStatus = 'idle', onForceSync, onLogout }) {
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const status = SYNC_STATUS[syncStatus] || SYNC_STATUS.idle;
  const busy = syncStatus === 'syncing' || syncStatus === 'loading';

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await onLogout?.();
    } catch (error) {
      console.error('Logout failed:', error);
      setIsLoggingOut(false);
    }
  };

  return (
    <div className="fb-page">
      <h1 className="fb-page__title">Account</h1>
      <p className="fb-page__subtitle">Your Focus Bear account and settings sync.</p>

      <section className="fb-card" aria-labelledby="account-signed-in">
        <h2 id="account-signed-in" className="fb-card__title">Signed in as</h2>
        <p className="fb-card__desc" style={{ fontSize: 15, color: 'var(--fb-text)' }}>
          <strong>{user?.email || user?.name || 'Unknown account'}</strong>
        </p>
        <button type="button" className="fb-btn fb-btn--gray" onClick={handleLogout} disabled={isLoggingOut}>
          {isLoggingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </section>

      <section className="fb-card" aria-labelledby="account-sync">
        <div className="fb-row fb-row--between">
          <div>
            <h2 id="account-sync" className="fb-card__title">Settings sync</h2>
            <p className="fb-card__desc" style={{ marginBottom: 0 }}>
              Your blocked sites, keywords and blocking schedule are saved to your account.
            </p>
          </div>
          <span className={`fb-pill ${status.tone}`} role="status">{status.text}</span>
        </div>
        <div style={{ marginTop: 14 }}>
          <button type="button" className="fb-btn fb-btn--primary" onClick={onForceSync} disabled={busy}>
            {busy ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      </section>
    </div>
  );
};

export default AccountPage;

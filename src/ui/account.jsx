import { useEffect, useState } from 'react';
import './styles/distracting-sites.css'; // shared .fb-input and .fb-dialog
import './styles/settings-extra.css';
import { habitApi } from '../services/habitApi.js';
import { DELETE_WORD, canDeleteAccount, hasPassword, resetPasswordBody } from '../services/settingsModel.js';

const SYNC_STATUS = {
  loading: { text: 'Syncing…', tone: '' },
  syncing: { text: 'Syncing…', tone: '' },
  synced: { text: 'Synced with the cloud', tone: 'fb-pill--ok' },
  error: { text: 'Sync error', tone: 'fb-pill--error' },
  idle: { text: 'Local only', tone: '' },
};

/**
 * Settings > Account: who is signed in (with the user id support asks for),
 * cloud sync, password reset, sign out and deleting the account, like the
 * Windows Account tab (Preferences/SettingsTab/AccountTab.xaml.cs).
 */
const AccountPage = function ({ user, syncStatus = 'idle', onForceSync, onLogout }) {
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [userId, setUserId] = useState('');
  const [copied, setCopied] = useState(false);
  const [reset, setReset] = useState('idle'); // idle | sending | sent | unverified | error
  const [confirmation, setConfirmation] = useState('idle'); // idle | sending | sent | error
  const [deleting, setDeleting] = useState(false); // the confirmation dialog is open
  const [typed, setTyped] = useState('');
  const [deleteState, setDeleteState] = useState('idle'); // idle | busy | error
  const status = SYNC_STATUS[syncStatus] || SYNC_STATUS.idle;
  const busy = syncStatus === 'syncing' || syncStatus === 'loading';

  // The account's id on the Focus Bear server (not the sign-in provider's).
  useEffect(() => {
    let cancelled = false;
    habitApi
      .request('GET', '/user/details')
      .then((details) => {
        if (!cancelled && details?.id) setUserId(String(details.id));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await onLogout?.();
    } catch (error) {
      console.error('Logout failed:', error);
      setIsLoggingOut(false);
    }
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(userId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('[Account] Could not copy the user id:', error);
    }
  };

  const sendReset = async () => {
    const body = resetPasswordBody(user?.email);
    if (!body || reset === 'sending') return;
    setReset('sending');
    try {
      await habitApi.request('POST', '/auth/reset-password', body);
      setReset('sent');
    } catch (error) {
      console.error('[Account] Could not send the reset email:', error);
      // 403: the server only resets the password of a verified email address.
      setReset(error?.status === 403 ? 'unverified' : 'error');
    }
  };

  const resendConfirmation = async () => {
    const body = resetPasswordBody(user?.email);
    if (!body || confirmation === 'sending') return;
    setConfirmation('sending');
    try {
      await habitApi.request('POST', '/auth/email-confirmation', body);
      setConfirmation('sent');
    } catch (error) {
      console.error('[Account] Could not send the confirmation email:', error);
      setConfirmation('error');
    }
  };

  const deleteAccount = async (event) => {
    event.preventDefault();
    if (!canDeleteAccount(typed) || deleteState === 'busy') return;
    setDeleteState('busy');
    try {
      await habitApi.request('DELETE', '/user-data');
    } catch (error) {
      console.error('[Account] Could not delete the account:', error);
      setDeleteState('error');
      return;
    }
    await onLogout?.();
  };

  const closeDelete = () => {
    if (deleteState === 'busy') return;
    setDeleting(false);
    setTyped('');
    setDeleteState('idle');
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
        {userId && (
          <div className="fb-settings__id">
            <span>User ID:</span>
            <code>{userId}</code>
            <button type="button" className="fb-btn fb-btn--gray fb-btn--small" onClick={copyId}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}
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

      {hasPassword(user) && user?.email && (
        <section className="fb-card" aria-labelledby="account-password">
          <h2 id="account-password" className="fb-card__title">Password</h2>
          <p className="fb-card__desc">Focus Bear emails you a link to choose a new password.</p>
          <button type="button" className="fb-btn" onClick={sendReset} disabled={reset === 'sending' || reset === 'sent'}>
            {reset === 'sending' ? 'Sending…' : 'Reset password'}
          </button>
          <p className={`fb-settings__status${reset === 'error' || reset === 'unverified' ? ' fb-settings__status--error' : ''}`} role="status">
            {reset === 'sent' && `Sent. Check the inbox of ${user.email}.`}
            {reset === 'error' && "The email couldn't be sent. Check your connection and try again."}
            {reset === 'unverified' && "Your email address isn't confirmed yet, so the password can't be reset. Confirm it first."}
          </p>
          {reset === 'unverified' && (
            <>
              <button type="button" className="fb-btn" onClick={resendConfirmation} disabled={confirmation === 'sending' || confirmation === 'sent'}>
                {confirmation === 'sending' ? 'Sending…' : 'Resend confirmation email'}
              </button>
              <p className={`fb-settings__status${confirmation === 'error' ? ' fb-settings__status--error' : ''}`} role="status">
                {confirmation === 'sent' && `Sent. Open the link in the email to ${user.email}, then reset your password.`}
                {confirmation === 'error' && "The email couldn't be sent. Check your connection and try again."}
              </p>
            </>
          )}
        </section>
      )}

      <section className="fb-card fb-settings__danger" aria-labelledby="account-delete">
        <h2 id="account-delete" className="fb-card__title">Delete account</h2>
        <p className="fb-card__desc">
          Deletes your Focus Bear account and everything in it: habits, tasks, notes, stats and settings, on every device.
          This can&apos;t be undone.
        </p>
        <button type="button" className="fb-btn fb-btn--danger" onClick={() => setDeleting(true)}>
          Delete Account…
        </button>
      </section>

      {deleting && (
        <div className="fb-dialog-overlay" onClick={closeDelete}>
          <form
            className="fb-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            aria-describedby="delete-text"
            onClick={(e) => e.stopPropagation()}
            onSubmit={deleteAccount}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeDelete();
            }}
          >
            <div className="fb-dialog__header">
              <h2 id="delete-title">Delete your account?</h2>
            </div>
            <div className="fb-dialog__body">
              <p id="delete-text" style={{ marginTop: 0 }}>
                <strong>{user?.email || 'This account'}</strong> and all its data will be deleted for good. To go ahead,
                type {DELETE_WORD} in capitals.
              </p>
              <input
                className="fb-input"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                aria-label={`Type ${DELETE_WORD} to confirm`}
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
              {deleteState === 'error' && (
                <p className="fb-dialog__error" role="alert">
                  The account couldn&apos;t be deleted. Check your connection and try again.
                </p>
              )}
            </div>
            <div className="fb-dialog__footer">
              <button type="submit" className="fb-btn fb-btn--danger" disabled={!canDeleteAccount(typed) || deleteState === 'busy'}>
                {deleteState === 'busy' ? 'Deleting…' : 'Delete my account'}
              </button>
              <button type="button" className="fb-btn fb-btn--primary" onClick={closeDelete} disabled={deleteState === 'busy'}>
                Keep my account
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

export default AccountPage;

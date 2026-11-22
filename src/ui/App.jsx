import React, { useState, useEffect } from 'react';
import Preferences from './preferences.jsx';
import UpdateNotification from './UpdateNotification.jsx';
import Setup from './Setup.jsx';
import { nativeAuthService } from '../services/nativeAuth.js';
import { auth0Sync, useSyncStatus } from '../services/sync.js';
import { habitApi } from '../services/habitApi.js';
import OnboardingPage from './onboarding.jsx';
import { needsOnboarding, withOnboardingDone } from '../services/onboardingModel.js';

const LOGO = `${import.meta.env.BASE_URL}bear-icon.png`;

const App = function() {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  // What the settings sync really did: 'offline' when the account's settings
  // could not be read, 'pending' while a change made here isn't saved yet.
  const syncStatus = useSyncStatus();
  const [setupComplete, setSetupComplete] = useState(null); // null=checking, false=needed, true=done
  // First-run onboarding for a new account; `startPage` is where it hands over to the app.
  const [onboarding, setOnboarding] = useState(false);
  const [startPage, setStartPage] = useState(null);

  // Add this after your state declarations
  useEffect(() => {
    console.log('App state changed:', { 
      user: !!user, 
      isLoading, 
      isAuthenticating,
      settingsLoaded,
      syncStatus,
      currentPath: window.location.pathname,
      currentSearch: window.location.search
    });
  }, [user, isLoading, isAuthenticating, settingsLoaded, syncStatus]);

  useEffect(() => {
    let callbackReceived = false;

    if (window.api?.onAuthProtocolCallback) {
      window.api.onAuthProtocolCallback((url) => {
        console.log('[App] Received auth callback from main process:', url);
        callbackReceived = true;
        const urlObj = new URL(url);
        if (urlObj.searchParams.has('code')) {
          window.history.pushState({}, '', `/callback${urlObj.search}`);
          initializeAuth();
        }
      });
    }

    setTimeout(() => {
      if (!callbackReceived) {
        initializeAuth();
      }
    }, 200);
  }, []);


  const initializeAuth = async function() {
    try {
      // Check first-time setup via local file only — avoids Auth0 round-trip on every launch
      const settings = await window.api.getLocalSettings().catch(() => null);
      if (!settings?.setupComplete) {
        setSetupComplete(false);
        setIsLoading(false);
        return;
      }
      setSetupComplete(true);

      if (window.location.pathname === '/callback' || window.location.search.includes('code=')) {
        console.log('[App] Processing auth callback...');
        setIsAuthenticating(true);

        const userData = await nativeAuthService.handleRedirectCallback();
        setUser(userData);
        setIsAuthenticating(false);

        await initializeCloudSync();
        return;
      }

      const isAuthenticated = await nativeAuthService.isAuthenticated();

      if (isAuthenticated) {
        const userData = nativeAuthService.getUser();
        setUser(userData);

        await initializeCloudSync();
      } else {
        console.log('[App] User not authenticated, starting auto-login...');
        setIsAuthenticating(true);
        await nativeAuthService.login();
      }
    } catch (error) {
      console.error('[App] Auth initialization failed:', error);
      setIsAuthenticating(false);
      setSettingsLoaded(false);
    } finally {
      setIsLoading(false);
    }
  };

  const initializeCloudSync = async function() {
    try {
      // Loads the account's settings. The block list and "Immediately block"
      // are sent to the main process by the sync itself, and only when they
      // came from the account, the copy saved on this computer or the person:
      // never the built-in defaults (an offline start used to replace the
      // extensions' list with facebook.com and x.com).
      await auth0Sync.initialize();

      // Register this install as one of the account's devices (once), as the
      // Windows and Mac apps do at sign-in. Habits can't be completed without it.
      habitApi.registerDevice().catch((error) => console.error('[Device] Could not register this device:', error));

      // A new account (no desktop settings on the server yet) gets the first-run
      // onboarding, as on Windows. Decided before anything is saved for it.
      try {
        const [localSettings, info] = await Promise.all([
          window.api.getLocalSettings().catch(() => null),
          window.api.getAppInfo?.().catch(() => null),
        ]);
        setOnboarding(
          needsOnboarding({
            deviceSettings: auth0Sync.getDocument(),
            localSettings,
            userId: nativeAuthService.getUser()?.sub || '',
            force: Boolean(info?.forceOnboarding),
          }),
        );
      } catch (error) {
        console.error('[Onboarding] Could not decide whether to show onboarding:', error);
      }
      
      setSettingsLoaded(true);
    } catch (error) {
      console.error('Cloud sync initialization failed:', error);
      setSettingsLoaded(true); // Continue with defaults
      throw error;
    }
  };

  const handleManualLogin = async () => {
    setIsAuthenticating(true);
    setSettingsLoaded(false);
    try {
      await nativeAuthService.login();
    } catch (error) {
      console.error('Login failed:', error);
      setIsAuthenticating(false);
    }
  };

  const handleLogout = async () => {
    try {
      // Nothing more is saved for this account, and its settings are forgotten.
      auth0Sync.reset();
      await nativeAuthService.logout();
      setUser(null);
      setSettingsLoaded(false);
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  // Onboarding finished or skipped: remember it for this account on this
  // computer, and open the app on the Start Focus Session screen (as Windows does).
  const finishOnboarding = async (page) => {
    try {
      const localSettings = await window.api.getLocalSettings().catch(() => null);
      await window.api.saveSettings({
        onboardingDone: withOnboardingDone(localSettings, nativeAuthService.getUser()?.sub || ''),
      });
    } catch (error) {
      console.error('[Onboarding] Could not save that onboarding is done:', error);
    }
    setStartPage(page || null);
    setOnboarding(false);
  };

  const handleForceSync = async () => {
    try {
      await auth0Sync.forceSync();
    } catch (error) {
      // Shown as "Not synced" / "Changes not synced yet" (useSyncStatus).
      console.error('Force sync failed:', error?.message || error);
    }
  };

  if (setupComplete === false) {
    return (
      <Setup
        onComplete={() => {
          setSetupComplete(true);
          setIsLoading(true);
          initializeAuth();
        }}
      />
    );
  }

  // Loading state - checking authentication or settings
  if (isLoading || (user && !settingsLoaded)) {
    return (
      <div className="fb-center-screen">
        <div className="fb-center-card" role="status">
          <img src={LOGO} alt="" />
          <h1 className="fb-page__title" style={{ marginTop: 12 }}>Focus Bear</h1>
          <p className="fb-page__subtitle" style={{ marginBottom: 0 }}>
            {isLoading ? 'Checking your sign-in…' : 'Loading your settings…'}
          </p>
          <div className="fb-spinner" />
        </div>
      </div>
    );
  }

  // Not authenticated - auto-login in progress or failed
  if (!user) {
    return (
      <div className="fb-center-screen">
        <div className="fb-center-card fb-card">
          <img src={LOGO} alt="" />
          <h1 className="fb-page__title" style={{ marginTop: 12 }}>Welcome to Focus Bear</h1>
          {isAuthenticating ? (
            <>
              <p className="fb-page__subtitle">Finish signing in in the window that just opened.</p>
              <div className="fb-spinner" role="status" aria-label="Waiting for sign-in" />
            </>
          ) : (
            <>
              <p className="fb-page__subtitle">
                Sign in to sync your blocked sites and settings across devices.
              </p>
              <button type="button" className="fb-btn fb-btn--primary fb-btn--block" onClick={handleManualLogin}>
                Sign in
              </button>
              <p className="fb-card__desc" style={{ marginTop: 12, marginBottom: 0 }}>
                Signing in didn&apos;t finish or was cancelled. Try again.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  if (onboarding) {
    return (
      <div className="fb-app">
        <OnboardingPage user={user} onFinish={finishOnboarding} />
      </div>
    );
  }

  return (
    <div className="fb-app">
      <UpdateNotification />
      <Preferences initialPage={startPage} user={user} syncStatus={syncStatus} onForceSync={handleForceSync} onLogout={handleLogout} />
    </div>
  );
};

export default App;

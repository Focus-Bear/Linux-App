import React, { useState, useEffect } from 'react';
import Preferences from './preferences.jsx';
import UpdateNotification from './UpdateNotification.jsx';
import Setup from './Setup.jsx';
import { nativeAuthService } from '../services/nativeAuth.js';
import { auth0Sync } from '../services/sync.js';
import { habitApi } from '../services/habitApi.js';

const LOGO = `${import.meta.env.BASE_URL}bear-icon.png`;

const App = function() {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [syncStatus, setSyncStatus] = useState('idle');
  const [setupComplete, setSetupComplete] = useState(null); // null=checking, false=needed, true=done

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

        setSyncStatus('loading');
        await initializeCloudSync();
        setSyncStatus('synced');
        return;
      }

      const isAuthenticated = await nativeAuthService.isAuthenticated();

      if (isAuthenticated) {
        const userData = nativeAuthService.getUser();
        setUser(userData);

        setSyncStatus('loading');
        await initializeCloudSync();
        setSyncStatus('synced');
      } else {
        console.log('[App] User not authenticated, starting auto-login...');
        setIsAuthenticating(true);
        await nativeAuthService.login();
      }
    } catch (error) {
      console.error('[App] Auth initialization failed:', error);
      setIsAuthenticating(false);
      setSettingsLoaded(false);
      setSyncStatus('error');
    } finally {
      setIsLoading(false);
    }
  };

  const initializeCloudSync = async function() {
    try {
      console.log('Initializing cloud sync...');
      
      // Initialize the cloud sync manager
      await auth0Sync.initialize();
      
      // Load initial settings and send to main process
      const allStates = auth0Sync.getAllSettings();
      console.log('Cloud sync initialized with states:', allStates);
      
      // Send URL list to main process
      if (allStates.urlList && window.api?.exportList) {
        const urlString = allStates.urlList.join('\n');
        window.api.exportList(urlString);
      }
      window.api?.setBlockSettings?.({ immediatelyBlock: Boolean(allStates.immediatelyBlock) });

      // Register this install as one of the account's devices (once), as the
      // Windows and Mac apps do at sign-in. Habits can't be completed without it.
      habitApi.registerDevice().catch((error) => console.error('[Device] Could not register this device:', error));
      
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
    setSyncStatus('idle');
    try {
      await nativeAuthService.login();
    } catch (error) {
      console.error('Login failed:', error);
      setIsAuthenticating(false);
    }
  };

  const handleLogout = async () => {
    try {
      await nativeAuthService.logout();
      setUser(null);
      setSettingsLoaded(false);
      setSyncStatus('idle');
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  const handleForceSync = async () => {
    try {
      setSyncStatus('syncing');
      await auth0Sync.forceSync();
      setSyncStatus('synced');
    } catch (error) {
      console.error('Force sync failed:', error);
      setSyncStatus('error');
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

  return (
    <div className="fb-app">
      <UpdateNotification />
      <Preferences user={user} syncStatus={syncStatus} onForceSync={handleForceSync} onLogout={handleLogout} />
    </div>
  );
};

export default App;

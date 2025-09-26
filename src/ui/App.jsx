// Updated App.jsx with cloud sync integration and auth fixes
import React, { useState, useEffect } from 'react';
import Preferences from './preferences.jsx';
import { authService } from '../services/auth.js';
import { auth0Sync } from '../services/sync.js';

const App = function() {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [syncStatus, setSyncStatus] = useState('idle');

  
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
    let isHandling = false;
    
    const handleSettingsRequest = async () => {
      if (isHandling) {
        console.log('app.jsx: Settings request already in progress, skipping');
        return;
      }
      
      isHandling = true;
      console.log('app.jsx: Settings request received, user state:', !!user);
      
      try {
        // Your existing handleSettingsRequest logic here...
        let currentUser = user;
        if (!currentUser) {
          console.log('RENDERER: No user, attempting to get from auth service...');
          
          let attempts = 0;
          while (!currentUser && attempts < 30) {
            await new Promise(resolve => setTimeout(resolve, 100));
            
            try {
              const isAuth = await authService.isAuthenticated();
              if (isAuth) {
                currentUser = await authService.getUser();
                console.log('RENDERER: User retrieved from auth service:', !!currentUser);
              }
            } catch (err) {
              console.log('RENDERER: Auth check failed:', err.message);
            }
            
            attempts++;
          }
        }
        
        let accessToken = '';
        if (currentUser) {
          console.log('RENDERER: Attempting to get token...');
          try {
            accessToken = await authService.getToken();
            console.log('RENDERER: Token retrieved:', !!accessToken);
          } catch (error) {
            console.error('RENDERER: Token retrieval failed:', error);
            
            try {
              const tokenSilently = await authService.auth0?.getTokenSilently();
              accessToken = tokenSilently || '';
              console.log('RENDERER: Token via getTokenSilently:', !!accessToken);
            } catch (altError) {
              console.error('RENDERER: Alternative token retrieval failed:', altError);
            }
          }
        }
        
        const webviewSettings = {
          user: currentUser || { 
            email: 'dev@example.com', 
            name: 'Development User',
            sub: 'dev-user-123'
          },
          accessToken: accessToken,
          theme: 'Light',
          selectedFont: 'Arial',
          languageCode: 'en',
          isGeekMode: false,
        };
        
        console.log('RENDERER: Sending webview settings (final)');
        window.api.sendUserSettingsResponse(webviewSettings);
        
      } catch (error) {
        console.error('RENDERER: Settings request handling failed:', error);
        
        const fallbackSettings = {
          user: { 
            email: 'dev@example.com', 
            name: 'Development User',
            sub: 'dev-user-123'
          },
          accessToken: '',
          theme: 'Light',
          selectedFont: 'Arial',
          languageCode: 'en',
          isGeekMode: false,
        };
        
        window.api.sendUserSettingsResponse(fallbackSettings);
      } finally {
        isHandling = false;
      }
    };

    window.api.getUserSettingsForWebview?.(handleSettingsRequest);
    
    // Cleanup
    return () => {
      isHandling = false;
    };
  }, [user]);


  useEffect(() => {
    initializeAuth();
    
    // Listen for auth success/error events
    const handleAuthSuccess = async (event) => {
      setUser(event.detail);
      setIsAuthenticating(false);
      
      // Initialize cloud sync after successful auth
      try {
        setSyncStatus('loading');
        await initializeCloudSync();
        setSyncStatus('synced');
      } catch (error) {
        console.error('Cloud sync initialization failed:', error);
        setSyncStatus('error');
        // Continue anyway, settings will use defaults
        setSettingsLoaded(true);
      }
    };
    
    const handleAuthError = (event) => {
      console.error('Auth error:', event.detail);
      setIsAuthenticating(false);
      setSettingsLoaded(false);
      setSyncStatus('idle');
      // Don't show alert for auto-login failures, just stay on login screen
    };
    
    window.addEventListener('auth-success', handleAuthSuccess);
    window.addEventListener('auth-error', handleAuthError);
    
    return () => {
      window.removeEventListener('auth-success', handleAuthSuccess);
      window.removeEventListener('auth-error', handleAuthError);
    };
  }, []);

  const initializeAuth = async function() {
    try {    
      // Check for callback first
      if (window.location.pathname === '/callback' || window.location.search.includes('code=')) {
        console.log('Processing auth callback...');
        await authService.handleRedirectCallback();
        
        // After successful callback, check auth status
        const isAuthenticated = await authService.isAuthenticated();
        if (isAuthenticated) {
          const userData = await authService.getUser();
          setUser(userData);
          setIsAuthenticating(false);
          
          // Initialize cloud sync after callback
          setSyncStatus('loading');
          await initializeCloudSync();
          setSyncStatus('synced');
          return; // Exit early after successful callback
        }
      }
      
      // Check authentication status for normal app load
      const isAuthenticated = await authService.isAuthenticated();
      if (isAuthenticated) {
        const userData = await authService.getUser();
        setUser(userData);
        
        // Initialize cloud sync for existing user
        setSyncStatus('loading');
        await initializeCloudSync();
        setSyncStatus('synced');
      } else {
        // Only auto-login if we're not processing a callback
        setIsAuthenticating(true);
        await authService.login();
      }
    } catch (error) {
      console.error('Auth initialization failed:', error);
      setIsAuthenticating(false);
      setSettingsLoaded(false);
      setSyncStatus('error');
    } finally {
      setIsLoading(false);
    }
  };

  const initializeCloudSync = async function() {
    try {
     
      
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
      await authService.login();
    } catch (error) {
      console.error('Login failed:', error);
      setIsAuthenticating(false);
    }
  };

  const handleLogout = async () => {
    try {
      await authService.logout();
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
      setSyncStatus('error');
    
    }
  };

  // Loading state - checking authentication or settings
  if (isLoading || (user && !settingsLoaded)) {
    return (
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        height: '100vh' 
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '18px', marginBottom: '10px' }}>Focus Bear</div>
          <div style={{ fontSize: '14px', color: '#666' }}>
            {isLoading ? 'Checking authentication...' : 'Loading settings from cloud...'}
          </div>
          {syncStatus === 'loading' && (
            <div style={{ fontSize: '12px', color: '#999', marginTop: '5px' }}>
              Syncing with Auth0...
            </div>
          )}
        </div>
      </div>
    );
  }

  // Not authenticated - auto-login in progress or failed
  if (!user) {
    return (
      <div style={{ 
        display: 'flex', 
        flexDirection: 'column',
        justifyContent: 'center', 
        alignItems: 'center', 
        height: '100vh',
        padding: '20px'
      }}>
        <div style={{
          textAlign: 'center',
          maxWidth: '400px',
          padding: '40px',
          backgroundColor: '#f8f9fa',
          borderRadius: '10px',
          border: '1px solid #e9ecef'
        }}>
          <h1 style={{ marginBottom: '20px' }}>Focus Bear</h1>
          
          {isAuthenticating ? (
            <div>
              <p style={{ marginBottom: '30px', color: '#666' }}>
                Redirecting to authentication...
              </p>
              <div style={{ 
                padding: '12px 30px',
                backgroundColor: '#6c757d',
                color: 'white',
                borderRadius: '5px',
                fontSize: '16px'
              }}>
                Please wait...
              </div>
            </div>
          ) : (
            <div>
              <p style={{ marginBottom: '20px', color: '#666' }}>
                Sign in to access your settings and sync across devices
              </p>
              <p style={{ marginBottom: '30px', color: '#888', fontSize: '14px' }}>
                Authentication failed or was cancelled. Try again:
              </p>
              <button 
                onClick={handleManualLogin}
                style={{
                  padding: '12px 30px',
                  backgroundColor: '#007bff',
                  color: 'white',
                  border: 'none',
                  borderRadius: '5px',
                  cursor: 'pointer',
                  fontSize: '16px'
                }}
              >
                Sign in with Auth0
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Get sync status display
  const getSyncStatusDisplay = () => {
    switch (syncStatus) {
      case 'loading':
      case 'syncing':
        return { text: ' Syncing...', color: '#007bff' };
      case 'synced':
        return { text: ' Cloud synced', color: '#28a745' };
      case 'error':
        return { text: ' Sync error', color: '#dc3545' };
      default:
        return { text: ' Local only', color: '#6c757d' };
    }
  };

  const statusDisplay = getSyncStatusDisplay();

  // Authenticated - show main app with preferences
  return (
    <div>
      {/* Auth status bar with cloud sync status */}
      <div style={{
        padding: '10px 20px',
        backgroundColor: '#e8f5e8',
        borderBottom: '1px solid #c3e6c3',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <span style={{ fontSize: '14px' }}>
          Signed in as: <strong>{user.email || user.name}</strong>
          <span style={{ 
            marginLeft: '15px', 
            color: statusDisplay.color, 
            fontSize: '12px' 
          }}>
            {statusDisplay.text}
          </span>
        </span>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          {/* Force sync button */}
          <button 
            onClick={handleForceSync}
            disabled={syncStatus === 'syncing' || syncStatus === 'loading'}
            style={{
              padding: '4px 8px',
              backgroundColor: syncStatus === 'syncing' ? '#6c757d' : '#17a2b8',
              color: 'white',
              border: 'none',
              borderRadius: '3px',
              cursor: (syncStatus === 'syncing' || syncStatus === 'loading') ? 'not-allowed' : 'pointer',
              fontSize: '11px',
              opacity: (syncStatus === 'syncing' || syncStatus === 'loading') ? 0.6 : 1
            }}
            title="Force sync all settings from cloud"
          >
            {syncStatus === 'syncing' ? 'Syncing...' : 'Sync'}
          </button>
          
          <button 
            onClick={handleLogout}
            style={{
              padding: '4px 12px',
              backgroundColor: '#dc3545',
              color: 'white',
              border: 'none',
              borderRadius: '3px',
              cursor: 'pointer',
              fontSize: '12px'
            }}
          >
            Sign out
          </button>
        </div>
      </div>
      
      {/* Main app content - directly show preferences */}
      <Preferences user={user} />
    </div>
    
  );
};

export default App;
import { generatePKCEPair, generateState } from './pkce.js';

class NativeAuthService {
  constructor() {
    this.domain = import.meta.env.VITE_AUTH0_DOMAIN;
    this.clientId = import.meta.env.VITE_AUTH0_CLIENT_ID;

    const isDev = import.meta.env.DEV;
    this.redirectUri = isDev
      ? 'http://localhost:5173/callback'
      : 'http://localhost/callback';


    if (!this.domain || !this.clientId) {
      console.error('[NativeAuth] CRITICAL: Missing Auth0 configuration!');
      console.error('  - Domain:', this.domain);
      console.error('  - Client ID:', this.clientId);
      console.error('  - This will cause authentication to fail in packaged app');
    }

    this.accessToken = null;
    this.refreshToken = null;
    this.idToken = null;
    this.user = null;
    this.tokenExpiry = null;

    // The saved sign-in is read from the main process (see below); everything
    // that needs it waits for `ready`.
    this.ready = this.loadTokensFromStorage();
  }

  // The tokens are kept by the main process, encrypted with the desktop's
  // keyring (src/electron/tokenVault.js), not in localStorage where they sat
  // as plain text. A sign-in saved by an older version is moved over once.
  // Without a usable keyring API the old place is kept, so nobody is signed
  // out by the update.
  async loadTokensFromStorage() {
    const vault = window.api?.authTokens;
    try {
      const saved = vault ? await vault.load() : null;
      if (saved) {
        this.applyTokens(saved);
        LEGACY_TOKEN_KEYS.forEach((key) => localStorage.removeItem(key));
        return;
      }
      const legacy = readLegacyTokens();
      if (!legacy) return;
      this.applyTokens(legacy);
      if (vault && (await vault.save(legacy))) LEGACY_TOKEN_KEYS.forEach((key) => localStorage.removeItem(key));
    } catch (error) {
      console.error('Failed to load the saved sign-in:', error?.message || error);
    }
  }

  applyTokens(tokens) {
    this.accessToken = tokens.accessToken || null;
    this.refreshToken = tokens.refreshToken || null;
    this.idToken = tokens.idToken || null;
    this.user = tokens.user || null;
    this.tokenExpiry = tokens.tokenExpiry || null;
  }

  saveTokensToStorage() {
    if (!this.accessToken) return;
    const tokens = {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      idToken: this.idToken,
      user: this.user,
      tokenExpiry: this.tokenExpiry,
    };
    const vault = window.api?.authTokens;
    Promise.resolve(vault ? vault.save(tokens) : false)
      .then((kept) => {
        if (kept) LEGACY_TOKEN_KEYS.forEach((key) => localStorage.removeItem(key));
        else writeLegacyTokens(tokens); // no keyring API: as before
      })
      .catch((error) => console.error('Failed to save the sign-in:', error?.message || error));
  }

  clearTokensFromStorage() {
    LEGACY_TOKEN_KEYS.forEach((key) => localStorage.removeItem(key));
    window.api?.authTokens?.clear?.()?.catch?.(() => {});
  }

  async login() {
    try {
      // One sign-in at a time. Two starts in a row (React StrictMode runs the
      // start-up effect twice in development) opened two sign-in pages; the
      // second overwrote the saved state, so finishing the first page failed
      // with "Signing in didn't finish".
      const startedAt = Date.now();
      if (this.loginStartedAt && startedAt - this.loginStartedAt < 3000) return;
      this.loginStartedAt = startedAt;

      console.log('[NativeAuth] Starting PKCE login flow...');

      const { codeVerifier, codeChallenge, codeChallengeMethod } = await generatePKCEPair();
      const state = generateState();

      localStorage.setItem('pkce_code_verifier', codeVerifier);
      localStorage.setItem('pkce_state', state);

      const authUrl = `https://${this.domain}/authorize?` +
        `response_type=code&` +
        `client_id=${encodeURIComponent(this.clientId)}&` +
        `redirect_uri=${encodeURIComponent(this.redirectUri)}&` +
        `scope=${encodeURIComponent('openid profile email offline_access')}&` +
        `audience=${encodeURIComponent('https://auth.focusbear.io/api/v2/')}&` +
        `state=${state}&` +
        `code_challenge=${codeChallenge}&` +
        `code_challenge_method=${codeChallengeMethod}`;

      if (window.api && window.api.openAuthWindow) {
        window.api.openAuthWindow(authUrl);
      } else {
        console.warn('[NativeAuth] Electron IPC not available, falling back to window.location');
        window.location.href = authUrl;
      }
    } catch (error) {
      console.error('[NativeAuth] Login failed:', error);
      throw error;
    }
  }

  async handleRedirectCallback() {
    try {

      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get('code');
      const state = urlParams.get('state');

      const storedState = localStorage.getItem('pkce_state');
      const codeVerifier = localStorage.getItem('pkce_code_verifier');

      console.log('[NativeAuth] Callback params:', {
        hasCode: !!code,
        hasState: !!state,
        hasStoredState: !!storedState,
        hasCodeVerifier: !!codeVerifier
      });

      if (!state || state !== storedState) {
        throw new Error('State mismatch - possible CSRF attack');
      }

      if (!code) {
        throw new Error('No authorization code received');
      }

      if (!codeVerifier) {
        throw new Error('No code verifier found in session');
      }

      const tokens = await this.exchangeCodeForTokens(code, codeVerifier);

      this.accessToken = tokens.access_token;
      this.refreshToken = tokens.refresh_token;
      this.idToken = tokens.id_token;
      this.tokenExpiry = Date.now() + (tokens.expires_in * 1000);

      await this.loadUserInfo();

      this.saveTokensToStorage();

      localStorage.removeItem('pkce_code_verifier');
      localStorage.removeItem('pkce_state');

      window.history.replaceState({}, document.title, '/');

      console.log('[NativeAuth] Authentication successful');
      return this.user;
    } catch (error) {
      console.error('[NativeAuth] Callback handling failed:', error);
      throw error;
    }
  }

  async exchangeCodeForTokens(code, codeVerifier) {
    const response = await fetch(`https://${this.domain}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: this.clientId,
        code: code,
        code_verifier: codeVerifier,
        redirect_uri: this.redirectUri,
        audience: 'https://auth.focusbear.io/api/v2/'
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Token exchange failed: ${error.error_description || error.error}`);
    }

    return await response.json();
  }

  async loadUserInfo() {
    if (!this.accessToken) {
      throw new Error('No access token available');
    }

    const response = await fetch(`https://${this.domain}/userinfo`, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error('Failed to load user info');
    }

    this.user = await response.json();
    return this.user;
  }

  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }

    try {
      const response = await fetch(`https://${this.domain}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: this.clientId,
          refresh_token: this.refreshToken,
          audience: 'https://auth.focusbear.io/api/v2/'
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Token refresh failed: ${error.error_description || error.error}`);
      }

      const tokens = await response.json();

      this.accessToken = tokens.access_token;
      if (tokens.refresh_token) {
        this.refreshToken = tokens.refresh_token;
      }
      if (tokens.id_token) {
        this.idToken = tokens.id_token;
      }
      this.tokenExpiry = Date.now() + (tokens.expires_in * 1000);

      this.saveTokensToStorage();

      console.log('Token refreshed successfully');
      return this.accessToken;
    } catch (error) {
      console.error('Token refresh failed:', error);
      this.clearTokens();
      throw error;
    }
  }

  async getToken() {
    await this.ready;
    if (!this.accessToken) {
      return null;
    }

    const now = Date.now();
    const bufferTime = 5 * 60 * 1000;

    if (this.tokenExpiry && (now + bufferTime) >= this.tokenExpiry) {
      console.log('Token expiring soon, refreshing...');
      await this.refreshAccessToken();
    }

    return this.accessToken;
  }

  async isAuthenticated() {
    await this.ready;
    if (!this.accessToken) {
      return false;
    }

    try {
      await this.getToken();
      return true;
    } catch {
      return false;
    }
  }

  getUser() {
    return this.user;
  }

  async logout() {
    try {
      this.clearTokens();

      const returnUrl = import.meta.env.DEV
        ? 'http://localhost:5173'
        : 'http://localhost';

      const logoutUrl = `https://${this.domain}/v2/logout?` +
        `client_id=${encodeURIComponent(this.clientId)}&` +
        `returnTo=${encodeURIComponent(returnUrl)}`;

      window.location.href = logoutUrl;
    } catch (error) {
      console.error('[NativeAuth] Logout failed:', error);
      throw error;
    }
  }

  clearTokens() {
    this.accessToken = null;
    this.refreshToken = null;
    this.idToken = null;
    this.user = null;
    this.tokenExpiry = null;
    this.clearTokensFromStorage();
  }
}

const LEGACY_TOKEN_KEYS = ['auth_access_token', 'auth_refresh_token', 'auth_id_token', 'auth_user', 'auth_token_expiry'];

function readLegacyTokens() {
  try {
    const accessToken = localStorage.getItem('auth_access_token');
    if (!accessToken) return null;
    const user = localStorage.getItem('auth_user');
    const expiry = localStorage.getItem('auth_token_expiry');
    return {
      accessToken,
      refreshToken: localStorage.getItem('auth_refresh_token') || null,
      idToken: localStorage.getItem('auth_id_token') || null,
      user: user ? JSON.parse(user) : null,
      tokenExpiry: expiry ? parseInt(expiry, 10) : null,
    };
  } catch {
    return null;
  }
}

function writeLegacyTokens(tokens) {
  try {
    localStorage.setItem('auth_access_token', tokens.accessToken);
    if (tokens.refreshToken) localStorage.setItem('auth_refresh_token', tokens.refreshToken);
    if (tokens.idToken) localStorage.setItem('auth_id_token', tokens.idToken);
    if (tokens.user) localStorage.setItem('auth_user', JSON.stringify(tokens.user));
    if (tokens.tokenExpiry) localStorage.setItem('auth_token_expiry', String(tokens.tokenExpiry));
  } catch (error) {
    console.error('Failed to save the sign-in:', error?.message || error);
  }
}

export const nativeAuthService = new NativeAuthService();

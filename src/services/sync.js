import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import { nativeAuthService } from '../services/nativeAuth.js';
import { addEntry, keywordsOf, normaliseKeyword, removeFromView, sitesOf } from './blocklist.js';
import { SYNC, createSettingsSync } from './settingsSyncCore.js';

const SYNCED_STATES = {
  selectedBlockMode: 'manual',
  selectedBlockMethod: 'hosts',
  selectedBearMode: 'cuddly',
  // Sites and keywords share this list (kArrBlockedUrls); see blocklist.js.
  urlList: ['facebook.com', 'x.com'],
  // "Immediately block super distracting sites" (kImmediatelyBlockDistractingSites)
  immediatelyBlock: false,
  // Usual focus session length in minutes (kPomodoroDurationMinutes)
  pomodoroMinutes: 25,
  // Settings > Breaks: "Enable Breaks" (kUserdefaultsBreaksEnabledFromOnboarding)
  breaksEnabled: true,
  // "Start breaks automatically" (kBreakAutoStartEnabled)
  breakAutoStart: false,
  // Settings > Accessibility: "Prefer reduced motion" (kIsReducedMotion)
  reducedMotion: false,
  // Settings > Focus Sessions: focus music when a session starts
  // (kFocusMusicAutoStartPreference: 'ask' | 'play' | 'off')
  focusMusicAutoStart: 'ask'
};

const API_URL = 'https://api.focusbear.io/user-local-device-settings';

/** GET or PUT the account's device settings; throws when the request can't be made. */
async function request(method, body) {
  const token = await nativeAuthService.getToken();
  if (!token) throw new Error('Not signed in');
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(API_URL, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  let data = null;
  if (response.ok && method === 'GET') data = await response.json().catch(() => null);
  return { status: response.status, data };
}

// The load / save rules (never save before a load, read before each write,
// write only what changed here) are in settingsSyncCore.js.
const auth0Sync = createSettingsSync({
  defaults: SYNCED_STATES,
  request,
  loadLocal: () => window.api?.getLocalSettings?.() ?? null,
  saveLocal: (copy) => window.api?.saveSettings?.(copy),
  getUserId: () => nativeAuthService.getUser()?.sub || '',
  // What the browser extensions block follows the settings in force.
  onApply: (key, value) => {
    if (key === 'urlList') window.api?.exportList?.((Array.isArray(value) ? value : []).join('\n'));
    if (key === 'immediatelyBlock') window.api?.setBlockSettings?.({ immediatelyBlock: Boolean(value) });
  },
});

// Back on the network: load what could not be loaded, send what is waiting.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    auth0Sync.retry();
  });
}

/** 'loading' | 'syncing' | 'synced' | 'pending' | 'offline' (see settingsSyncCore.js). */
export const useSyncStatus = () => useSyncExternalStore(auth0Sync.onStatus, auth0Sync.status);

/** What the sidebar says about each status. */
export const SYNC_TEXT = {
  [SYNC.LOADING]: 'Syncing…',
  [SYNC.SYNCING]: 'Syncing…',
  [SYNC.SYNCED]: 'Synced',
  [SYNC.PENDING]: 'Changes not synced yet',
  [SYNC.OFFLINE]: 'Not synced',
};

// React hooks
export const useSyncedState = (key) => {
  if (!(key in SYNCED_STATES)) {
    throw new Error(`Unknown synced state: ${key}. Available: ${Object.keys(SYNCED_STATES).join(', ')}`);
  }

  const [value, setValue] = useState(SYNCED_STATES[key]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      await auth0Sync.initialize();
      if (cancelled) return;
      setValue(auth0Sync.getValue(key));
      setIsLoading(false);
    };
    init();
    return () => {
      cancelled = true;
    };
  }, [key]);

  useEffect(() => {
    const unsubscribe = auth0Sync.subscribe(key, setValue);
    return unsubscribe;
  }, [key]);

  const setSyncedValue = useCallback(async (newValue) => {
    await auth0Sync.setValue(key, newValue);
  }, [key]);

  return [value, setSyncedValue, isLoading];
};

// Super Distracting Sites: the entries of the block list that are sites.
// `removeUrls` takes positions in `urlArray` (what the page shows).
export const useUrlList = () => {
  const [list, setList, isLoading] = useSyncedState('urlList');
  const urlArray = sitesOf(list);

  const addUrl = useCallback((url) => {
    setList(addEntry(list, url));
  }, [list, setList]);

  const removeUrls = useCallback((indices) => {
    setList(removeFromView(list, sitesOf(list), indices));
  }, [list, setList]);

  return {
    urlArray,
    addUrl,
    removeUrls,
    isLoading
  };
};

// Keyword Blocking: the entries of the same list that are keywords (no dot),
// so they are saved to the account and reach the browser extension like sites do.
export const useKeywordList = () => {
  const [list, setList, isLoading] = useSyncedState('urlList');
  const keywords = keywordsOf(list);

  const addKeyword = useCallback((keyword) => {
    setList(addEntry(list, normaliseKeyword(keyword)));
  }, [list, setList]);

  const removeKeywords = useCallback((indices) => {
    setList(removeFromView(list, keywordsOf(list), indices));
  }, [list, setList]);

  return { keywords, addKeyword, removeKeywords, isLoading };
};

export { auth0Sync };

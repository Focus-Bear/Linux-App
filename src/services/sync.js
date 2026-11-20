import { useState, useEffect, useCallback } from 'react';
import { nativeAuthService } from '../services/nativeAuth.js';
import {
  addEntry,
  fromDeviceSettings,
  keywordsOf,
  normaliseKeyword,
  parseDeviceSettings,
  removeFromView,
  sitesOf,
  toDeviceSettings,
} from './blocklist.js';

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
  breakAutoStart: false
};

const API_BASE_URL = 'https://api.focusbear.io';

class SimpleAuth0Sync {
  constructor() {
    this.subscribers = new Map();
    this.cache = new Map();
    this.isInitialized = false;
    this.saveTimeout = null;
    this.rawAPIData = null;
  }

  async initialize() {
    if (this.isInitialized) return;

    try {
      const savedSettings = await this.loadFromFocusBearAPI();

      if (savedSettings) {
        Object.entries(savedSettings).forEach(([key, value]) => {
          if (key in SYNCED_STATES) {
            this.cache.set(key, value);
          }
        });
        console.log('[Sync] Loaded settings from Focus Bear API:', savedSettings);
      } else {
        Object.entries(SYNCED_STATES).forEach(([key, value]) => {
          this.cache.set(key, value);
        });
        console.log('[Sync] Using default settings');
      }

      this.isInitialized = true;
    } catch (error) {
      console.error('[Sync] Failed to initialize settings:', error);
      Object.entries(SYNCED_STATES).forEach(([key, value]) => {
        this.cache.set(key, value);
      });
      this.isInitialized = true;
    }
  }

  async loadFromFocusBearAPI() {
    try {
      const token = await nativeAuthService.getToken();
      if (!token) {
        console.log('[Sync] No token available for API call');
        return null;
      }

      const API_URL = `${API_BASE_URL}/user-local-device-settings`;

      console.log('[Sync] Fetching settings from API...');
      const response = await fetch(API_URL, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        if (response.status === 404) {
          console.log('[Sync] No settings found on server (404)');
          this.rawAPIData = {};
          return null;
        }
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();
      console.log('[Sync] Raw API response:', data);

      this.rawAPIData = data;

      if (!data.MacOS) {
        console.log('[Sync] No MacOS key in response');
        return null;
      }

      const mappedSettings = fromDeviceSettings(parseDeviceSettings(data.MacOS));

      console.log('[Sync] Mapped settings:', mappedSettings);
      return mappedSettings;

    } catch (error) {
      console.error('[Sync] Failed to load from Focus Bear API:', error);
      return null;
    }
  }

  async saveToFocusBearAPI(settings) {
    try {
      const token = await nativeAuthService.getToken();
      if (!token) {
        console.error('[Sync] No token available for save');
        throw new Error('No token available');
      }

      const API_URL = `${API_BASE_URL}/user-local-device-settings`;

      let baseData = this.rawAPIData || {};

      baseData.MacOS = toDeviceSettings(parseDeviceSettings(baseData.MacOS), settings);

      console.log('[Sync] Saving to API:', baseData);

      const response = await fetch(API_URL, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(baseData)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Sync] API save failed:', response.status, errorText);
        throw new Error(`Failed to save: ${response.status}`);
      }

      console.log('[Sync] Settings saved to Focus Bear API successfully');
      this.rawAPIData = baseData;
      return true;

    } catch (error) {
      console.error('[Sync] Failed to save to Focus Bear API:', error);
      throw error;
    }
  }

  getValue(key) {
    return this.cache.get(key) ?? SYNCED_STATES[key];
  }

  async setValue(key, value) {
    this.cache.set(key, value);

    // Notify subscribers
    const subscribers = this.subscribers.get(key);
    if (subscribers) {
      subscribers.forEach(callback => callback(value));
    }

    if (key === 'urlList') {
      window.api?.exportList?.(value.join('\n'));
    }
    if (key === 'immediatelyBlock') {
      window.api?.setBlockSettings?.({ immediatelyBlock: Boolean(value) });
    }

    // Queue save with debouncing
    this.queueSave();
  }

  queueSave() {
    clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(async () => {
      try {
        const allSettings = {};
        for (const [key, value] of this.cache.entries()) {
          allSettings[key] = value;
        }

        // Save to Focus Bear API
        await this.saveToFocusBearAPI(allSettings);
        
        // Also save locally via IPC for offline access
        await window.api?.saveSettings(allSettings);
        
      } catch (error) {
        console.error('Failed to save settings:', error);
      }
    }, 1000);
  }

  subscribe(key, callback) {
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }
    this.subscribers.get(key).add(callback);

    return () => {
      const subscribers = this.subscribers.get(key);
      if (subscribers) {
        subscribers.delete(callback);
      }
    };
  }

  getAllSettings() {
    const result = {};
    for (const key of Object.keys(SYNCED_STATES)) {
      result[key] = this.getValue(key);
    }
    return result;
  }

  async forceSync() {
    try {
      const settings = await this.loadFromFocusBearAPI();
      if (settings) {
        Object.entries(settings).forEach(([key, value]) => {
          if (key in SYNCED_STATES) {
            this.cache.set(key, value);
            const subscribers = this.subscribers.get(key);
            if (subscribers) {
              subscribers.forEach(callback => callback(value));
            }
          }
        });
        const urlList = this.cache.get('urlList') ?? SYNCED_STATES.urlList;
        window.api?.exportList?.(urlList.join('\n'));
        window.api?.setBlockSettings?.({ immediatelyBlock: Boolean(this.getValue('immediatelyBlock')) });
        console.log('Force sync completed from Focus Bear API');
      }
    } catch (error) {
      console.error('Force sync failed:', error);
      throw error;
    }
  }
}

const auth0Sync = new SimpleAuth0Sync();

// React hooks
export const useSyncedState = (key) => {
  if (!(key in SYNCED_STATES)) {
    throw new Error(`Unknown synced state: ${key}. Available: ${Object.keys(SYNCED_STATES).join(', ')}`);
  }

  const [value, setValue] = useState(SYNCED_STATES[key]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const init = async () => {
      await auth0Sync.initialize();
      setValue(auth0Sync.getValue(key));
      setIsLoading(false);
    };
    init();
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
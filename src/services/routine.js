import { nativeAuthService } from '../services/nativeAuth.js';

const API_BASE_URL = 'https://api.focusbear.io';

class Routine {
    constructor() {
        this.rawAPIData = null;
    }

    async loadRoutineFromFocusBearAPI() {
        try {
            const token = await nativeAuthService.getToken();
            if (!token) {
            console.log('No token available for API call');
            return null;
            }

            const API_URL = `${API_BASE_URL}/activity-library`;

            console.log('[Routine] Fetching User Routine Information from API...');
            const response = await fetch(API_URL, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
            });

            if (!response.ok) {
            if (response.status === 404) {
                console.log('[Routine] No Routines found on server for user(404)');
                return null;
            }
            throw new Error(`API error: ${response.status}`);
            }

            const data = await response.json();
            console.log('[Routine] Raw Routine API response:', data)
            return data;

        } catch (error) {
            console.error('[Routine] Failed to load Routinefrom Focus Bear API:', error);
            return null;
        }
    }
}

const routineSync = new Routine();

export {routineSync};
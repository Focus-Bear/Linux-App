import { app, net, shell } from 'electron';
import { isNewer, pickAsset } from './updateVersion.js';

const GITHUB_REPO = 'Focus-Bear/Linux-App';
const DEFAULT_UPDATE_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 15 * 1000;

let pollTimer = null;
let lastResult = null;

function getUpdateUrl() {
    return process.env.FOCUSBEAR_UPDATE_URL || DEFAULT_UPDATE_URL;
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const request = net.request({ method: 'GET', url, redirect: 'follow' });
        request.setHeader('Accept', 'application/vnd.github+json');
        request.setHeader('User-Agent', `FocusBear/${app.getVersion()}`);

        let body = '';
        request.on('response', (response) => {
            if (response.statusCode < 200 || response.statusCode >= 300) {
                reject(new Error(`HTTP ${response.statusCode}`));
                response.on('data', () => {});
                response.on('end', () => {});
                return;
            }
            response.on('data', (chunk) => { body += chunk.toString('utf8'); });
            response.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (err) { reject(new Error(`Invalid JSON: ${err.message}`)); }
            });
            response.on('error', reject);
        });
        request.on('error', reject);
        request.end();
    });
}

export async function checkForUpdates({ silent = false } = {}) {
    const currentVersion = app.getVersion();
    const url = getUpdateUrl();
    try {
        const release = await fetchJson(url);
        const remoteVersion = release?.tag_name || release?.name;
        if (!remoteVersion) {
            const result = { status: 'error', error: 'Release missing tag_name', currentVersion };
            lastResult = result;
            return result;
        }

        if (isNewer(remoteVersion, currentVersion)) {
            const result = {
                status: 'update-available',
                currentVersion,
                latestVersion: String(remoteVersion).replace(/^v/i, ''),
                releaseNotes: release.body || '',
                downloadUrl: pickAsset(release.assets) || release.html_url || ''
            };
            lastResult = result;
            return result;
        }

        const result = { status: 'up-to-date', currentVersion, latestVersion: String(remoteVersion).replace(/^v/i, '') };
        lastResult = result;
        return result;
    } catch (err) {
        const result = { status: 'error', error: err.message, currentVersion };
        lastResult = result;
        if (!silent) console.warn('[UpdateChecker] Check failed:', err.message);
        return result;
    }
}

export function startUpdateChecker(notify) {
    const tick = async () => {
        const result = await checkForUpdates({ silent: true });
        try { notify?.(result); } catch (err) { console.error('[UpdateChecker] notify failed:', err); }
    };

    setTimeout(tick, INITIAL_DELAY_MS);
    pollTimer = setInterval(tick, CHECK_INTERVAL_MS);
}

export function stopUpdateChecker() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

export function getLastResult() {
    return lastResult;
}

export function openDownloadUrl(url) {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        shell.openExternal(url);
    }
}

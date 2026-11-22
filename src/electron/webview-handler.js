// Enhanced webview-handler.js with optimized management
import { WebContentsView, session } from 'electron';
import { webViewConfigs } from './webview-ids.js';
import { MESSAGE_SHIM, parseWebViewMessage } from './webview-messages.js';
import { reuseDecision, signInOf } from './webviewReuse.js';
import { isDashboardNavigation, isDashboardOrigin, isFocusBearLink } from './security.js';
import { shell } from 'electron';

export { webViewConfigs };

const webViews = new Map();
const webViewInjectionStatus = new Map();
const webViewThemes = new Map();
// id -> { userId, token }: whose sign-in the page was loaded with.
const webViewSignIns = new Map();
let currentActiveWebView = null;

// Matches BackgroundColor in the Windows app's Theme/LightTheme.xaml / DarkTheme.xaml.
const backgroundFor = (theme) => (theme === 'DARK' ? '#282828' : '#ffffff');

export function createWebView(config) {
    const { id, url, metadata, onMessage } = config;

    // A page loaded for another account, or with a token that has since been
    // replaced, is not reused: it would show the previous account's data (or
    // fail with an expired token). It is loaded afresh with today's sign-in.
    if (webViews.has(id) && reuseDecision(webViewSignIns.get(id), metadata) === 'reload') {
        console.log(`[WebView Handler] Sign-in changed since ${id} was loaded; loading it again`);
        destroyWebView(id, config.mainWindow);
    }

    if (webViews.has(id)) {
        console.log(`[WebView Handler] Reusing existing webview: ${id}`);
        const existing = webViews.get(id);
        // Theme switched since this page was loaded: hand the page the new metadata.
        const theme = metadata?.theme;
        const status = webViewInjectionStatus.get(id);
        if (theme && webViewThemes.get(id) !== theme) {
            webViewThemes.set(id, theme);
            existing.setBackgroundColor(backgroundFor(theme));
            if (status?.injected && !status.needsReload) {
                callWindowFunction(existing, id, metadata);
            }
        }
        return existing;
    }

    console.log(`[WebView Handler] Creating new webview: ${id}`);
    webViewSignIns.set(id, signInOf(metadata));

    const background = backgroundFor(metadata?.theme);
    webViewThemes.set(id, metadata?.theme);

    const webView = new WebContentsView({
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            session: session.fromPartition(`persist:dashboard`),
            webSecurity: true,
            allowRunningInsecureContent: false,
            backgroundColor: background
        }
    });

    webView.setBackgroundColor(background);

    webViewInjectionStatus.set(id, {injected: false, needsReload: false});

    webView.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        const headers = details.responseHeaders;
        if (headers['Content-Security-Policy']) {
            delete headers['Content-Security-Policy'];
        }
        if (headers['content-security-policy']) {
            delete headers['content-security-policy'];
        }
        callback({ responseHeaders: headers });
    });

    if (metadata) {
        webView.webContents.on('dom-ready', () => {
            const status = webViewInjectionStatus.get(id);
            if (!status.injected) {
                console.log(`[WebView Handler] DOM ready for ${id}, injecting tokens...`);
                injectAuthTokens(webView, id, metadata);
                webViewInjectionStatus.set(id, {injected: true, needsReload: true});
            } else if (status.needsReload) {
                console.log(`[WebView Handler] Page reloaded with auth, calling window function for ${id}...`);
                callWindowFunction(webView, id, metadata);
                webViewInjectionStatus.set(id, {injected: true, needsReload: false});
            }
        });

        webView.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
            console.error(`[WebView Handler] Failed to load ${id}:`, errorCode, errorDescription);
        });
    }

    webView.webContents.on('dom-ready', () => {
        webView.webContents.executeJavaScript(MESSAGE_SHIM).catch(() => {});
    });

    // The pages hold the account's token: they stay on Focus Bear's own sites
    // (and its sign-in), and links to anything else are not followed inside the app.
    webView.webContents.on('will-navigate', (event, target) => {
        if (!isDashboardNavigation(target)) event.preventDefault();
    });
    webView.webContents.setWindowOpenHandler(({ url: target }) => {
        if (isFocusBearLink(target)) shell.openExternal(target);
        return { action: 'deny' };
    });

    webView.webContents.on('console-message', (event, level, message) => {
        const sent = parseWebViewMessage(message);
        if (sent !== undefined) {
            // Only the dashboard page itself may talk to the app this way, not
            // whatever else ended up in the view.
            if (typeof onMessage === 'function' && isDashboardOrigin(webView.webContents.getURL())) onMessage(id, sent);
            return;
        }
        console.log(`[WebView ${id} Console]:`, message);
    });

    webView.webContents.loadURL(url);

//    webView.webContents.openDevTools({ mode: 'detach' });

    webViews.set(id, webView);
    return webView;
}

async function injectAuthTokens(webView, webViewId, metadata) {
    const auth0ClientId = metadata.client_id;

    if (!auth0ClientId) {
        console.error(`[WebView Handler] CRITICAL: client_id is undefined for ${webViewId}!`);

        return;
    }

    if (!metadata.access_token) {
        console.error(`[WebView Handler] CRITICAL: access_token is missing for ${webViewId}!`);
        return;
    }

    const auth0CacheKey = `@@auth0spajs@@::${auth0ClientId}::default::openid profile email offline_access`;

    console.log(`[WebView Handler] Injecting tokens for ${webViewId}:`);
    console.log(`  - client_id: ${auth0ClientId}`);
    console.log(`  - has access_token: ${!!metadata.access_token}`);
    console.log(`  - has id_token: ${!!metadata.id_token}`);

    const userDataJson = metadata.user ? JSON.stringify(metadata.user) : '{}';
    const idToken = metadata.id_token || metadata.access_token;

    const injectionConfig = getInjectionConfigForWebView(webViewId, metadata);
    const serializedData = JSON.stringify(injectionConfig?.data || {});

    const tokenInjectionScript = `
        (function() {
            console.log('[Focus Bear Native] Injecting authentication tokens');
            console.log('[Focus Bear Native] Client ID: ${auth0ClientId}');

            try {
                Object.keys(localStorage).forEach(key => {
                    if (key.includes('@@auth0spajs@@::undefined')) {
                        console.log('[Focus Bear Native] Removing broken cache entry:', key);
                        localStorage.removeItem(key);
                    }
                });

                localStorage.setItem('focusbear_auth_data', '${serializedData.replace(/'/g, "\\'")}');
                localStorage.setItem('focusbear_access_token', '${metadata.access_token}');
                localStorage.setItem('focusbear_platform', 'linux');

                const auth0Cache = {
                    body: {
                        client_id: '${auth0ClientId}',
                        access_token: '${metadata.access_token}',
                        id_token: '${idToken}',
                        scope: 'openid profile email offline_access',
                        expires_in: 86400,
                        token_type: 'Bearer',
                        decodedToken: {
                            user: ${userDataJson}
                        }
                    },
                    expiresAt: Math.floor(Date.now() / 1000) + 86400
                };

                localStorage.setItem('${auth0CacheKey}', JSON.stringify(auth0Cache));
                console.log('[Focus Bear Native] Tokens injected successfully');
                console.log('[Focus Bear Native] Auth0 cache key:', '${auth0CacheKey}');

            } catch (error) {
                console.error('[Focus Bear Native] Error injecting tokens:', error);
            }
        })();
    `;

    try {
        await webView.webContents.executeJavaScript(tokenInjectionScript);
        console.log(`[WebView Handler] Tokens injected for ${webViewId}, reloading...`);
        await webView.webContents.reload();
    } catch (err) {
        console.error(`[WebView Handler] Failed to inject tokens for ${webViewId}:`, err);
    }
}

async function callWindowFunction(webView, webViewId, metadata) {
    const injectionConfig = getInjectionConfigForWebView(webViewId, metadata);

    if (!injectionConfig) {
        console.log(`[WebView Handler] No window function config for ${webViewId}`);
        return;
    }

    const { functionName, data } = injectionConfig;
    const serializedData = JSON.stringify(data);

    console.log(`[WebView Handler] Calling window function for ${webViewId}: ${functionName}`);

    const functionCallScript = `
        (function() {
            console.log('[Focus Bear Native] Attempting to call window function: ${functionName}');

            const waitForAppLoaded = setInterval(() => {
                if (window['${functionName}']) {
                    console.log('[Focus Bear Native] Found ${functionName}, calling it now...');
                    try {
                        window['${functionName}'](${serializedData});
                        console.log('[Focus Bear Native] Successfully called ${functionName}');
                        clearInterval(waitForAppLoaded);
                    } catch (error) {
                        console.error('[Focus Bear Native] Error calling ${functionName}:', error);
                        clearInterval(waitForAppLoaded);
                    }
                } else {
                    console.log('[Focus Bear Native] Waiting for ${functionName}...');
                }
            }, 100);

            setTimeout(() => {
                clearInterval(waitForAppLoaded);
                console.log('[Focus Bear Native] Timeout - stopped waiting for ${functionName}');
            }, 30000);
        })();
    `;

    try {
        await webView.webContents.executeJavaScript(functionCallScript);
        console.log(`[WebView Handler] Function call script executed for ${webViewId}`);
    } catch (err) {
        console.error(`[WebView Handler] Failed to call function for ${webViewId}:`, err);
    }
}

function getInjectionConfigForWebView(webViewId, metadata) {
    const {
        access_token,
        theme = 'LIGHT',
        lang = 'en',
        font = 'default',
        flags = [],
        tasks = '[]',
        total_duration = 0,
        intention = '',
        brain_dump = '',
        long_term_goals = ['']
    } = metadata;

    // Onboarding's habit ideas page (the same data the Windows app hands it).
    const routineSuggestion = {
        functionName: 'loadMetaDataForRoutineSuggestion',
        data: {
            access_token,
            platform: 'linux',
            lang,
            font,
            theme,
            long_term_goals
        }
    };

    const configs = {
        'edit_habits': {
            functionName: 'loadSettingsData',
            data: {
                access_token,
                platform: 'linux',
                font,
                lang,
                flags,
                theme
            }
        },
        'get_support': {
            functionName: 'loadMetaDataFoGetSupport',
            data: {
                access_token,
                font,
                lang,
                theme
            }
        },
        'courses': {
            functionName: 'loadMetaDataForEnrolledCourses',
            data: {
                access_token,
                font,
                lang,
                theme
            }
        },
        'upgrade-now': {
            functionName: 'loadMetaDataForSubscription',
            data: {
                access_token,
                type: 'linux',
                lang,
                font,
                theme
            }
        },
        'todo-player': {
            functionName: 'loadMetaDataForToDoPlayer',
            data: {
                access_token,
                platform: 'linux',
                tasks,
                total_duration,
                lang,
                font,
                theme,
                intention,
                brain_dump
            }
        },
        'todo-list': {
            functionName: 'loadAccessTokenForToDo',
            data: {
                access_token,
                platform: 'linux',
                lang,
                font,
                theme
            }
        },
        'focus-end': {
            functionName: 'loadTasks',
            data: {
                access_token,
                platform: 'linux',
                tasks,
                total_duration,
                lang,
                theme
            }
        },
        'motivation': {
            functionName: 'loadAccessTokenForInspirationPage',
            data: {
                access_token,
                font,
                lang,
                theme,
                flags,
                motivation_type: 'desktop'
            }
        },
        'stats': {
            functionName: 'loadAccessTokenForStats',
            data: {
                access_token,
                type: 'linux',
                lang,
                font,
                theme
            }
        },
        'survey': {
            functionName: 'loadAccessTokenForSurvey',
            data: {
                access_token,
                platform: 'linux',
                lang
            }
        },
        'routine-suggestion-recommend': routineSuggestion,
        'routine-suggestion-import': routineSuggestion,
        'blocking_schedule': {
            functionName: 'loadSettingsData',
            data: {
                access_token,
                platform: 'linux',
                font,
                lang,
                flags,
                theme
            }
        }
    };

    return configs[webViewId];
}

/** Hands a page its sign-in data again (it asked with 'invoke-js-function'). */
export function resendWebViewMetadata(id, metadata) {
    const webView = webViews.get(id);
    // Not to a page that has left the dashboard: the data includes the access token.
    if (webView && metadata && isDashboardOrigin(webView.webContents.getURL())) callWindowFunction(webView, id, metadata);
}

/** Forgets a page, so the next visit loads it afresh. */
export function destroyWebView(id, mainWindow) {
    const webView = webViews.get(id);
    if (!webView) return;
    if (webView === currentActiveWebView) hideAllWebViews(mainWindow);
    try { webView.webContents.close(); } catch { /* already gone */ }
    webViews.delete(id);
    webViewInjectionStatus.delete(id);
    webViewThemes.delete(id);
    webViewSignIns.delete(id);
}

/** Sign-out: every embedded page goes (they hold the account's token and data). */
export function destroyAllWebViews(mainWindow) {
    for (const id of [...webViews.keys()]) destroyWebView(id, mainWindow);
    currentActiveWebView = null;
}

/** Sign-out: the pages' stored sign-in (localStorage, cookies, caches of the `persist:dashboard` partition). */
export function clearDashboardStorage() {
    const partition = session.fromPartition('persist:dashboard');
    return Promise.all([partition.clearStorageData(), partition.clearCache()]);
}

export function switchToWebView(id, mainWindow, bounds) {
    if (currentActiveWebView && mainWindow && mainWindow.contentView) {
        mainWindow.contentView.removeChildView(currentActiveWebView);
    }

    const webView = webViews.get(id);
    if (webView && mainWindow) {
        mainWindow.contentView.addChildView(webView);
        webView.setBounds(bounds);
        currentActiveWebView = webView;
    }
}

export function hideAllWebViews(mainWindow) {
    if (currentActiveWebView && mainWindow && mainWindow.contentView) {
        mainWindow.contentView.removeChildView(currentActiveWebView);
        currentActiveWebView = null;
    }
}

export function showWebView(id, mainWindow, bounds) {
    switchToWebView(id, mainWindow, bounds);
}

export function hideWebView(id, mainWindow) {
    const webView = webViews.get(id);
    if (webView === currentActiveWebView) {
        hideAllWebViews(mainWindow);
    }
}

export function resizeCurrentWebView(bounds) {
    if (currentActiveWebView) {
        currentActiveWebView.setBounds(bounds);
    }
}

export function getCurrentActiveWebViewId() {
    for (const [id, webView] of webViews.entries()) {
        if (webView === currentActiveWebView) {
            return id;
        }
    }
    return null;
}


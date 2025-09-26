// webview-handler.js - Fixed token injection, keeping working WebContentsView approach
import { WebContentsView, session } from 'electron';

const webViews = new Map();
let currentActiveWebView = null;
const injectionAttempts = new Map();
const loadCounts = new Map();

export function createWebView(config) {
    const { id, url, mainWindow, userSettings } = config;
    
    if (webViews.has(id)) {
        console.log(`WebView ${id} already exists, reusing`);
        return webViews.get(id);
    }

    console.log(`Creating new webview: ${id} with URL: ${url}`);

    const webView = new WebContentsView({
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            session: session.fromPartition(`persist:dashboard`),
            devTools: true  // Enable devtools for debugging
        }
    });

    // Add comprehensive event tracking
    webView.webContents.on('did-start-loading', () => {
        console.log(`WebView ${id} started loading`);
    });

    webView.webContents.on('did-stop-loading', () => {
        console.log(`WebView ${id} stopped loading`);
    });

    webView.webContents.on('did-finish-load', () => {
        const currentCount = (loadCounts.get(id) || 0) + 1;
        loadCounts.set(id, currentCount);
        
        console.log(`WebView ${id} finished loading (attempt #${currentCount})`);
        console.log(`WebView ${id} current URL: ${webView.webContents.getURL()}`);
        
        // Enable F12 devtools for this webview
        webView.webContents.on('before-input-event', (event, input) => {
            if (input.key === 'F12') {
                webView.webContents.openDevTools();
            }
        });
        
        // Only inject once per webview instance
        if (!injectionAttempts.get(id)) {
            if (userSettings && userSettings.accessToken) {
                console.log(`Injecting token for ${id}`);
                injectTokensForWebView(webView, id, userSettings);
                injectionAttempts.set(id, true);
            } else {
                console.log(`No access token available for ${id}`);
            }
        } else {
            console.log(`Skipping re-injection for ${id} - already attempted`);
        }
    });

    webView.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
        console.error(`WebView ${id} failed to load:`, {
            errorCode,
            errorDescription,
            validatedURL
        });
    });

    // Track navigation for debugging
    webView.webContents.on('will-navigate', (event, navigationUrl) => {
        console.log(`WebView ${id} navigating to: ${navigationUrl}`);
    });

    webView.webContents.on('did-navigate', (event, navigationUrl) => {
        console.log(`WebView ${id} navigated to: ${navigationUrl}`);
    });

    console.log(`Loading URL for ${id}: ${url}`);
    webView.webContents.loadURL(url);
    webViews.set(id, webView);
    return webView;
}

function injectTokensForWebView(webView, webViewId, userSettings) {
    console.log(`Token injection attempted for ${webViewId}`);
    console.log('User settings for injection:', {
        hasUser: !!userSettings.user,
        hasToken: !!userSettings.accessToken,
        tokenLength: userSettings.accessToken?.length || 0
    });

    const configs = {
        'edit_habits': {
            func: 'loadMetaDataForHabits',
            data: {
                access_token: userSettings.accessToken,
                platform: 'electron',
                font: userSettings.selectedFont || 'Arial',
                lang: userSettings.languageCode || 'en',
                bearMode: userSettings.isGeekMode ? 'geek-mode' : 'simple-mode',
                theme: userSettings.theme === 'Light' ? 'LIGHT' : 'DARK'
            }
        },
        'get_support': {
            func: 'loadMetaDataFoGetSupport',
            data: {
                access_token: userSettings.accessToken,
                font: userSettings.selectedFont || 'Arial',
                lang: userSettings.languageCode || 'en',
                theme: userSettings.theme === 'Light' ? 'LIGHT' : 'DARK'
            }
        },
        'motivation': {
            func: 'loadAccessTokenForInspirationPage',
            data: {
                access_token: userSettings.accessToken,
                font: userSettings.selectedFont || 'Arial',
                lang: userSettings.languageCode || 'en',
                theme: userSettings.theme === 'Light' ? 'LIGHT' : 'DARK',
                flags: ['migrate-stats-to-motivational-summary'],
                motivation_type: 'desktop'
            }
        },
        'blocking_schedule': {
            func: 'loadAccessTokenForBlockingSchedule',
            data: {
                access_token: userSettings.accessToken,
                platform: 'electron',
                lang: userSettings.languageCode || 'en',
                font: userSettings.selectedFont || 'Arial',
                theme: userSettings.theme === 'Light' ? 'LIGHT' : 'DARK'
            }
        }
    };

    const config = configs[webViewId];
    if (!config) {
        console.log(`No injection config for ${webViewId}`);
        return;
    }

    const dataString = JSON.stringify(config.data);
    const maxAttempts = 100;
    const script = `
        (function() {
            // Function to send logs back to main process
            function logToMain(message, data) {
                console.log('[WEBVIEW ${webViewId}] ' + message, data || '');
            }
            
            logToMain('=== TOKEN INJECTION START ===');
            logToMain('Webview ID: ${webViewId}');
            logToMain('Function: ${config.func}');
            logToMain('Has token: ${!!userSettings.accessToken}');
            logToMain('Token length: ${userSettings.accessToken?.length || 0}');
            
            var attempts = 0;
            var maxAttempts = ${maxAttempts};
            
            var waitForAppLoaded = setInterval(function() {
                attempts++;
                logToMain('Polling attempt: ' + attempts + '/' + maxAttempts);
                
                if (window.${config.func}) {
                    logToMain('Found ${config.func}, calling with data');
                    try {
                        window.${config.func}(${dataString});
                        logToMain('${config.func} called successfully');
                        logToMain('=== TOKEN INJECTION COMPLETE ===');
                    } catch (error) {
                        logToMain('Error calling ${config.func}: ' + error.message);
                    }
                    clearInterval(waitForAppLoaded);
                } else {
                    logToMain('Function ${config.func} not found on window');
                    logToMain('Available functions on window: ' + Object.keys(window).filter(k => typeof window[k] === 'function').slice(0, 10).join(', '));
                    
                    if (attempts >= maxAttempts) {
                        logToMain('Max attempts reached, trying alternative injection');
                        
                        try {
                            window.focusBearAuth = ${dataString};
                            logToMain('Auth data set on window.focusBearAuth');
                            
                            if (window.checkAuthStatus) {
                                logToMain('Found checkAuthStatus, calling it');
                                window.checkAuthStatus();
                            } else {
                                logToMain('checkAuthStatus not found');
                            }
                            
                            logToMain('=== TOKEN INJECTION END (ALTERNATIVE) ===');
                        } catch (error) {
                            logToMain('Alternative injection failed: ' + error.message);
                        }
                        
                        clearInterval(waitForAppLoaded);
                    }
                }
            }, 100);
        })();
    `;

    webView.webContents.executeJavaScript(script)
        .then(() => console.log(`Token injection script executed for ${webViewId}`))
        .catch(error => console.error(`Token injection failed for ${webViewId}:`, error));
}

export function switchToWebView(id, mainWindow, bounds, userSettings) {
    console.log(`Switching to webview: ${id}`);
    
    if (currentActiveWebView && mainWindow && mainWindow.contentView) {
        mainWindow.contentView.removeChildView(currentActiveWebView);
    }

    // Reset injection tracking when switching to webview
    injectionAttempts.delete(id);
    loadCounts.delete(id);

    let webView = webViews.get(id);
    if (!webView && mainWindow) {
        webView = createWebView({ 
            id, 
            url: webViewConfigs[id].url, 
            mainWindow,
            userSettings 
        });
    }
    
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

export const webViewConfigs = {
    'edit_habits': {
        id: 'edit_habits',
        url: 'https://dashboard.focusbear.io'
    },
    'get_support': {
        id: 'get_support', 
        url: 'https://dashboard.focusbear.io/webview/get-support'
    },
    'motivation': {
        id: 'motivation',
        url: 'https://dashboard.focusbear.io/webview/motivational-summary'
    },
    'blocking_schedule': {
        id: 'blocking_schedule',
        url: 'https://dashboard.focusbear.io'

    }
};
// webview-handler.js - Token injection only, no mock content
import { WebContentsView, session } from 'electron';

const webViews = new Map();
let currentActiveWebView = null;

export function createWebView(config) {
    const { id, url, mainWindow, userSettings } = config;
    
    if (webViews.has(id)) {
        return webViews.get(id);
    }

    let hasInjectedToken = false;

    const webView = new WebContentsView({
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            session: session.fromPartition(`persist:dashboard`)
        }
    });

    webView.webContents.on('did-finish-load', () => {
        console.log(`WebView ${id} finished loading`);
        
        if (userSettings && userSettings.accessToken && !hasInjectedToken) {
            console.log(`Injecting token for ${id}`);
            injectTokensForWebView(webView, id, userSettings);
            hasInjectedToken = true;
        } else {
            console.log(`No access token available for ${id}`);
        }
    });

    webView.webContents.loadURL(url);
    webViews.set(id, webView);
    return webView;
}

function injectTokensForWebView(webView, webViewId, userSettings) {
    const configs = {
        'edit_habits': {
            func: 'loadSettingsData',
            data: {
                access_token: userSettings.accessToken,
                platform: 'electron',
                font: userSettings.selectedFont || 'Arial',
                lang: userSettings.languageCode || 'en',
                flags: [userSettings.isGeekMode ? 'geek-mode' : 'simple-mode'],
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
    const script = `
        const waitForAppLoaded = setInterval(() => {
            if (window.${config.func}) {
                ${config.func}(${dataString});
                clearInterval(waitForAppLoaded);
                console.log('Token injected for ${webViewId}');
            }
        }, 100);
    `;

    webView.webContents.executeJavaScript(script)
        .then(() => console.log(`Token injection attempted for ${webViewId}`))
        .catch(error => console.error(`Token injection failed for ${webViewId}:`, error));
}

export function switchToWebView(id, mainWindow, bounds, userSettings) {
    if (currentActiveWebView && mainWindow && mainWindow.contentView) {
        mainWindow.contentView.removeChildView(currentActiveWebView);
    }

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
        url: 'https://settings.focusbear.io'
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
        url: 'https://dashboard.focusbear.io/webview/blocking-schedule' 
    }
};
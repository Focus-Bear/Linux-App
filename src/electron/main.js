import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { app, BrowserWindow, ipcMain, screen, session, shell } from "electron";
import {createTray, getTrayWindow} from "./tray-handler.js"
import { createWebView, switchToWebView, hideAllWebViews, webViewConfigs, resizeCurrentWebView, getCurrentActiveWebViewId, resendWebViewMetadata, destroyWebView } from './webview-handler.js';
import { exec, execFile, spawn, execSync } from 'child_process';
import { promisify } from 'util';
import "./Blocker.js"
import { setBroadcastFunction } from './Blocker.js';
import { focusState } from './focusState.js';
import { mergeLocalSettings } from './localSettings.js';
import { isTrayPage, normaliseTheme } from './trayModel.js';
import { checkForUpdates, getLastResult, openDownloadUrl, startUpdateChecker } from './updateChecker.js';
import {
  adjustSession,
  createSession,
  endSession,
  isActive as isSessionActive,
  pauseSession,
  remainingMs,
  restoreSession,
  resumeSession, hasStopFriction } from './focusSessionModel.js';
import { ALLOW_ONLY_RENEW_MS, DEFAULT_BLOCK_SETTINGS, blockSettingsMessage, normaliseBlockSettings } from './blockSettings.js';
import {
  WARNING_SECONDS,
  breaksActive,
  holdReason,
  nextBreakAt,
  normaliseBreakConfig,
  normalisePostpone,
  rescheduleAt,
} from './breakModel.js';
import SimpleUrlGrabber from './simpleUrlGrabber.js';
import dotenv from 'dotenv';
import { promises as fs } from 'fs';
import { createServer } from 'net';
import { unlink } from 'fs/promises';

dotenv.config();

const execFileAsync = promisify(execFile);

const SOCKET_PATH = '/tmp/focusbear.sock';
let socketServer = null;
const socketClients = new Map();       // socket → {browser: string|null, lastPing: number}
let currentBlocklist = [];        // what the extensions block now: always-blocked + the list in force
let alwaysBlocklist = [];         // the account's Super Distracting Sites and keywords
// The block list in force (a focus session's or a blocking schedule's), from
// the window (src/ui/useBlocking.js): extra entries to block and, for an
// allow list, the only sites that may be opened.
let modeBlocking = { blocklist: [], allowOnly: null };
let currentWhitelist = [];
let currentBlockSettings = { ...DEFAULT_BLOCK_SETTINGS };
let warningWindow = null;
const connectedBrowsers = new Set();
const browserLastConnected = new Map();
let pingMonitorActive = false;
let extensionWarningTimer = null;
let extensionWarningActive = false;
let warningBrowserId = null;

let selectedBrowsers = ['firefox']; // persisted from setup; updated via applySettings

const BROWSER_PGREP_PATTERNS = {
  firefox:  ['firefox'],
  chrome:   ['google-chrome'],
  chromium: ['chromium'],
  brave:    ['brave'],
  opera:    ['opera'],
};

const BROWSER_KILL_TARGETS = {
  firefox:  ['firefox', 'firefox-bin', 'firefox-esr'],
  chrome:   ['google-chrome'],
  chromium: ['chromium', 'chromium-browser'],
  brave:    ['brave', 'brave-browser'],
  opera:    ['opera'],
};

function getWhitelistPath() {
  return join(app.getPath('userData'), 'whitelist.json');
}

async function loadWhitelistFromDisk() {
  try {
    const data = await fs.readFile(getWhitelistPath(), 'utf8');
    const entries = JSON.parse(data);
    currentWhitelist = entries.filter(e => e.expiresAt > Date.now());
    console.log(`[Whitelist] Loaded ${currentWhitelist.length} active entries from disk`);
  } catch (error) {
    currentWhitelist = [];
  }
}

async function saveWhitelistToDisk(entries) {
  try {
    await fs.writeFile(getWhitelistPath(), JSON.stringify(entries, null, 2));
  } catch (error) {
    console.error('[Whitelist] Failed to save:', error.message);
  }
}

async function startSocketServer() {
  try {
    await unlink(SOCKET_PATH);
  } catch { /* stale socket, ignore */ }

  socketServer = createServer((socket) => {
    console.log('[Socket] Native host connected');
    socketClients.set(socket, { browser: null, lastPing: Date.now() });

    // Push current blocklist immediately so new connections don't wait for a GET_BLOCKLIST
    if (currentBlocklist.length > 0) {
      socket.write(JSON.stringify({
        type: 'BLOCKLIST_UPDATE',
        data: currentBlocklist,
        timestamp: Date.now()
      }) + '\n');
    }

    // Push blocking options ("Immediately block super distracting sites")
    socket.write(blockSettingsMessage(currentBlockSettings));

    // Push whitelist so extension can restore it after reinstall
    socket.write(JSON.stringify({
      type: 'WHITELIST_UPDATE',
      data: currentWhitelist.filter(e => e.expiresAt > Date.now()),
      timestamp: Date.now()
    }) + '\n');

    socket.on('data', (data) => {
      const lines = data.toString().split('\n').filter(line => line.trim());

      lines.forEach(line => {
        try {
          const message = JSON.parse(line);
          const browserTag = message.browser ? ` (${message.browser})` : '';
          console.log(`[Socket] Received from native host: ${message.type}${browserTag}`);

          if (socketClients.has(socket)) socketClients.get(socket).lastPing = Date.now();

          if (message.type === 'NATIVE_HOST_CONNECTED') {
            if (message.browser) {
              // Evict stale socket for this browser — old host may not have cleaned up
              for (const [s, c] of socketClients) {
                if (s !== socket && c.browser === message.browser) {
                  console.log(`[Socket] Evicting stale ${message.browser} socket (new host connected)`);
                  s.destroy();
                  socketClients.delete(s);
                }
              }
              if (socketClients.has(socket)) socketClients.get(socket).browser = message.browser;
              browserLastConnected.set(message.browser, Date.now());
              console.log(`[Socket] Host identified as ${message.browser} on connect`);
            }
          } else if (message.type === 'PING') {
            const browser = message.browser || 'unknown';
            if (socketClients.has(socket)) socketClients.get(socket).browser = browser;
            browserLastConnected.set(browser, Date.now());
            if (!connectedBrowsers.has(browser)) {
              connectedBrowsers.add(browser);
              if (mainWindow) mainWindow.webContents.send('extension-connected', browser);
            }
            if (!warningBrowserId || warningBrowserId === browser) cancelExtensionWarning();
          } else if (message.type === 'GET_BLOCKLIST') {
            console.log(`[Socket] Sending blocklist: ${currentBlocklist.length} entries`);
            socket.write(JSON.stringify({
              type: 'BLOCKLIST_RESPONSE',
              data: currentBlocklist,
              timestamp: Date.now()
            }) + '\n');
          } else if (message.type === 'GET_WHITELIST') {
            const active = currentWhitelist.filter(e => e.expiresAt > Date.now());
            console.log(`[Socket] Sending whitelist: ${active.length} entries`);
            socket.write(JSON.stringify({
              type: 'WHITELIST_RESPONSE',
              data: active,
              timestamp: Date.now()
            }) + '\n');
          } else if (message.type === 'WHITELIST_UPDATE') {
            currentWhitelist = message.data.filter(e => e.expiresAt > Date.now());
            console.log(`[Socket] Whitelist updated: ${currentWhitelist.length} entries`);
            saveWhitelistToDisk(currentWhitelist);
          }
        } catch (error) {
          console.error('[Socket] Error parsing message:', error);
        }
      });
    });

    socket.on('close', () => {
      console.log('[Socket] Native host disconnected');
      const client = socketClients.get(socket);
      socketClients.delete(socket);
      const browser = client?.browser;
      if (browser && ![...socketClients.values()].some(c => c.browser === browser)) {
        connectedBrowsers.delete(browser);
      }
      // Chrome: SW suspension is normal — alarm reconnects within 60s. 70s grace avoids false positives.
      // Firefox: MV2 background is persistent, so disconnect means crash/disable. 5s grace.
      if (pingMonitorActive && browser) {
        const closedBrowser = browser;
        const gracePeriod = closedBrowser === 'firefox' ? 5000 : 70000;
        setTimeout(async () => {
          // Cancel if browser already reconnected during grace period
          if ([...socketClients.values()].some(c => c.browser === closedBrowser)) return;
          if (!extensionWarningActive && await isBrowserRunning(closedBrowser)) {
            console.log(`[PingMonitor] Socket closed, ${closedBrowser} still running after grace — showing warning`);
            showExtensionWarning(closedBrowser);
          }
        }, gracePeriod);
        // If browser unknown (PING never received before disconnect), browserScan handles it
      }
    });

    socket.on('error', (error) => {
      console.error('[Socket] Client error:', error.message);
    });
  });

  socketServer.listen(SOCKET_PATH, () => {
    console.log(`[Socket] Server listening on ${SOCKET_PATH}`);
  });

  socketServer.on('error', (error) => {
    console.error('[Socket] Server error:', error);
  });
}

function broadcastBlocklistUpdate(blocklist) {
  alwaysBlocklist = Array.isArray(blocklist) ? blocklist : [];
  currentBlocklist = [...new Set([...alwaysBlocklist, ...modeBlocking.blocklist])];
  blocklist = currentBlocklist;

  const message = JSON.stringify({
    type: 'BLOCKLIST_UPDATE',
    data: blocklist,
    timestamp: Date.now()
  }) + '\n';

  console.log(`[Socket] Broadcasting blocklist update to ${socketClients.size} clients`);

  for (const socket of socketClients.keys()) {
    try {
      socket.write(message);
    } catch (error) {
      console.error('[Socket] Error broadcasting to client:', error);
    }
  }
}

function broadcastBlockSettings(settings) {
  // allowOnly comes from the block list in force, not from the saved settings.
  currentBlockSettings = normaliseBlockSettings({ ...settings, allowOnly: modeBlocking.allowOnly });
  const message = blockSettingsMessage(currentBlockSettings);
  console.log(`[Socket] Broadcasting block settings to ${socketClients.size} clients:`, currentBlockSettings);
  for (const socket of socketClients.keys()) {
    try {
      socket.write(message);
    } catch (error) {
      console.error('[Socket] Error broadcasting block settings:', error);
    }
  }
}

// browserId: check only that browser. Omit to check all selected browsers.
async function isBrowserRunning(browserId) {
  const ids = browserId ? [browserId] : selectedBrowsers;
  for (const id of ids) {
    for (const p of (BROWSER_PGREP_PATTERNS[id] || [])) {
      try {
        await execFileAsync('pgrep', ['-f', p]);
        return true;
      } catch { /* no match */ }
    }
  }
  return false;
}

async function killBrowsers(browserId) {
  const targets = BROWSER_KILL_TARGETS[browserId] || [];
  console.log(`[PingMonitor] Killing ${browserId} (${targets.join(', ')})`);
  await Promise.all(targets.map(name => execFileAsync('pkill', ['-x', name]).catch(() => {})));
}

function destroyWarningWindow() {
  if (warningWindow) {
    const win = warningWindow;
    warningWindow = null;
    win.destroy();
  }
}

function cancelExtensionWarning() {
  if (extensionWarningTimer) {
    clearTimeout(extensionWarningTimer);
    extensionWarningTimer = null;
  }
  extensionWarningActive = false;
  destroyWarningWindow();
}

function showExtensionWarning(browserId) {
  if (extensionWarningActive) return;
  extensionWarningActive = true;
  warningBrowserId = browserId || null;
  console.log(`[PingMonitor] Showing extension disconnected warning (browser: ${browserId})`);

  const timerBrowserId = browserId || null;
  extensionWarningTimer = setTimeout(async () => {
    extensionWarningActive = false;
    extensionWarningTimer = null;
    destroyWarningWindow();
    await killBrowsers(timerBrowserId);
  }, 30000);

  warningWindow = new BrowserWindow({
    width: 600,
    height: 400,
    resizable: false,
    alwaysOnTop: true,
    title: 'Focus Bear — Extension Warning',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  const BROWSER_NAMES = { firefox: 'Firefox', chrome: 'Chrome', chromium: 'Chromium', brave: 'Brave', opera: 'Opera' };
  const browserName = BROWSER_NAMES[browserId] || 'your browser';
  warningWindow.loadFile(join(__dirname, 'extension-warning.html'), { query: { browser: browserName } });
  warningWindow.webContents.once('did-finish-load', () => {
    if (!warningWindow) return;
    warningWindow.webContents.executeJavaScript('document.querySelector(".card").getBoundingClientRect().height + 48')
      .then(h => {
        if (!warningWindow) return;
        const [w] = warningWindow.getContentSize();
        warningWindow.setContentSize(w, h);
      })
      .catch(() => {});
  });
  warningWindow.on('closed', () => { warningWindow = null; }); // handles manual X click
}

function startPingMonitor() {
  if (pingMonitorActive) return;
  pingMonitorActive = true;

  // Firefox MV2 background is persistent — detect hung connections via ping silence.
  // Chrome MV3 SWs sleep and reconnect via alarm; socket-close grace handles disconnect detection.
  setInterval(async () => {
    if (extensionWarningActive) return;
    const now = Date.now();
    for (const [, client] of socketClients) {
      if (client.browser !== 'firefox') continue;
      if (now - client.lastPing > 20000 && await isBrowserRunning('firefox')) {
        showExtensionWarning('firefox');
        break;
      }
    }
  }, 5000);

  // Detect browser running without extension ever connecting (startup / disabled-before-launch).
  // Firefox: 5s grace (persistent background connects immediately).
  // Chrome: 70s grace (alarm fires within 60s if extension enabled, then reconnects).
  const BROWSER_SCAN_GRACE = { firefox: 5000 };
  const DEFAULT_SCAN_GRACE = 70000;

  const browserScan = async () => {
    if (extensionWarningActive) return;
    const now = Date.now();
    for (const browserId of selectedBrowsers) {
      if (connectedBrowsers.has(browserId)) continue;
      if (!await isBrowserRunning(browserId)) continue;
      const grace = BROWSER_SCAN_GRACE[browserId] ?? DEFAULT_SCAN_GRACE;
      const lastSeen = browserLastConnected.get(browserId) ?? 0;
      if (now - lastSeen < grace) continue;
      console.log(`[BrowserScan] ${browserId} running without extension for >${grace}ms — showing warning`);
      showExtensionWarning(browserId);
      break;
    }
  };

  setTimeout(browserScan, 20000); // initial check — Firefox connects immediately; Chrome needs ~60s for alarm
  setInterval(browserScan, 90000);
}

// Install native messaging host on startup — runs in-process, no subprocess needed.
// Files are copied into ~/.local/share/focusbear/ so snap Firefox's sandbox can reach them.
const CHROME_EXTENSION_ID = 'dhjmacpmdnfhpghleebnngdhikmffcem';

async function installNativeMessaging() {
  try {
    const nativeSrcDir = app.isPackaged
      ? join(process.resourcesPath, 'native-messaging')
      : join(__dirname, '..', 'native-messaging');
    const extensionSrcDir = app.isPackaged
      ? join(process.resourcesPath, 'extension')
      : join(__dirname, '..', 'extension');
    const chromeExtSrcDir = app.isPackaged
      ? join(process.resourcesPath, 'extension-chrome')
      : join(__dirname, '..', 'extension-chrome');

    const localNativeDir = join(homedir(), '.local', 'share', 'focusbear', 'native-messaging');
    await fs.mkdir(localNativeDir, { recursive: true });
    await fs.copyFile(join(nativeSrcDir, 'host.js'),     join(localNativeDir, 'host.js'));
    await fs.copyFile(join(nativeSrcDir, 'package.json'), join(localNativeDir, 'package.json'));

    const localExtDir = join(homedir(), '.local', 'share', 'focusbear', 'extension');
    await fs.mkdir(localExtDir, { recursive: true });
    for (const f of await fs.readdir(extensionSrcDir)) {
      await fs.copyFile(join(extensionSrcDir, f), join(localExtDir, f)).catch(() => {});
    }

    // Wrapper at ~/.local/bin points to the home-dir copy of host.js
    const wrapperDir = join(homedir(), '.local', 'bin');
    const wrapperPath = join(wrapperDir, 'focusbear-native-host');
    await fs.mkdir(wrapperDir, { recursive: true });
    await fs.writeFile(wrapperPath, `#!/bin/sh\nexec node "${join(localNativeDir, 'host.js')}" "$@"\n`);
    await fs.chmod(wrapperPath, 0o755);

    // Write Firefox manifest to all known locations (regular + snap)
    const firefoxManifest = JSON.stringify({
      name: 'com.focusbear.native_host',
      description: 'Focus Bear Native Messaging Host',
      path: wrapperPath,
      type: 'stdio',
      allowed_extensions: ['focusbear@focusbear.io']
    }, null, 2);
    for (const dir of [
      join(homedir(), '.mozilla', 'native-messaging-hosts'),
      join(homedir(), 'snap', 'firefox', 'common', '.mozilla', 'native-messaging-hosts'),
    ]) {
      await fs.mkdir(dir, { recursive: true }).catch(() => {});
      await fs.writeFile(join(dir, 'com.focusbear.native_host.json'), firefoxManifest).catch(() => {});
    }

    // Write Chrome/Chromium native messaging manifests
    const chromeManifest = JSON.stringify({
      name: 'com.focusbear.native_host',
      description: 'Focus Bear Native Messaging Host',
      path: wrapperPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`]
    }, null, 2);
    for (const dir of [
      join(homedir(), '.config', 'google-chrome', 'NativeMessagingHosts'),
      join(homedir(), '.config', 'google-chrome-beta', 'NativeMessagingHosts'),
      join(homedir(), '.config', 'google-chrome-unstable', 'NativeMessagingHosts'),
      join(homedir(), '.config', 'chromium', 'NativeMessagingHosts'),
      join(homedir(), '.config', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
      join(homedir(), '.config', 'opera', 'NativeMessagingHosts'),
    ]) {
      await fs.mkdir(dir, { recursive: true }).catch(() => {});
      await fs.writeFile(join(dir, 'com.focusbear.native_host.json'), chromeManifest).catch(() => {});
    }

    // Copy Chrome extension files and pack as .zip
    const localChromeExtDir = join(homedir(), '.local', 'share', 'focusbear', 'extension-chrome');
    await fs.mkdir(localChromeExtDir, { recursive: true });
    for (const f of await fs.readdir(chromeExtSrcDir).catch(() => [])) {
      await fs.copyFile(join(chromeExtSrcDir, f), join(localChromeExtDir, f)).catch(() => {});
    }
    const chromeZipPath = join(homedir(), '.local', 'share', 'focusbear', 'focusbear-extension-chrome.zip');
    try {
      try { await fs.unlink(chromeZipPath); } catch {}
      execSync(`cd "${localChromeExtDir}" && zip -r "${chromeZipPath}" .`, { stdio: 'pipe' });
      console.log('[Native Messaging] Chrome extension .zip ready at', chromeZipPath);
      console.log('[Native Messaging] Chrome: chrome://extensions → Load unpacked → select', localChromeExtDir);
    } catch (zipErr) {
      console.warn('[Native Messaging] Could not create Chrome .zip:', zipErr.message);
    }

    // Pack Firefox extension as .xpi (zip) so snap Firefox's portal grants access to a single file
    // containing all extension scripts — selecting manifest.json alone only mounts that one file.
    const xpiPath = join(homedir(), '.local', 'share', 'focusbear', 'focusbear-extension.xpi');
    try {
      try { await fs.unlink(xpiPath); } catch {}
      execSync(`cd "${localExtDir}" && zip -r "${xpiPath}" .`, { stdio: 'pipe' });
      console.log('[Native Messaging] Host installed at', wrapperPath);
      console.log('[Native Messaging] Extension .xpi ready at', xpiPath);
      console.log('[Native Messaging] Firefox: about:debugging → Load Temporary Add-on → select', xpiPath);
    } catch (zipErr) {
      console.warn('[Native Messaging] Could not create .xpi:', zipErr.message);
      console.log('[Native Messaging] Host installed at', wrapperPath);
      console.log('[Native Messaging] Load extension from:', join(localExtDir, 'manifest.json'));
    }
  } catch (error) {
    console.error('[Native Messaging] Setup failed:', error.message);
  }
}

console.log('[Main Process] Starting Focus Bear...');
console.log('[Main Process] App packaged:', app.isPackaged);
console.log('[Main Process] App path:', app.getAppPath());
console.log('[Main Process] User data path:', app.getPath('userData'));
console.log('[Main Process] Node env:', process.env.NODE_ENV);

let tray = null
let focusBearView = null
let mainWindow = null;
let authWindow = null;
let exitflag = false;
let pendingProtocolUrl = null;
const urlGrabber = new SimpleUrlGrabber();

// Unified focus session state
let isFocusActive = false;

function getWebviewContainerBounds() {
    const bounds = mainWindow.getBounds();
    const padding = 20;
    const topOffset = 140;

    return {
        x: padding,
        y: topOffset,
        width: bounds.width - (padding * 2),
        height: bounds.height - topOffset - padding
    };
}

//SINGLE INSTANCING FOR Auth0
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.on("ready", function(){
    // Start socket server for native messaging
    startSocketServer();

    // Set up broadcast function for Blocker.js
    setBroadcastFunction(broadcastBlocklistUpdate);

    // Load persisted whitelist before socket server accepts connections
    loadWhitelistFromDisk();

    // Install native messaging host
    installNativeMessaging();

    // Only monitor extension liveness after setup is complete.
    // Checked from disk so the decision is made before the renderer loads.
    fs.readFile(getSettingsPath(), 'utf8')
      .then(data => {
        const s = JSON.parse(data);
        if (s.selectedBrowsers) selectedBrowsers = s.selectedBrowsers;
        // Last known choice, so it applies before the renderer has signed in and synced.
        if (typeof s.immediatelyBlock === 'boolean') broadcastBlockSettings(s);
        if (s.setupComplete) startPingMonitor();
      })
      .catch(() => {}); // first run — no settings file yet, skip monitor

    mainWindow = new BrowserWindow({
        autoHideMenuBar: true,
        height: 850,
        width: 1000,
        show: true,
        webviewTag: true,
        webPreferences: {
            preload: join(app.getAppPath(), "/src/electron/preload.js"),
            webSecurity: false,
        },
        devTools: false,
    });
    tray = createTray(mainWindow)

    // Look for a newer release shortly after launch and every 6 hours. The
    // renderer shows a banner (UpdateNotification.jsx) and Settings > About.
    startUpdateChecker((result) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', result);
    });

    // A focus session survives an app restart (and ends if its time ran out meanwhile).
    fs.readFile(getFocusSessionPath(), 'utf8')
      .then(data => {
        const restored = restoreSession(JSON.parse(data), Date.now());
        if (restored) setFocusSession(restored);
      })
      .catch(() => {}); // no saved session

    const isDev = !app.isPackaged;

    if (!isDev) {
        const { webRequest } = mainWindow.webContents.session;
        const filter = { urls: ['http://localhost/callback*'] };

        webRequest.onBeforeRequest(filter, async (details, callback) => {
            console.log('[Auth] Intercepted callback on main window:', details.url);

            pendingProtocolUrl = details.url;

            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.once('did-finish-load', () => {
                    console.log('[Auth] Sending callback to renderer after reload:', pendingProtocolUrl);
                    if (pendingProtocolUrl) {
                        mainWindow.webContents.send('auth-protocol-callback', pendingProtocolUrl);
                        pendingProtocolUrl = null;
                    }
                });
                mainWindow.loadFile(join(app.getAppPath(), '/dist-react/index.html'));
            }

            callback({ cancel: true });
        });
    }

    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
    } else {
        mainWindow.loadFile(join(app.getAppPath(), '/dist-react/index.html'));
    }

    mainWindow.webContents.once('did-finish-load', () => {
        if (pendingProtocolUrl) {
            console.log('Sending pending protocol URL to renderer:', pendingProtocolUrl);
            mainWindow.webContents.send('auth-protocol-callback', pendingProtocolUrl);
            pendingProtocolUrl = null;
        }
    });

    mainWindow.on('resize', () => {
        // Once the renderer reports its layout it re-sends bounds on every resize
        // (ResizeObserver), so only fall back to the fixed offsets before that.
        if (rendererWebViewBounds) return;
        if (getCurrentActiveWebViewId()) {
            resizeCurrentWebView(getWebviewContainerBounds());
        }
    });

    mainWindow.on('close', function(event) {
        if (exitflag){
            return
        }
        event.preventDefault();
        mainWindow.hide();
    });


    // Prevent popups in main window
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        // Links to the Focus Bear website (terms, privacy policy) open in the browser.
        if (/^https:\/\/(www\.)?focusbear\.io\//.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
        console.log('Navigation attempt to:', navigationUrl);

        if (navigationUrl.startsWith('file://') ||
            navigationUrl.startsWith('http://localhost:5173') ||
            navigationUrl.includes('auth0.com')) {
            return;
        }

        event.preventDefault();
    });


    // ipcMain.on('update-webview-bounds', function(event, webViewId, tabName) {
    //     const bounds = getWebviewContainerBounds();
    //     showWebView(webViewId, mainWindow, bounds);
    // });

    ipcMain.on('show-preferences', function() {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });
});

ipcMain.handle('get-extension-connected', () => [...connectedBrowsers]);

// Updates and version (Settings > About, UpdateNotification.jsx). The preload
// has exposed these since the update checker was added, but nothing handled them.
ipcMain.handle('get-app-info', () => ({
  version: app.getVersion(),
  // Test switch: show the first-run onboarding to an account that already did it.
  forceOnboarding: process.env.FOCUSBEAR_FORCE_ONBOARDING === '1',
}));
ipcMain.handle('get-last-update-status', () => getLastResult());
ipcMain.handle('check-for-updates', async () => {
  const result = await checkForUpdates();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', result);
  return result;
});
ipcMain.on('open-update-download', (event, url) => { openDownloadUrl(url); });

ipcMain.handle('get-local-settings', async () => {
  try {
    const data = await fs.readFile(getSettingsPath(), 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
});

ipcMain.on('setup-complete', () => { startPingMonitor(); });

ipcMain.on('block-settings', (event, settings) => { broadcastBlockSettings(settings); });

ipcMain.on('extension-warning-close-browser', async () => {
  cancelExtensionWarning();
  await killBrowsers(warningBrowserId);
});

ipcMain.on('quit-channel', function() {
    exitflag = true
    app.quit();
});

// ---------------------------------------------------------------------------
// Focus session
// The main process owns the running session (so the tray, the window and a
// restart all agree) and its end-of-session timer. The renderer draws it
// (src/ui/focus-session.jsx) and reports it to the Focus Bear API.
// ---------------------------------------------------------------------------
let focusSession = null;
let focusSessionTimer = null;

const getFocusSessionPath = () => join(app.getPath('userData'), 'focus-session.json');

function showMainWindowOn(pageId) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('navigate-to', pageId);
}

function setFocusSession(next) {
    focusSession = next || null;

    if (focusSession) {
        fs.writeFile(getFocusSessionPath(), JSON.stringify(focusSession)).catch(() => {});
    } else {
        fs.unlink(getFocusSessionPath()).catch(() => {});
    }

    const active = isSessionActive(focusSession);
    if (active !== isFocusActive) {
        isFocusActive = active;
        focusState.setActive(active);
        broadcastFocusState(active);
        if (active) broadcastBlocklistUpdate(alwaysBlocklist);
        console.log(active ? 'Focus session started' : 'Focus session ended');
    }

    clearTimeout(focusSessionTimer);
    focusSessionTimer = null;
    if (focusSession && focusSession.status === 'running') {
        focusSessionTimer = setTimeout(() => {
            if (!focusSession || focusSession.status !== 'running') return;
            setFocusSession(endSession(focusSession, Date.now()));
            showMainWindowOn('focus-session'); // the "Great job" screen
        }, remainingMs(focusSession, Date.now()) + 50);
    }

    for (const win of [mainWindow, getTrayWindow()]) {
        if (win && !win.isDestroyed()) win.webContents.send('focus-session-changed', focusSession);
    }
    return focusSession;
}

ipcMain.handle('focus-session:get', () => focusSession);

ipcMain.handle('focus-session:start', (event, input) => {
    if (isSessionActive(focusSession)) return focusSession;
    // startTime: when the renderer already told the server the session started.
    const startTime = Number(input && input.startTime);
    const now = Number.isFinite(startTime) && Math.abs(Date.now() - startTime) < 60000 ? startTime : Date.now();
    return setFocusSession(createSession({ ...(input || {}), now }));
});

ipcMain.handle('focus-session:pause', () => setFocusSession(pauseSession(focusSession, Date.now())));
ipcMain.handle('focus-session:resume', () => setFocusSession(resumeSession(focusSession, Date.now())));
ipcMain.handle('focus-session:adjust', (event, deltaMinutes) =>
    setFocusSession(adjustSession(focusSession, Number(deltaMinutes) || 0, Date.now())));
ipcMain.handle('focus-session:end', () => setFocusSession(endSession(focusSession, Date.now())));

// The task queue changed (a task was finished, or another one was picked).
ipcMain.handle('focus-session:set-tasks', (event, tasks) => {
    if (!isSessionActive(focusSession) || !Array.isArray(tasks)) return focusSession;
    return setFocusSession({ ...focusSession, tasks });
});

// The renderer has sent the finish to the server (or gave up); don't send it again.
ipcMain.handle('focus-session:mark-reported', () => {
    if (!focusSession || focusSession.status !== 'ended') return focusSession;
    return setFocusSession({ ...focusSession, finishReported: true });
});

// The end screen was closed.
ipcMain.handle('focus-session:clear', () => {
    if (isSessionActive(focusSession)) return focusSession;
    return setFocusSession(null);
});

// ---------------------------------------------------------------------------
// Micro breaks
// The main process owns the break timer (it keeps time while the window is
// hidden) and the reminder window. The renderer tells it the account's break
// settings (src/ui/useBreaks.js) and plays the break (src/ui/micro-break.jsx).
// ---------------------------------------------------------------------------
let breakConfig = normaliseBreakConfig({ enabled: false });
let breakPlaying = false;      // a routine or a break is on screen
let breakNextAt = null;        // epoch ms of the next break, null when off
let breakTimer = null;
let breakWarningWindow = null;
let breakWarning = null;       // { seconds, deadline } while the reminder shows

// Dev helper: FOCUSBEAR_BREAK_IN_SECONDS=20 makes every break due that many
// seconds after the timer is set (breaks are otherwise at least 5 minutes apart).
const breakTestSeconds = Number(process.env.FOCUSBEAR_BREAK_IN_SECONDS) || 0;
const fullInterval = () =>
    breakTestSeconds > 0 && breaksActive(breakConfig) ? Date.now() + breakTestSeconds * 1000 : nextBreakAt(breakConfig, Date.now());

const breakState = () => ({ nextAt: breakNextAt, active: breaksActive(breakConfig) });

function scheduleBreak(at) {
    breakNextAt = at;
    clearTimeout(breakTimer);
    breakTimer = null;
    if (breakNextAt) breakTimer = setTimeout(onBreakDue, Math.max(0, breakNextAt - Date.now()));
    for (const win of [mainWindow, getTrayWindow()]) {
        if (win && !win.isDestroyed()) win.webContents.send('breaks-changed', breakState());
    }
}

function closeBreakWarning() {
    breakWarning = null;
    if (breakWarningWindow && !breakWarningWindow.isDestroyed()) breakWarningWindow.destroy();
    breakWarningWindow = null;
}

function onBreakDue() {
    if (!breaksActive(breakConfig)) return scheduleBreak(null);
    const now = new Date();
    const reason = holdReason(breakConfig, {
        focusActive: isSessionActive(focusSession),
        playing: breakPlaying,
        nowMinutes: now.getHours() * 60 + now.getMinutes(),
    });
    if (reason) {
        console.log(`[Breaks] Break held (${reason}); next one in ${breakConfig.minutes} min`);
        return scheduleBreak(fullInterval());
    }
    showBreakWarning();
}

function showBreakWarning() {
    closeBreakWarning();
    scheduleBreak(null); // nothing is counting down while the reminder shows
    breakWarning = { seconds: breakConfig.seconds, deadline: Date.now() + WARNING_SECONDS * 1000 };
    const width = 360;
    const height = 345;
    const area = screen.getPrimaryDisplay().workArea;
    breakWarningWindow = new BrowserWindow({
        width,
        height,
        x: area.x + area.width - width - 16,
        y: area.y + 16,
        show: false,
        frame: false,
        alwaysOnTop: true,
        resizable: false,
        useContentSize: true,
        skipTaskbar: true,
        focusable: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: join(app.getAppPath(), './src/electron/preload.js'),
        },
    });
    breakWarningWindow.on('closed', () => { breakWarningWindow = null; });
    breakWarningWindow.loadFile(join(app.getAppPath(), './src/ui/break-warning.html'));
    // Shown without taking the keyboard away from what the person is typing in.
    breakWarningWindow.webContents.once('dom-ready', () => {
        if (breakWarningWindow && !breakWarningWindow.isDestroyed()) breakWarningWindow.showInactive();
    });
}

function startBreak() {
    closeBreakWarning();
    scheduleBreak(null); // rescheduled when the break is finished or closed
    // 'break-due' tells the page this break came from the timer (it may start by itself).
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('break-due');
    showMainWindowOn('micro-break');
}

ipcMain.handle('breaks:configure', (event, config) => {
    const next = normaliseBreakConfig(config);
    breakPlaying = Boolean(config && config.playing);
    let at = breakWarning ? null : rescheduleAt(breakConfig, next, breakNextAt, Date.now());
    breakConfig = next;
    if (at && at !== breakNextAt) at = fullInterval();
    if (!breaksActive(next)) closeBreakWarning();
    // While a break is on screen or the reminder shows, the timer stays stopped.
    if (at !== breakNextAt && !(breakPlaying && at)) scheduleBreak(at);
    return breakState();
});

ipcMain.handle('breaks:get', () => breakState());

ipcMain.handle('breaks:finished', () => {
    breakPlaying = false;
    scheduleBreak(fullInterval());
    return breakState();
});

ipcMain.handle('breaks:get-warning', () => breakWarning);

ipcMain.on('breaks:warning-answer', (event, action, minutes) => {
    if (!breakWarning) return;
    if (action === 'start') return startBreak();
    closeBreakWarning();
    // Skip: a full interval. Postpone: the chosen minutes.
    scheduleBreak(action === 'postpone' ? nextBreakAt(breakConfig, Date.now(), normalisePostpone(minutes)) : fullInterval());
});

// The block list in force changed (a focus session started or ended, a
// blocking schedule began or finished, or the list was edited).
ipcMain.handle('blocking:set-mode', (event, input) => {
    const strings = (list) => (Array.isArray(list) ? list.filter((entry) => typeof entry === 'string' && entry.trim()) : []);
    const next = {
        blocklist: strings(input && input.blocklist),
        allowOnly: input && Array.isArray(input.allowOnly) ? strings(input.allowOnly) : null,
    };
    if (JSON.stringify(next) === JSON.stringify(modeBlocking)) return false;
    modeBlocking = next;
    console.log(`[Blocking] List in force: ${next.blocklist.length} extra blocked, ` +
        (next.allowOnly ? `allow list of ${next.allowOnly.length}` : 'no allow list'));
    broadcastBlocklistUpdate(alwaysBlocklist);
    broadcastBlockSettings(currentBlockSettings);
    return true;
});

// An allow list is renewed every minute while it is in force (see blockSettings.js),
// and lifted when the app quits.
setInterval(() => {
    if (modeBlocking.allowOnly) broadcastBlockSettings(currentBlockSettings);
}, ALLOW_ONLY_RENEW_MS);
app.on('before-quit', () => {
    if (!modeBlocking.allowOnly && modeBlocking.blocklist.length === 0) return;
    modeBlocking = { blocklist: [], allowOnly: null };
    broadcastBlocklistUpdate(alwaysBlocklist);
    broadcastBlockSettings(currentBlockSettings);
});

// Tray rows ("Day Plan", "To-do list", ...): show that page in the main window.
ipcMain.on('tray-open-page', (event, pageId) => {
    if (isTrayPage(pageId)) showMainWindowOn(pageId);
});

// The tray popup is a separate page and can't read the main window's theme
// choice, so the main window reports it and the popup asks for it.
let currentTheme = 'light';
ipcMain.on('theme-changed', (event, theme) => {
    currentTheme = normaliseTheme(theme);
    const trayWindow = getTrayWindow();
    if (trayWindow && !trayWindow.isDestroyed()) trayWindow.webContents.send('theme-changed', currentTheme);
});
ipcMain.handle('get-theme', () => currentTheme);

// Tray "Start Focus Session": open the start screen (goal, length, block list)
// instead of switching blocking on silently.
ipcMain.on('focus-session-true', function(event) {
    if (isFocusActive) {
        event.sender.send('focus-session-result', 'Focus session already active');
        return;
    }
    showMainWindowOn('focus-session');
});

// Tray "Stop Focus Session": end it and show the summary.
ipcMain.on('focus-session-false', function(event) {
    if (!isFocusActive) {
        event.sender.send('focus-session-result', 'Focus session already inactive');
        return;
    }
    // A Captain or Pawfessor session isn't stopped from the tray: the session
    // screen opens, where the delay or the characters to type are.
    if (hasStopFriction(focusSession)) {
        showMainWindowOn('focus-session');
        return;
    }
    setFocusSession(endSession(focusSession, Date.now()));
    showMainWindowOn('focus-session');

    try {
        if (event.sender && !event.sender.isDestroyed()) {
            event.sender.send('focus-session-result', 'Focus session stopped');
        }
    } catch (e) {
        console.log('Could not send result to original sender (window destroyed)');
    }
});

// URL monitoring
const stopMonitoring = urlGrabber.startRealtimeMonitoring((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('url-changed', data);
    }
}, 250);

// Other IPC handlers
ipcMain.on('print-urls', function(event, urls) {
    console.log('URLs received for printing:\n', urls);
});

ipcMain.on('url-channel', function(e, urls){
    // Handle URL export
});

// App lifecycle
app.on('window-all-closed', function() {
    if (exitflag) {
        // Allow app to quit
    } else {
        return
    }
});

app.on('before-quit', function() {
    stopMonitoring()

    // Close socket server
    if (socketServer) {
        socketServer.close();
        for (const socket of socketClients.keys()) socket.end();
    }
});

app.on('will-quit', function() {
    exitflag = false;
});

// Focus state broadcasting
function broadcastFocusState(isActive) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('focus-state-changed', isActive);
    }

    const trayWindow = getTrayWindow();
    if (trayWindow && !trayWindow.isDestroyed()) {
        trayWindow.webContents.send('focus-state-changed', isActive);
    }
}

app.setAsDefaultProtocolClient('focusbear');

app.on('open-url', (event, url) => {
  event.preventDefault();
  console.log('=== MAIN PROCESS RECEIVED PROTOCOL URL (open-url event) ===');
  console.log('URL:', url);

  if (url.startsWith('focusbear://')) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log('Sending to renderer process...');
      if (mainWindow.webContents.isLoading()) {
        mainWindow.webContents.once('did-finish-load', () => {
          mainWindow.webContents.send('auth-protocol-callback', url);
        });
      } else {
        mainWindow.webContents.send('auth-protocol-callback', url);
      }
      mainWindow.show();
      mainWindow.focus();
    } else {
      console.log('Main window not available, storing URL for later');
      pendingProtocolUrl = url;
    }
  }
});

// AUTH WINDOW HANDLER
function openAuthWindow(authUrl) {
    if (authWindow) {
        authWindow.focus();
        return;
    }

    authWindow = new BrowserWindow({
        width: 500,
        height: 700,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            enableRemoteModule: false
        },
        autoHideMenuBar: true,
        title: 'Focus Bear - Sign In'
    });

    const { webRequest } = authWindow.webContents.session;
    const filter = { urls: ['http://localhost/callback*'] };

    webRequest.onBeforeRequest(filter, async (details, callback) => {
        console.log('[Auth] Intercepted callback:', details.url);

        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('auth-protocol-callback', details.url);
            mainWindow.show();
            mainWindow.focus();
        }

        if (authWindow && !authWindow.isDestroyed()) {
            authWindow.close();
        }

        callback({ cancel: true });
    });

    authWindow.on('closed', () => {
        authWindow = null;
    });

    authWindow.loadURL(authUrl);
}

function handleAuthRedirect(url) {
    if (url.startsWith('focusbear://')) {
        console.log('Auth callback received:', url);

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('auth-protocol-callback', url);
            mainWindow.show();
            mainWindow.focus();
        }

        if (authWindow && !authWindow.isDestroyed()) {
            authWindow.close();
        }
    }
}

//Webiew Handling
// The renderer measures the element the webview should cover and sends its
// bounds (window content coordinates), so the page sits exactly inside the
// layout (sidebar, sub-navigation) instead of a hard-coded offset.
let rendererWebViewBounds = null;

function toWebViewBounds(rect) {
    if (!rect) return null;
    const round = (n) => Math.max(0, Math.round(Number(n) || 0));
    return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) };
}

ipcMain.on('switch-webview', function(event, webViewId, metadata, rect) {
    console.log(`[Main Process] switch-webview called for ${webViewId}`);
    console.log(`[Main Process] Metadata:`, {
        hasAccessToken: !!metadata?.access_token,
        hasClientId: !!metadata?.client_id,
        clientId: metadata?.client_id,
        hasUser: !!metadata?.user,
        theme: metadata?.theme
    });

    const config = webViewConfigs[webViewId];
    if (!config) {
        console.error(`[Main Process] No config found for webViewId: ${webViewId}`);
        return;
    }

    // Key webviews by the id the renderer asked for, so switchToWebView finds them.
    createWebView({
        ...config,
        id: webViewId,
        mainWindow,
        metadata,
        // What the page told the app (e.g. onboarding's habit ideas were installed).
        onMessage: (id, message) => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('webview-message', id, message);
        },
    });
    rendererWebViewBounds = toWebViewBounds(rect) || rendererWebViewBounds;
    const bounds = rendererWebViewBounds || getWebviewContainerBounds();
    switchToWebView(webViewId, mainWindow, bounds);
});

ipcMain.on('resend-webview-metadata', function(event, webViewId, metadata) {
    resendWebViewMetadata(webViewId, metadata);
});

ipcMain.on('destroy-webview', function(event, webViewId) {
    destroyWebView(webViewId, mainWindow);
});

ipcMain.on('set-webview-bounds', function(event, rect) {
    const bounds = toWebViewBounds(rect);
    if (!bounds) return;
    rendererWebViewBounds = bounds;
    resizeCurrentWebView(bounds);
});

ipcMain.handle('get-focus-state', () => focusState.isActive());

ipcMain.on('hide-all-webviews', function(event) {
    hideAllWebViews(mainWindow);
})

ipcMain.on('open-auth-window', function(event, url) {
    console.log('Opening auth window with URL:', url);
    openAuthWindow(url);
})


//FOR AUTH0 SETTINGS SYNCING

const getSettingsPath = () => {
  return join(app.getPath('userData'), 'settings.json');
};

ipcMain.handle('get-settings', async () => {
  try {
    const cloudSettings = await loadFromAuth0();
    if (cloudSettings) {
      console.log('Loaded settings from Auth0:', cloudSettings);
      saveLocalBackup(cloudSettings);
      return cloudSettings;
    }
  } catch (error) {
    console.log('Auth0 load failed, trying local fallback:', error.message);
  }

  try {
    const settingsPath = getSettingsPath();
    const data = await fs.readFile(settingsPath, 'utf8');
    const settings = JSON.parse(data);
    console.log('Loaded settings from local fallback:', settings);
    return settings;
  } catch (error) {
    console.log('No settings found, using defaults');
    return null;
  }
});

ipcMain.handle('save-settings', async (event, settings) => {
  try {
    // Merge into the file: the setup wizard and the settings sync each save
    // only their own keys (see localSettings.js).
    let existing = null;
    try {
      existing = JSON.parse(await fs.readFile(getSettingsPath(), 'utf8'));
    } catch { /* first save, or unreadable file */ }
    const settingsWithMeta = mergeLocalSettings(existing, settings);

    // The account copy is saved by the renderer (src/services/sync.js, Focus Bear
    // API). The old 'auth0-save-settings' round trip had no listener in the
    // renderer, so every save waited 10 s for its timeout before reaching disk.
    await saveLocalBackup(settingsWithMeta);
    applySettings(settings);

    return { success: true };
  } catch (error) {
    console.error('Failed to save settings:', error);
    return { success: false, error: error.message };
  }
});

async function loadFromAuth0() {
  return new Promise((resolve, reject) => {
    mainWindow.webContents.send('auth0-get-settings');

    const timeout = setTimeout(() => {
      ipcMain.removeAllListeners('auth0-settings-response');
      reject(new Error('Timeout loading from Auth0'));
    }, 5000);

    ipcMain.once('auth0-settings-response', (event, result) => {
      clearTimeout(timeout);
      if (result.success) {
        resolve(result.data);
      } else {
        reject(new Error(result.error));
      }
    });
  });
}

async function saveLocalBackup(settings) {
  try {
    const settingsPath = getSettingsPath();
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    console.log('Local backup saved:', settingsPath);
  } catch (error) {
    console.error('Failed to save local backup:', error);
  }
}

function applySettings(settings) {
  if (settings.urlList) {
    console.log('Blocklist updated');
    broadcastBlocklistUpdate(settings.urlList);
  }

  if (typeof settings.immediatelyBlock === 'boolean') {
    broadcastBlockSettings(settings);
  }

  if (settings.selectedBrowsers) {
    selectedBrowsers = settings.selectedBrowsers;
    console.log('Selected browsers updated:', selectedBrowsers);
  }

  console.log('Blocking mode:', settings.selectedBlockMode);
  console.log('Blocking method:', settings.selectedBlockMethod);
  console.log('Bear mode:', settings.selectedBearMode);
}
// END OF AUTH 0 SETTINGS SYNCING

ipcMain.handle('detect-distro', async function() {
  return new Promise((resolve) => {
    exec('cat /etc/os-release', (error, stdout, stderr) => {
      if (error) {
        resolve('unknown');
        return;
      }

      const output = stdout.toLowerCase();
      if (output.includes('ubuntu')) {
        resolve('ubuntu');
      } else if (output.includes('debian')) {
        resolve('debian');
      } else if (output.includes('fedora')) {
        resolve('fedora');
      } else if (output.includes('arch')) {
        resolve('arch');
      } else if (output.includes('mint')) {
        resolve('mint');
      } else {
        resolve('unknown');
      }
    });
  });
});

ipcMain.handle('cleanup-app-data', async function() {
  const details = [];
  let success = true;

  try {
    if (isFocusActive || focusSession) {
      setFocusSession(null);
      details.push('Stopped active focus session');
    }

    try {
      await fs.unlink('/tmp/focusbear-blocklist.txt');
      details.push('Removed blocklist file');
    } catch (error) {
      console.log('Blocklist file not found or already removed');
    }

    try {
      await fs.unlink('/tmp/focusbear-keywords.txt');
      details.push('Removed keywords file');
    } catch (error) {
      console.log('Keywords file not found or already removed');
    }

    const settingsPath = getSettingsPath();
    try {
      await fs.unlink(settingsPath);
      details.push('Removed local settings backup');
    } catch (error) {
      console.log('Settings file not found or already removed');
    }

    return {
      success: true,
      message: 'Successfully cleaned up all Focus Bear data',
      details: details
    };

  } catch (error) {
    console.error('Cleanup failed:', error);
    return {
      success: false,
      message: 'Failed to clean up some data: ' + error.message,
      details: details
    };
  }
});

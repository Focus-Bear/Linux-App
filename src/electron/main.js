import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { app, BrowserWindow, ipcMain } from "electron";
import {createTray, getTrayWindow} from "./tray-handler.js"
import { createWebView, switchToWebView, hideAllWebViews, webViewConfigs } from './webview-handler.js';
import { exec, execFile, spawn } from 'child_process';
import "./Blocker.js"
import { focusState } from './focusState.js';
import SimpleUrlGrabber from './simpleUrlGrabber.js';
import dotenv from 'dotenv';
import { promises as fs } from 'fs';
// --- Transparent-proxy start/stop helpers (replace existing startMitmproxyBlocker & stopMitmproxyBlocker) ---
import { access } from 'fs';
import { constants } from 'fs';

// Load environment variables
dotenv.config();

let tray = null
let focusBearView = null
let mainWindow = null;
let exitflag = false;
const urlGrabber = new SimpleUrlGrabber();

// Unified focus session state
let isFocusActive = false;
let mitmproxyProcess = null;

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
      mainWindow.focus();
      
      const protocolUrl = commandLine.find(arg => arg.startsWith('focusbear://'));
      if (protocolUrl) {
        mainWindow.webContents.send('auth-protocol-callback', protocolUrl);
      }
    }
  });
}

app.on("ready", function(){
    mainWindow = new BrowserWindow({
        autoHideMenuBar: true,
        height: 850,
        width: 1000,
        show: false,
        webviewTag: true,
        webPreferences: {
            preload: join(app.getAppPath(), "/src/electron/preload.js"),
            webSecurity: false,
        },
        devTools: true,
    });
    tray = createTray(mainWindow)
    
    const isDev = !app.isPackaged;
    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
    } else {
        mainWindow.loadFile(join(app.getAppPath(), '/dist-react/index.html'));
    }

    mainWindow.on('resize', () => {
        if (focusBearView && mainWindow.contentView) {
            const containerBounds = getWebviewContainerBounds();
            focusBearView.setBounds(containerBounds);
        }
    });

    mainWindow.on('close', function(event) {
        if (exitflag){
            return 
        }
        event.preventDefault(); 
        mainWindow.hide();      
    });


    // Auth0 navigation handlers
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.includes('auth0.com')) {
            mainWindow.loadURL(url);
            return { action: 'deny' };
        }
        return { action: 'deny' };
    });

    mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
        console.log('Navigation attempt to:', navigationUrl);
        
        if (navigationUrl.includes('auth0.com')) {
            return;
        }
        if (navigationUrl.startsWith('file://') || navigationUrl.startsWith('http://localhost:5173')) {
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
            mainWindow.setSize(1000, 850);
            mainWindow.center();
            mainWindow.show();
            mainWindow.focus();
        }
    });
});

ipcMain.on('quit-channel', function() {
    exitflag = true
    app.quit();
});

ipcMain.on('focus-session-true', function(event) {
    if (isFocusActive) {
        event.sender.send('focus-session-result', 'Focus session already active');
        return;
    }
    
    startMitmproxyBlocker((error, result) => {
        if (!error) {
            isFocusActive = true;
            focusState.setActive(true);
            broadcastFocusState(true);
            console.log('Focus session started with mitmproxy');
        }
        
        try {
            if (event.sender && !event.sender.isDestroyed()) {
                event.sender.send('focus-session-result', error ? `Error: ${result}` : result);
            }
        } catch (e) {
            console.log('Could not send result to original sender (window destroyed)');
        }
    });
    
    //Uncomment if using hosts file method
    /*
    const scriptPath = join(__dirname, 'focusbear_hosts_blocker.cjs');
    const blocklistPath = '/tmp/focusbear-blocklist.txt';
    const command = `pkexec node "${scriptPath}" block --list "${blocklistPath}"`;
    
    console.log(`Starting focus session: ${command}`);
    
    exec(command, (error, stdout, stderr) => {
        if (!error) {
            isFocusActive = true;
            focusState.setActive(true)
            broadcastFocusState(true);
            console.log('Focus session started with hosts file');
        }
        const result = error ? `Error: ${stderr || error.message}` : stdout;
        try {
            if (event.sender && !event.sender.isDestroyed()) {
                event.sender.send('focus-session-result', result);
            }
        } catch (e) {
            console.log('Could not send result to original sender (window destroyed)');
        }
    });
    */
});

ipcMain.on('focus-session-false', function(event) {
    if (!isFocusActive) {
        event.sender.send('focus-session-result', 'Focus session already inactive');
        return;
    }
    
    // Stop mitmproxy blocker
    stopMitmproxyBlocker();
    isFocusActive = false;
    focusState.setActive(false);
    broadcastFocusState(false);
    console.log('Focus session ended');
    
    try {
        if (event.sender && !event.sender.isDestroyed()) {
            event.sender.send('focus-session-result', 'Focus session stopped');
        }
    } catch (e) {
        console.log('Could not send result to original sender (window destroyed)');
    }
    
    // Uncomment if using hosts file method
    /*
    const scriptPath = join(__dirname, 'focusbear_hosts_blocker.cjs');
    const command = `pkexec node "${scriptPath}" unblock`;
    
    console.log(`Ending focus session: ${command}`);
    
    exec(command, (error, stdout, stderr) => {
        if (!error) {
            isFocusActive = false;
            focusState.setActive(false);
            broadcastFocusState(false);
            console.log('Focus session ended');
        }
        
        const result = error ? `Error: ${stderr || error.message}` : stdout;
        
        try {
            if (event.sender && !event.sender.isDestroyed()) {
                event.sender.send('focus-session-result', result);
            }
        } catch (e) {
            console.log('Could not send result to original sender (window destroyed)');
        }
    });
    */
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
    stopMitmproxyBlocker(); // Clean up mitmproxy process
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
  console.log('=== MAIN PROCESS RECEIVED PROTOCOL URL ===');
  console.log('URL:', url);
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log('Sending to renderer process...');
    mainWindow.webContents.send('auth-protocol-callback', url);
  } else {
    console.log('Main window not available!');
  }
});

// SYSTEM PROXY FUNCTIONS
function setSystemProxy(host, port, callback) {
    const scriptPath = join(__dirname, '../python/set_system_proxy.py');
    execFile('python3', [scriptPath, 'set', host, port], (err, stdout, stderr) => {
        if (err) {
            console.error('Proxy set error:', stderr);
            if (callback) callback(err, stderr);
        } else {
            console.log('Proxy set:', stdout);
            if (callback) callback(null, stdout);
        }
    });
}

function unsetSystemProxy(callback) {
    const scriptPath = join(__dirname, '../python/set_system_proxy.py');
    execFile('python3', [scriptPath, 'unset'], (err, stdout, stderr) => {
        if (err) {
            console.error('Proxy unset error:', stderr);
            if (callback) callback(err, stderr);
        } else {
            console.log('Proxy unset:', stdout);
            if (callback) callback(null, stdout);
        }
    });
}



// Helper to run a script with elevation
function runElevatedScript(scriptPath, args = []) {
  return new Promise(async (resolve, reject) => {
    try {
      // Ensure script exists
      await fs.access(scriptPath, constants.F_OK);
    } catch (err) {
      return reject(new Error(`Script not found: ${scriptPath}`));
    }

    const elevCmd = 'pkexec'; // change to 'sudo' if you prefer
    console.log(`Attempting to run elevated script via ${elevCmd}: ${scriptPath}`);

    // Try pkexec first
    let proc;
    try {
      proc = spawn(elevCmd, [scriptPath, ...args], { stdio: 'inherit' });
    } catch (err) {
      // spawn can throw synchronously in rare cases
      console.warn(`Failed to spawn ${elevCmd}: ${err.message}`);
      proc = null;
    }

    if (!proc) {
      // Fallback to bash
      console.warn(`Falling back to 'bash ${scriptPath}'`);
      const fallback = spawn('bash', [scriptPath, ...args], { stdio: 'inherit' });
      fallback.on('error', (e) => reject(new Error(`Failed to run fallback bash: ${e.message}`)));
      fallback.on('close', (code) => {
        if (code !== 0) reject(new Error(`Script exited with code ${code}`));
        else resolve(`Script ${scriptPath} finished (fallback bash)`);
      });
      return;
    }

    // Handle pkexec process events
    proc.on('error', (err) => {
      console.warn(`pkexec process error: ${err.message}. Falling back to bash...`);
      // pkexec failed to start — fallback to bash
      const fallback = spawn('bash', [scriptPath, ...args], { stdio: 'inherit' });
      fallback.on('error', (e) => reject(new Error(`Failed to run fallback bash: ${e.message}`)));
      fallback.on('close', (code) => {
        if (code !== 0) reject(new Error(`Script exited with code ${code}`));
        else resolve(`Script ${scriptPath} finished (fallback bash)`);
      });
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${elevCmd} script exited with code ${code}`));
      } else {
        resolve(`Script ${scriptPath} finished via ${elevCmd}`);
      }
    });
  });
}

// MITMPROXY BLOCKING FUNCTIONS
function startMitmproxyBlocker(callback) {
    const scriptPath = join(__dirname, '../python/mitmproxy_blocker.py');
    const setupPath = join(__dirname, '../sh_scripts/network_setup.sh');
    const mitmPath = process.env.MITM_PATH || 'mitmdump';

    console.log(`Running network setup script: ${setupPath}`);

     runElevatedScript(scriptPath, [], (err, result) => {
        if (err) {
            console.error('Failed to run network_setup.sh:', err.message);
            if (callback) callback(err, err.message);
            return;
        }

        console.log('Network setup completed:', result);
        console.log('Starting mitmproxy in transparent mode...');

        // Start mitmdump in transparent mode and load your filter script
        const mitmArgs = [
            '-s', scriptPath,
            '--mode', 'transparent',
            '--set', 'block_global=false',
            '--set', 'flow_detail=0',
            '--set', 'console_eventlog_verbosity=error',
            '--set', 'termlog_verbosity=error'
        ];

        try {
            mitmproxyProcess = spawn(mitmPath, mitmArgs);

            mitmproxyProcess.stdout.on('data', (data) => {
                console.log(`mitmproxy: ${data.toString()}`);
            });

            mitmproxyProcess.stderr.on('data', (data) => {
                console.error(`mitmproxy error: ${data.toString()}`);
            });

            mitmproxyProcess.on('close', (code) => {
                console.log(`mitmproxy process exited with code ${code}`);
                mitmproxyProcess = null;
                isFocusActive = false;
            });

            mitmproxyProcess.on('error', (error) => {
                console.error('Failed to start mitmproxy:', error);
                if (callback) callback(error, error.message);
                return;
            });

            // Give mitmproxy a moment to spin up, then callback success to the UI
            setTimeout(() => {
                if (callback) callback(null, 'mitmproxy (transparent) started with nosurfin flags');
            }, 1000);
        } catch (spawnErr) {
            console.error('Error spawning mitmproxy:', spawnErr);
            if (callback) callback(spawnErr, spawnErr.message);
        }
    });
}

function stopMitmproxyBlocker() {
    const resetPath = join(__dirname, '../sh_scripts/network_reset.sh');

    if (mitmproxyProcess) {
        console.log('Stopping mitmproxy blocker...');
        try {
            mitmproxyProcess.kill('SIGTERM');
        } catch (e) {
            console.warn('Error killing mitmproxy process:', e);
        }
        mitmproxyProcess = null;
    } else {
        console.log('mitmproxy process not running.');
    }

    console.log(`Running network reset script: ${resetPath}`);

    runElevatedScript(scriptPath, [], (err, result) => {
        if (err) {
            console.error('Failed to run network_reset.sh:', err.message);
            return;
        }
        console.log('Network reset completed:', result);
    });
}

//Webiew Handling
ipcMain.on('switch-webview', function(event, webViewId) {
    const config = webViewConfigs[webViewId];
    if (!config) return;

    const webView = createWebView({ ...config, mainWindow });
    const bounds = getWebviewContainerBounds();

    switch(webViewId) {
        case 'blocking_schedule':
            bounds.height = bounds.height * 0.46;
            break;
        case 'edit_habits':
            // Keep default bounds
            break;
        // Add other webview-specific sizing as needed
    }
    switchToWebView(webViewId, mainWindow, bounds);
});

ipcMain.on('hide-all-webviews', function(event) {
    hideAllWebViews(mainWindow);
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
    const settingsWithMeta = {
      ...settings,
      lastModified: new Date().toISOString(),
      version: '1.0.0'
    };
    
    try {
      await saveToAuth0(settingsWithMeta);
      console.log('Settings saved to Auth0');
    } catch (error) {
      console.error('Auth0 save failed, saving locally:', error.message);
    }
    
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

async function saveToAuth0(settings) {
  return new Promise((resolve, reject) => {
    mainWindow.webContents.send('auth0-save-settings', settings);
    
    const timeout = setTimeout(() => {
      ipcMain.removeAllListeners('auth0-save-response');
      reject(new Error('Timeout saving to Auth0'));
    }, 10000);
    
    ipcMain.once('auth0-save-response', (event, result) => {
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
    const urlString = settings.urlList.join('\n');
    fs.writeFile('/tmp/focusbear-blocklist.txt', urlString)
      .then(() => console.log('Blocklist updated'))
      .catch(err => console.error('Failed to update blocklist:', err));
  }
  
  console.log('Blocking mode:', settings.selectedBlockMode);
  console.log('Blocking method:', settings.selectedBlockMethod);
  console.log('Bear mode:', settings.selectedBearMode);
}
// END OF AUTH 0 SETTINGS SYNCING

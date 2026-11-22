import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { app, Menu, Tray, BrowserWindow, screen } from 'electron'
import { focusState } from './focusState.js';

let trayWindow;


const win_width = 300;
const win_height = 508;

// Dev helper for desktops without a tray host (WSLg, some VMs): start the app
// with FOCUSBEAR_SHOW_TRAY=1 to open the tray popup at launch and keep it open.
const keepTrayOpen = process.env.FOCUSBEAR_SHOW_TRAY === '1';

function showWindow(mainWindow){
    //returns the primary display 
    const primaryDisplay = screen.getPrimaryDisplay()
    //returns the work area size of the display (x ,y)
    const {width, height} = primaryDisplay.workAreaSize //has to be called width and height


    trayWindow = new BrowserWindow({
        width: win_width,
        height: win_height,
        x: (primaryDisplay.bounds.x + width)- win_width,
        y: (primaryDisplay.bounds.y + height) - win_height,
        

        show: false,
        frame: false,
        alwaysOnTop: true,
        resizable: false,
        useContentSize: true,
        skipTaskbar: true,
        type: 'toolbar',
        parent: mainWindow,  // Add this line
        modal: false,   
        webPreferences: {  // Add this
            nodeIntegration: false,
            contextIsolation: true,
            preload: join(app.getAppPath(), "./src/electron/preload.js")
        }
    });
    console.log(`Bounds X: ${primaryDisplay.bounds.x} disp width: ${width}`)
    console.log(`Bounds Y: ${primaryDisplay.bounds.y} disp width: ${height}`)
    trayWindow.on('blur', function() {
        if (keepTrayOpen) return;
        if (trayWindow && !trayWindow.webContents.isDevToolsOpened()) {
            trayWindow.destroy()
        }
    });

 
    trayWindow.on('closed', function () {
        trayWindow = null;
    });
    trayWindow.loadFile(join(app.getAppPath(), './src/ui/tray.html'));
    
    trayWindow.webContents.once('dom-ready', function() {
        console.log('Tray DOM ready');
     
        trayWindow.webContents.send('focus-state-changed', focusState.isActive());
      
        trayWindow.show();
    });
}



export function getTrayWindow() {
    return trayWindow;
}

function createTray(mainWindow){
    let tray = new Tray((join(app.getAppPath(), "./public/bear-icon.png" )))

    if (keepTrayOpen) showWindow(mainWindow);

    tray.setToolTip('Focus Bear')

    tray.on('click', function () {
        if (trayWindow && trayWindow.isVisible()) {
            trayWindow.destroy()
        } 
        else {
            showWindow(mainWindow);
        }
    });

    return tray
}

export {createTray}


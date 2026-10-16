> **Legacy:** this is the earlier per-browser extension. It is replaced by the unified extension in the `chrome_extension` repository and kpet in this repository in case anything in it is missing from the unified one. 

# Focus Bear Blocker (Firefox extension)

This extension talks to the Focus Bear app through the native messaging host and blocks the sites on the user's blocklist. It is the Firefox build (Manifest v2, `webRequest` blocking).

The extension for Chrome, Chromium, Brave and Opera lives in `../extension-chrome/` (Manifest v3, `declarativeNetRequest`). Both use the same native messaging host (`../native-messaging/host.js`). Architecture, URL matching differences and file locations are in [docs/BLOCKING.md](../../docs/BLOCKING.md).

## Setup for Development

### 1. Start the app

```bash
npm run start
```

On startup the app installs the native messaging host for your user: a launcher at `~/.local/bin/focusbear-native-host`, copies under `~/.local/share/focusbear/`, and a native messaging manifest for each supported browser. It also starts the Unix socket server the host connects to. These files are rewritten on every launch.

If you only want the host installed without running the app:

```bash
npm run install-native-messaging
```

This writes the `~/.local/bin` launcher and the Firefox manifest only (not Chrome), and points at `host.js` in your checkout.

### 2. Load the extension in Firefox

1. Open Firefox
2. Go to `about:debugging#/runtime/this-firefox`
3. Click **"Load Temporary Add-on..."**
4. Select `manifest.json` in `src/extension/`

Firefox removes temporary add-ons when it closes, so repeat this after each restart.

### 3. Load the extension in Chrome, Chromium, Brave or Opera

1. Open `chrome://extensions` and enable **Developer mode**
2. Click **Load unpacked** and select `src/extension-chrome/`

The manifest the app writes for these browsers only allows the **production** extension ID (`CHROME_EXTENSION_ID` in `src/electron/main.js`). If Chrome reports that access to the native messaging host is forbidden, the ID of your unpacked extension differs from that constant. See [Development Setup](../../docs/BLOCKING.md#development-setup).

### 4. Test the connection

1. Make sure the app is running
2. Click the Focus Bear Blocker icon in the browser toolbar
3. The popup shows:
   - Whether the extension is connected to the native messaging host
   - Whether it is connected to the Focus Bear app ("App not running (using cached data)" means the host is up but the app is closed)

### 5. Configure the block list

Use the Focus Bear app (**Blocks → Super Distracting Sites**). The app sends the list to the extension through the native messaging host whenever it changes.

## How It Works

```
┌─────────────────┐
│  Electron App   │
│  (Focus Bear)   │
└────────┬────────┘
         │ Unix Socket
         │ /tmp/focusbear.sock
         ▼
┌─────────────────────────────────┐
│ Native Messaging Host           │
│ (~/.local/bin/focusbear-native-host)│
└────────┬────────────────────────┘
         │ stdin/stdout (JSON)
         ▼
┌─────────────────────────────────┐
│ Browser extension               │
│ (background.js + popup)         │
└─────────────────────────────────┘
```

## Files

- **manifest.json** - Extension manifest with permissions
- **background.js** - Native messaging connection, URL blocking and temporary unblocks
- **popup.html / popup.js** - Extension popup UI and logic
- **blocked.html / blocked.js** - Page shown for a blocked site
- **icon.png** - Extension icon

## Debugging

### Check native host logs

```bash
tail -f /tmp/focusbear-native-host.log
```

### Check the extension console

1. Go to `about:debugging#/runtime/this-firefox`
2. Find Focus Bear Blocker
3. Click **"Inspect"** and open the Console tab

### Test the native host manually

The launcher starts the host, but native messaging uses length-prefixed messages, so you can only check that it runs, not talk to it by hand:

```bash
~/.local/bin/focusbear-native-host
```

It should start without errors and keep running; check the log file for `Native host ready`. Stop it with Ctrl+C.

## Uninstalling

Use the app: **Settings → Uninstall → Clean Up App Data** removes the launcher, the copies in `~/.local/share/focusbear/` and the manifests for every supported browser. Quit the app, then remove the extension from the browser (`about:addons`). Quit the app first, otherwise the app's extension monitor warns and closes the browser.

## Next Steps

- [ ] Distribute the extension through the Firefox Add-ons store
- [ ] Add more sophisticated blocking rules (time-based, etc.)

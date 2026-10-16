# URL Blocking Architecture

## Current Implementation: Native Messaging Host

Focus Bear blocks sites in the browser itself, through an extension that receives the blocklist from the desktop app. There is no system-wide proxy, certificate or traffic interception involved. 

### Architecture Overview

```
┌─────────────────┐
│  Electron App   │  (Focus Bear)
└────────┬────────┘
         │ Unix Socket
         │ /tmp/focusbear.sock
         ▼
┌─────────────────────────────────┐
│ Native Messaging Host           │  Node.js process, started by the browser
│ (focusbear-native-host launcher)│  (stdio bridge)
└────────┬────────────────────────┘
         │ Native Messaging Protocol
         │ (length-prefixed JSON over stdin/stdout)
         ▼
┌─────────────────────────────────┐
│ Browser Extension               │  Firefox, Chrome, Chromium, Brave, Opera
│ "Focus Bear Blocker"            │
└─────────────────────────────────┘
```

### How It Works

1. **Electron App** manages the blocklist and runs a Unix socket server (`/tmp/focusbear.sock`).
2. **Native messaging host:** `host.js` bridges the browser's native-messaging connection to the desktop app's socket (or Windows named pipe). There are two copies: the Linux app ships `src/native-messaging/host.js`, and the `chrome_extension` repository ships `focus_bear/native-messaging/host.js`. They are separate files, not kept in sync automatically. The manifest the browser reads decides which one starts (see "Native messaging registration" below).
3. **Consolidated extension:** Receives blocklist and session updates and enforces website blocking in the browser. The extension code is maintained in the `chrome_extension` repository rather than as a Linux-specific extension in the Linux app repository.
4. **Host registration:** Browsers locate a native host through a manifest JSON file. The manifest specifies the host name, launcher path, transport type and which extension ID(s) are allowed to connect.

## Native messaging registration on Linux

The consolidated extension repository provides `focus_bear/native-messaging/register-linux-host.js`. It creates a launcher and writes native messaging manifests for the current user.

- Firefox manifests are written to `~/.mozilla/native-messaging-hosts/` and `~/snap/firefox/common/.mozilla/native-messaging-hosts/` (for Snap Firefox).
- Chromium-family manifests are written to the configuration directories for Google Chrome, Chromium, Brave and Opera.
- Firefox can be registered without a Chromium extension ID.
- To register Chromium browsers, the script needs the extension ID. It writes that ID into each Chromium manifest's `allowed_origins` list.

The generated launcher invokes the Node.js executable used to run the registration script. This avoids relying on the browser's restricted `PATH`, which can otherwise prevent Node installations managed by tools such as `nvm` from being found.

### Extension ID considerations

Firefox's host manifest uses the extension ID configured for the Firefox extension. For Chromium browsers, the extension ID in the manifest must match the ID of the installed extension.

In development, a developer may need to update the configured Chrome extension ID to match the ID shown by their unpacked development build. The current repository has a hard-coded development ID; when the extension is published, this should be changed to the production extension ID. If the IDs do not match, Chromium browsers can reject the native host connection with an error such as “Access to the specified native messaging host is forbidden.”

### Key Features

#### Real-time Updates
- The app pushes the blocklist to every connected extension whenever it changes, and to any extension that connects
- Extensions can also request the current blocklist on demand

#### Connection Handling
- The host retries its connection to the app every 2 seconds; the Firefox extension retries the host every 5 seconds

#### Extension Monitoring
After setup is complete, the app checks that the extension is alive in every browser the user selected:
- The host sends a heartbeat every 10 seconds. If a browser is running and its host has been silent for more than 20 seconds, the app shows a warning
- If a host disconnects while its browser keeps running, the app waits a grace period and then shows the warning
- If a selected browser is running and its extension has never connected, the same warning appears
- If the warning is not dealt with within 30 seconds, **the app closes that browser**

This is why the uninstall steps tell users to quit Focus Bear before removing the extension.

#### Session Events
The app relays session events (`SESSION_START`, `SESSION_PAUSE`, `SESSION_RESUME`, `SESSION_CANCEL`) to connected hosts, and the host forwards `REQUEST_SESSION_*` messages from an extension to the app.

### Advantages Over the Old mitmproxy Approach

| Aspect | Native Messaging | mitmproxy (removed) |
|--------|-----------------|----------------------|
| **Performance** | Near-zero overhead | 70x slowdown observed |
| **User Setup** | Add an extension | Manual CA cert + proxy config |
| **Security** | No MITM, browser-native | Requires trusting a custom CA |
| **Resource Usage** | Lightweight | Heavy proxy process |
| **Sandboxing** | Works with snap Firefox | Breaks with sandboxed browsers |
| **Maintenance** | No certificates to renew | Requires cert renewal |

## Installation and development

### Production

Install Focus Bear using the supported Linux package instructions. Install the unified Focus Bear extension separately in each browser the user intends to use, then complete the app's first-run browser setup.

The native messaging manifest must point to an existing host launcher, and the extension ID in that manifest must match the installed extension. Node.js is required by the native messaging host.

Three things can write native messaging manifests: the package scripts (a system-wide Firefox manifest), the app itself (per-user manifests for every supported browser, on every launch), and the extension repository's `register-linux-host.js` (per-user, for development). When diagnosing a connection, inspect the manifest the browser actually reads.

### Development setup

1. Build the consolidated extension from the `chrome_extension` repository:

   ```bash
   cd focus_bear
   npm run build
   ```

2. Load the built extension in the target browser using the repository's development instructions. Typically, use `dist-firefox` for Firefox and `dist` for Chromium-based browsers.

3. Register the native messaging host on Linux:

   ```bash
   node native-messaging/register-linux-host.js
   ```

   This registers Firefox. To register Chromium-based browsers as well, pass the extension ID shown on the browser's extensions page:

   ```bash
   node native-messaging/register-linux-host.js <chrome-extension-id>
   ```

4. Restart the browser after changing native messaging manifests or extension IDs.

For the current cross-platform registration instructions and message protocol, see `focus_bear/native-messaging/README.md` in the consolidated extension repository.

## File locations and troubleshooting

Common Linux locations created by the consolidated extension's registration script:

- **Generated launcher:** `~/.local/share/com.focusbear.host/host-launcher.sh`
- **Firefox manifests:** `~/.mozilla/native-messaging-hosts/com.focusbear.host.json`
- **Snap Firefox manifest:** `~/snap/firefox/common/.mozilla/native-messaging-hosts/com.focusbear.host.json`
- **Chrome manifest:** `~/.config/google-chrome/NativeMessagingHosts/com.focusbear.host.json`
- **Chromium manifest:** `~/.config/chromium/NativeMessagingHosts/com.focusbear.host.json`
- **Brave manifest:** `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.focusbear.host.json`
- **Opera manifest:** `~/.config/opera/NativeMessagingHosts/com.focusbear.host.json`
- **Native host log:** `/tmp/focusbear-native-host.log`

- **App launcher:** `~/.local/bin/focusbear-native-host`
- **App copies (host and legacy extensions):** `~/.local/share/focusbear/`
- **Also written by the app:** manifests under `~/.config/google-chrome-beta/` and `~/.config/google-chrome-unstable/` (`NativeMessagingHosts/`)
- **System-wide (deb/rpm):** `/usr/local/bin/focusbear-native-host` and `/usr/lib/mozilla/native-messaging-hosts/com.focusbear.host.json`

### Debugging

Check native host logs for connection issues:
```bash
tail -f /tmp/focusbear-native-host.log
grep "Detected Browser" /tmp/focusbear-native-host.log | tail
```

Inspect the extension console:
- **Firefox:** `about:debugging#/runtime/this-firefox` → Focus Bear → **Inspect**
- **Chromium browsers:** `chrome://extensions` → Focus Bear → **service worker (if this build uses one)**

If Chrome extension fails to connect, verify `com.focus.host.json` has the correct id:
```bash
nano ~/.config/google-chrome/NativeMessagingHosts/com.focusbear.host.json
```

Common causes when an extension won't connect: the app has not been launched since installing (the app writes its launcher and manifests at launch, with register-linux-host.js you don't need the app first), `node` is not installed, or on a Chromium browser the extension ID doesn't match the manifest (see Development Setup).

### Current Status

✅ **Implemented:**
- Unix socket communication between the app and the native host
- Native Messaging bridge (stdin/stdout) for Firefox, Chrome, Chromium, Brave and Opera
- Native messaging with the unified extension, the earlier per-browser extensions remain in the repository as legacy
- Real-time blocklist updates from the app to connected extensions
- First-run setup screen that waits for each selected browser's extension to connect
- Extension monitoring with a warning and browser close
- Settings → Uninstall page that removes the per-user native messaging files

🚧 **In Progress:**
- Distributing the extension through the Firefox Add-ons and Chrome Web Store listings
- Keyword blocking (the tab exists in the app; the backend is not implemented)

📋 **Future Enhancements:**
- Time-based blocking rules
- Per-site allow/block toggles
- Block attempt logging and statistics
- Removal of all legacy code

**Legacy components still in the repository** (kept in case the unified extension is missing something): the per-browser extensions in `src/extension/` and `src/extension-chrome/`, which `installNativeMessaging()` still copies and packs into `focusbear-extension.xpi` and `focusbear-extension-chrome.zip`; the `python3` package dependency; and `src/electron/focusbear_hosts_blocker.cjs`.

---

## History: mitmproxy

The earlier mitmproxy-based approach has been removed from the codebase. It needed a custom CA certificate, system proxy configuration, and slowed browsing noticeably. See [history/blocking-decision-report.md](history/blocking-decision-report.md) for the original decision.

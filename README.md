# Focus Bear - Linux Distraction Blocker

A lightweight, browser-native URL blocking application for Linux using Electron and native messaging architecture.

**Status:** [0.1.0] - Ready to Open Source

---

## Quick Start

### Prerequisites

- Node.js v20+ (for development)
- Firefox, Chrome, Chromium, Brave or Opera
- System libraries (see [System Dependencies](#system-dependencies))

### Development

```bash
npm ci                  # Install dependencies
npm run start          # Development mode (hot reload)
npm run start:prod     # Production mode
```

### Production - Install via Package Manager

```bash
# Debian/Ubuntu
sudo dpkg -i ./focusbear-0.1.0-amd64.deb

# Fedora/RHEL
sudo dnf install ./focusbear-0.1.0-x86_64.rpm

# openSUSE
sudo zypper install ./focusbear-0.1.0-x86_64.rpm

# Or use AppImage (no installation)
chmod +x focusbear-0.1.0-x86_64.AppImage
./focusbear-0.1.0-x86_64.AppImage
```

---

## Architecture

Focus Bear uses a **native messaging bridge** to enable browser-based URL blocking without system-wide proxying:

```
┌──────────────────────────────────────────────────────────────┐
│ Electron App                                                 │
│ (blocklist management, Unix socket server)                   │
└────────────────────┬─────────────────────────────────────────┘
                     │ Unix Socket (/tmp/focusbear.sock)
                     │
┌────────────────────▼─────────────────────────────────────────┐
│ Native Messaging Host                                        │
│ (node process, bridges socket ↔ browser native messaging)   │
└────────────────────┬─────────────────────────────────────────┘
                     │ Native Messaging Protocol
                     │
┌────────────────────▼─────────────────────────────────────────┐
│ Browser Extension (Firefox, Chrome, Chromium, Brave, Opera)  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Why This Approach?

| Feature | Native Messaging | mitmproxy (deprecated) |
|---------|------------------|----------------------|
| Performance | ~0% overhead | 70x slowdown |
| Setup | One-click | Manual proxy + cert config |
| Security | No MITM | Requires custom CA trust |
| Sandboxing | Works with snap Firefox | Breaks with sandboxed browsers |

---

## Installation & Setup

### 1. Install via Package Manager (Recommended)

The package includes automatic dependency checking. During installation, you'll see:

```
╔════════════════════════════════════════════════════════════════╗
║          Focus Bear - Dependency Checker                       ║
╚════════════════════════════════════════════════════════════════╝

Detected package manager: apt

⚠ Found missing dependencies: 3
  - libgtk-3-0
  - libnotify4
  - libnss3

Install missing dependencies now? (requires sudo) [Y/n]
```

**Press Enter** to automatically install all dependencies.

### 2. Post-Installation Setup

**At package install (deb/rpm, runs as root):**
- Creates a `/usr/bin/focusbear` launcher script
- Installs a system-wide native host launcher at `/usr/local/bin/focusbear-native-host` and a Firefox manifest in `/usr/lib/mozilla/native-messaging-hosts/`
- Installs an optional systemd user unit (`/usr/lib/systemd/user/focusbear.service`). It is not enabled automatically: `systemctl --user enable --now focusbear`

**On every app launch (all formats, including AppImage; per user, no root needed):**
- Copies the native host to `~/.local/share/focusbear/`, along with the earlier per-browser extension (legacy)
- Writes the host launcher `~/.local/bin/focusbear-native-host`
- Writes native messaging manifests for Firefox (regular and snap), Chrome (stable, beta, unstable), Chromium, Brave and Opera. The Chromium-family manifests only allow the production extension ID (see [Development](docs/BLOCKING.md#development-setup) if you load a development build)
- Packs those legacy extensions into focusbear-extension.xpi and focusbear-extension-chrome.zip using zip (legacy)

The native host runs under `node`, so Node.js must be installed. The deb/rpm packages declare it as a dependency; AppImage users need to install it themselves.

**First launch:**
```bash
focusbear &
```

### 3. Add the Browser Extension

On first launch, the setup screen asks which browsers you use (Firefox, Chrome, Chromium, Brave or Opera) and shows where to get the **Focus Bear extension** for each one. Add the extension from the link shown. The screen confirms once the extension has connected to the app, and you can continue after every browser you selected is connected.

Developers loading unpacked builds should follow [docs/BLOCKING.md](docs/BLOCKING.md#development-setup) instead.

---

## System Dependencies

### Debian/Ubuntu

```bash
sudo apt-get install -y \
  libgtk-3-0 libglib2.0-0 libx11-6 libdbus-1-3 \
  libfontconfig1 libfreetype6 libnotify4 libnss3 \
  libxss1 libxtst6 xdg-utils libatspi2.0-0 \
  libuuid1 libsecret-1-0 python3 nodejs zip
```

### Fedora/RHEL

```bash
sudo dnf install -y \
  gtk3 glib2 libX11 dbus fontconfig freetype \
  libnotify nss libXss libXtst xdg-utils \
  at-spi2-core util-linux libsecret python3 nodejs zip
```

### openSUSE

```bash
sudo zypper install -y \
  gtk3 glib2 libX11-6 dbus-1 fontconfig freetype2 \
  libnotify1 mozilla-nss libxss1 libXtst6 xdg-utils \
  at-spi2-core util-linux libsecret-1-0 python3 nodejs zip
```

---

## Usage

### In the App

1. **Add URLs to block** under **Blocks → Super Distracting Sites**. The list is sent to every connected browser extension when you save it
2. **Start, or stop focus session** from the app or the system tray
3. Focus Bear watches the extension in each browser you selected during setup. If an extension disconnects (disabled, removed, or crashed) while its browser is running, Focus Bear shows a warning and closes that browser after 30 seconds

---

## Uninstallation

Do these in order:

1. **Clean up app data.** Open **Settings → Uninstall** and click **Clean Up App Data**. This stops any running focus session and deletes your local settings and whitelist, the native host and extension copies in `~/.local/share/focusbear/`, the `~/.local/bin/focusbear-native-host` launcher, and the native messaging manifests for every supported browser.
2. **Quit Focus Bear** (system tray → **Quit**). Do this *before* removing the extension. While the app is running, removing the extension triggers the "extension disconnected" warning, and the browser is closed after 30 seconds.
3. **Remove the browser extension** (Firefox: `about:addons`; Chromium browsers: `chrome://extensions`, `brave://extensions` or `opera://extensions`). Settings synced to your Focus Bear account are not deleted.
4. **Remove the application:**

### Via Package Manager

```bash
# Debian/Ubuntu
sudo apt-get remove focusbear

# Fedora/RHEL
sudo dnf remove focusbear

# openSUSE
sudo zypper remove focusbear

# AppImage: delete the file
rm /path/to/focusbear-*.AppImage
```

### Manual Cleanup

```bash
rm -rf ~/.local/share/focusbear
rm -f ~/.local/bin/focusbear-native-host
rm -f ~/.mozilla/native-messaging-hosts/com.focusbear.host.json
rm -f ~/snap/firefox/common/.mozilla/native-messaging-hosts/com.focusbear.host.json
rm -f ~/.config/{google-chrome,google-chrome-beta,google-chrome-unstable,chromium,opera}/NativeMessagingHosts/com.focusbear.host.json
rm -f ~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.focusbear.host.json
rm -rf "$HOME/.config/Focus Bear"    # app settings, whitelist, sign-in data and caches
rm -f /tmp/focusbear.sock
```

---

## Debugging

### Common Issues

#### Native Host Connection Failed
```bash
# Check if socket exists
ls -la /tmp/focusbear.sock

# View native host logs
tail -f /tmp/focusbear-native-host.log

# Kill stale process
pkill -f focusbear
```

#### Extension Not Connecting
```bash
# Is the host launcher in place?
ls -la ~/.local/bin/focusbear-native-host

# Does your browser's manifest exist? (Firefox shown; Chromium browsers use
# ~/.config/<browser>/NativeMessagingHosts/, see File Locations)
cat ~/.mozilla/native-messaging-hosts/com.focusbear.host.json

# Which browser did each host start detect?
grep "Detected Browser" /tmp/focusbear-native-host.log | tail
```

- Open the app once: it rewrites the launcher and manifests on every launch.
- The host runs under `node`; check `node --version` works in a normal terminal.
- Chromium browsers: if the extension console says the native host is "forbidden", the extension's ID is not the one allowed in the manifest. That happens with development builds; see [docs/BLOCKING.md](docs/BLOCKING.md#development-setup).

#### Missing Dependencies
Re-run installation; dependency checker will auto-install:

```bash
sudo apt-get install ./focusbear-0.1.0-amd64.deb  # Debian
sudo dnf install ./focusbear-0.1.0-x86_64.rpm    # Fedora
```

### Debug Commands

```bash
# View app version
focusbear --version

# Check installed packages
dpkg -l | grep focusbear        # Debian
rpm -qa | grep focusbear        # RPM

# Monitor socket connections
lsof /tmp/focusbear.sock

# View browser extension console
Firefox: about:debugging#/runtime/this-firefox → Inspect
Chrome: chrome://extensions → "Details" → "Errors"
```

---

## Building from Source

### Prerequisites

```bash
# Debian/Ubuntu
sudo apt-get install -y nodejs npm fakeroot rpm zip python3

# Fedora/RHEL
sudo dnf install -y nodejs npm fakeroot rpm zip python3

# openSUSE
sudo zypper install -y nodejs npm fakeroot rpm zip python3
```

### Build Steps

```bash
npm ci                              # Install dependencies
chmod +x build/postinst build/prerm # Make scripts executable
npm run package:full                # Build all formats
```

Output:
- `dist/focusbear-0.1.0-x86_64.AppImage` (~160 MB)
- `dist/focusbear-0.1.0-amd64.deb` (~77 MB)
- `dist/focusbear-0.1.0-x86_64.rpm` (~77 MB)

---

## Development Scripts

```bash
npm run start              # Dev mode with hot reload
npm run start:prod        # Production mode
npm run build             # Build frontend
npm run build:dev         # Build frontend (dev)
npm run package           # Package AppImage only
npm run package:all       # Package all formats (AppImage + deb)
npm run package:full      # Package all formats including RPM
npm run lint              # Run ESLint
npm run install-native-messaging  # Install native host manually
```

---

## Known Limitations

### Flatpak ❌
Flatpak sandboxing prevents:
- Writing to `/usr/local/bin/` (native host)
- Firefox native messaging (path resolution fails)
- Systemd service installation
- Per-user extension setup

**Use DEB/RPM/AppImage instead.**

### AppImage
- No systemd background service support
- No package manager auto-updates
- Use DEB/RPM for production deployments

---

## File Locations

| Component | Location |
|-----------|----------|
| App settings and data | `~/.config/Focus Bear/` (`settings.json`, `whitelist.json`, Electron data) |
| Host copy and legacy extension copies | `~/.local/share/focusbear/` |
| Native host launcher (per user) | `~/.local/bin/focusbear-native-host` |
| Native host launcher (system, deb/rpm) | `/usr/local/bin/focusbear-native-host` |
| Firefox manifest (system, deb/rpm) | `/usr/lib/mozilla/native-messaging-hosts/com.focusbear.host.json` |
| Firefox manifest (user) | `~/.mozilla/native-messaging-hosts/com.focusbear.host.json` |
| Firefox manifest (snap) | `~/snap/firefox/common/.mozilla/native-messaging-hosts/com.focusbear.host.json` |
| Chrome / Chromium / Opera manifests | `~/.config/{google-chrome,google-chrome-beta,google-chrome-unstable,chromium,opera}/NativeMessagingHosts/com.focusbear.host.json` |
| Brave manifest | `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.focusbear.host.json` |
| systemd user unit (deb/rpm) | `/usr/lib/systemd/user/focusbear.service` |
| Logs | `/tmp/focusbear-native-host.log` |
| Socket | `/tmp/focusbear.sock` (runtime only) |

---

## Documentation

- [URL Blocking Architecture](docs/BLOCKING.md) - How the native messaging system works
- [RPM Packaging Guide](docs/RPM_PACKAGING_GUIDE.md) - RPM-specific details
- [Flatpak Limitations](docs/FLATPAK_LIMITATIONS.md) - Why Flatpak won't work
- [CI/CD Pipeline](docs/PACKAGING\&CI-PIPELINE.md) - GitHub Actions setup
- [Native Messaging Guide](docs/NATIVE-MESSAGING-HOST_PACKAGING_GUIDE.md) - Full technical details

---

## Secrets

Auth0 credentials are stored in GitHub repository secrets:
- `VITE_AUTH0_DOMAIN`
- `VITE_AUTH0_CLIENT_ID`

These are automatically injected during CI builds and embedded in the production bundle.

For local development, create a `.env` file:
```env
VITE_AUTH0_DOMAIN=dev-xxxx.us.auth0.com
VITE_AUTH0_CLIENT_ID=your_client_id
```

---

## Support

- **Issues:** GitHub Issues
- **Docs:** See links above

---

## Version

**Focus Bear v0.1.0** - Linux Distraction Blocker

---

## License

Released under the [MIT License](LICENSE).

// Version comparison and release-asset choice for the update check
// (updateChecker.js). No Electron imports, so node --test covers it.

// GitHub release tags are usually "v1.2.3"; strip the prefix and split on the
// usual separators. Numeric segments compare numerically so "1.2.10" > "1.2.9";
// non-numeric segments (pre-release tags like "1.2.0-beta") fall back to
// lexicographic comparison.
export function isNewer(remote, current) {
    if (!remote || !current) return false;
    const norm = (v) => String(v).replace(/^v/i, '').split(/[.+-]/);
    const a = norm(remote);
    const b = norm(current);
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const ai = a[i] ?? '0';
        const bi = b[i] ?? '0';
        const an = Number(ai);
        const bn = Number(bi);
        if (!Number.isNaN(an) && !Number.isNaN(bn)) {
            if (an > bn) return true;
            if (an < bn) return false;
        } else {
            if (ai > bi) return true;
            if (ai < bi) return false;
        }
    }
    return false;
}

// Pick the first Linux package asset we recognise so the "Download" link goes
// straight to a usable file rather than the release page.
export function pickAsset(assets) {
    if (!Array.isArray(assets)) return '';
    const preferred = ['.AppImage', '.deb', '.rpm'];
    for (const ext of preferred) {
        const match = assets.find((a) => typeof a?.name === 'string' && a.name.toLowerCase().endsWith(ext.toLowerCase()));
        if (match?.browser_download_url) return match.browser_download_url;
    }
    return '';
}

/** One line for Settings > About describing the result of an update check. */
export function updateStatusText(result) {
    if (!result) return 'Not checked yet.';
    if (result.status === 'update-available') {
        return `Focus Bear ${result.latestVersion} is available. You have ${result.currentVersion}.`;
    }
    if (result.status === 'up-to-date') return `You have the latest version (${result.currentVersion}).`;
    // No release published yet is not something the user can fix.
    if (/HTTP 404/.test(result.error || '')) return 'No published release to compare with yet.';
    return "Couldn't check for updates. Check your internet connection and try again.";
}

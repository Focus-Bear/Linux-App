import React, { useEffect, useState } from 'react';

const DISMISS_STORAGE_KEY = 'focusbear:dismissedUpdateVersion';

const UpdateNotification = function() {
    const [status, setStatus] = useState(null);
    const [dismissedVersion, setDismissedVersion] = useState(() => {
        try { return localStorage.getItem(DISMISS_STORAGE_KEY) || ''; }
        catch { return ''; }
    });

    useEffect(() => {
        if (!window.api) return undefined;

        window.api.getLastUpdateStatus?.().then((cached) => {
            if (cached) setStatus(cached);
        }).catch(() => {});

        const unsubscribe = window.api.onUpdateStatus?.((next) => {
            setStatus(next);
        });

        return () => {
            if (typeof unsubscribe === 'function') unsubscribe();
        };
    }, []);

    if (!status || status.status !== 'update-available') return null;
    if (status.latestVersion && status.latestVersion === dismissedVersion) return null;

    const handleDownload = () => {
        if (status.downloadUrl && window.api?.openUpdateDownload) {
            window.api.openUpdateDownload(status.downloadUrl);
        }
    };

    const handleDismiss = () => {
        try { localStorage.setItem(DISMISS_STORAGE_KEY, status.latestVersion || ''); }
        catch { /* ignore storage failures */ }
        setDismissedVersion(status.latestVersion || '');
    };

    // Themed banner (tokens.css), so it reads in dark mode too.
    return (
        <div className="fb-update-banner" role="status" aria-live="polite">
            <span>
                <strong>Focus Bear {status.latestVersion}</strong> is available
                {status.currentVersion ? ` (you have ${status.currentVersion})` : ''}.
            </span>
            <div className="fb-row">
                {status.downloadUrl && (
                    <button type="button" className="fb-btn fb-btn--primary fb-btn--small" onClick={handleDownload}>
                        Download
                    </button>
                )}
                <button type="button" className="fb-btn fb-btn--gray fb-btn--small" onClick={handleDismiss}>
                    Dismiss
                </button>
            </div>
        </div>
    );
};

export default UpdateNotification;

// How an embedded dashboard page reports back to the app. The pages call
// window.chrome.webview.postMessage (the Windows app's WebView2 channel). The
// Linux views have no preload, so the page gets a stand-in that writes the
// message to the console with a marker; the main process picks it up there and
// hands it to the window ('webview-message').
//
// No Electron imports, so this can be unit tested.

export const MESSAGE_MARK = '__focusbear_webview_message__';

/** Script run in the page on every load. */
export const MESSAGE_SHIM = `
    (function() {
        if (window.__focusBearMessageShim) return;
        window.__focusBearMessageShim = true;
        var send = function(message) {
            try { console.log('${MESSAGE_MARK}' + JSON.stringify(message === undefined ? null : message)); } catch (e) { /* not serialisable */ }
        };
        try {
            window.chrome = window.chrome || {};
            window.chrome.webview = window.chrome.webview || {};
            window.chrome.webview.postMessage = send;
        } catch (e) { /* read-only */ }
    })();
`;

/** The message a page sent through the stand-in, or undefined for an ordinary console line. */
export function parseWebViewMessage(line) {
    if (typeof line !== 'string' || !line.startsWith(MESSAGE_MARK)) return undefined;
    try {
        return JSON.parse(line.slice(MESSAGE_MARK.length));
    } catch {
        return undefined;
    }
}

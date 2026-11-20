// Dashboard pages the app embeds as WebContentsViews, keyed by the id the
// renderer asks for (window.api.switchWebView(id, ...)). Kept free of Electron
// imports so the renderer's navigation tests can check ids against it.
//
// URLs match the Windows app (e.g. Preferences/EditHabits.xaml.cs uses
// /webview/settings, Focus/ToDoList.xaml.cs uses /webview/tools-todo-list).
export const webViewConfigs = {
    'edit_habits': {
        url: 'https://dashboard.focusbear.io/webview/settings'
    },
    'courses': {
        url: 'https://dashboard.focusbear.io/webview/enrolled-courses'
    },
    'get_support': {
        url: 'https://dashboard.focusbear.io/webview/get-support'
    },
    'upgrade-now': {
        // /webview/…, as in the Windows app (Upgrade/ManageSubscription.xaml.cs).
        // Without it the dashboard stays on "Focus Bear is waking up...".
        url: 'https://dashboard.focusbear.io/webview/manage-subscription'
    },
    'todo-player': {
        url: 'https://dashboard.focusbear.io/webview/todo-player'
    },
    'todo-list': {
        url: 'https://dashboard.focusbear.io/webview/tools-todo-list'
    },
    'focus-end': {
        url: 'https://dashboard.focusbear.io/webview/focus-end'
    },
    'motivation': {
        url: 'https://dashboard.focusbear.io/webview/motivational-summary'
    },
    'stats': {
        url: 'https://dashboard.focusbear.io/webview/stats'
    },
    'survey': {
        url: 'https://dashboard.focusbear.io/webview/survey'
    },
};

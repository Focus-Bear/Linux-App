// Every IPC handler of the main process checks who is asking.
//
// The handlers (settings, focus session, blocking, clean-up, ...) used to
// answer any page that had the preload API. This module wraps `ipcMain.handle`
// and `ipcMain.on` so a message is only passed on when it comes from one of
// the app's own pages (see isTrustedSender in security.js). It must be the
// first import of main.js: modules imported after it (Blocker.js) register
// their handlers through the wrapped functions.
import { app, ipcMain } from 'electron';
import { isTrustedSender } from './security.js';

export function senderIsTrusted(event) {
  const frame = event && event.senderFrame;
  const url = (frame && frame.url) || (event && event.sender && event.sender.getURL && event.sender.getURL()) || '';
  return isTrustedSender(url, { dev: !app.isPackaged, appPath: app.getAppPath() });
}

const refused = (channel, event) => {
  const url = (event && event.senderFrame && event.senderFrame.url) || '';
  let origin = '(unknown)';
  try {
    origin = new URL(url).origin;
  } catch {
    // keep (unknown)
  }
  console.error(`[IPC] Refused "${channel}" from ${origin}`);
};

const handle = ipcMain.handle.bind(ipcMain);
const on = ipcMain.on.bind(ipcMain);

ipcMain.handle = (channel, listener) =>
  handle(channel, (event, ...args) => {
    if (!senderIsTrusted(event)) {
      refused(channel, event);
      throw new Error('Not allowed');
    }
    return listener(event, ...args);
  });

ipcMain.on = (channel, listener) =>
  on(channel, (event, ...args) => {
    if (!senderIsTrusted(event)) {
      refused(channel, event);
      return undefined;
    }
    return listener(event, ...args);
  });

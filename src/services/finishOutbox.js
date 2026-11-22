// The finish outbox bound to this window: localStorage and the signed-in user
// (see finishOutboxCore.js).
import { focusApi } from './focusApi.js';
import { nativeAuthService } from './nativeAuth.js';
import { OUTBOX_KEY, createFinishOutbox } from './finishOutboxCore.js';

export const finishOutbox = createFinishOutbox({
  storage: {
    read: () => window.localStorage.getItem(OUTBOX_KEY),
    write: (text) => window.localStorage.setItem(OUTBOX_KEY, text),
  },
  send: (session) => focusApi.finishSession(session),
});

export const currentUserId = () => nativeAuthService.getUser()?.sub || '';

/** Sends whatever is waiting for the signed-in account. Never throws. */
export const flushFinishes = () => finishOutbox.flush(currentUserId()).catch(() => finishOutbox.pending(currentUserId()));

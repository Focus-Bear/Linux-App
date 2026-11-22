// The account's block lists and blocking schedules in the window, shared by
// the Blocking pages, the focus start screen and the shell (which tells the
// main process what to block; see src/ui/useBlocking.js). The store's logic is
// in blockingStoreCore.js.
import { useSyncExternalStore } from 'react';
import { habitApi } from './habitApi.js';
import { createBlockingApi } from './blockingApiCore.js';
import { createBlockingStore } from './blockingStoreCore.js';

export const blockingApi = createBlockingApi({
  request: (...args) => habitApi.request(...args),
  getDeviceId: () => habitApi.registerDevice(),
});

export const blockingStore = createBlockingStore({ api: blockingApi });

/** { status, modes, schedules, error, stale } */
export function useBlockingStore() {
  return useSyncExternalStore(blockingStore.subscribe, blockingStore.get);
}

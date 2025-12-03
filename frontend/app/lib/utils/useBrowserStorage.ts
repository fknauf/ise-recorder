import { useEffect, useSyncExternalStore } from "react";
import { gatherBrowserStorageInfo, BrowserStorage } from "./filesystem";

const browserStorageObservers = new Set<() => void>();
let currentBrowserStorageInfo: BrowserStorage = { recordings: [] };

/**
 * Every file system operation that changes the result of gatherBrowserStorageInfo needs to call this to
 * update all subscribed components.
 *
 * In the future this should probably use https://developer.mozilla.org/en-US/docs/Web/API/FileSystemObserver,
 * but at the moment that is experimental and only available in chromium.
 */
export async function updateBrowserStorageInfo() {
  currentBrowserStorageInfo = await gatherBrowserStorageInfo();

  for(const callback of browserStorageObservers) {
    callback();
  }
}

function subscribeToBrowserStorage(onStoreChange: () => void) {
  browserStorageObservers.add(onStoreChange);
  return () => browserStorageObservers.delete(onStoreChange);
}

const getCurrentBrowserStorageInfo = () => currentBrowserStorageInfo;

/**
 * UI hook to get the current browser storage information and be re-rendered when it changes.
 */
export function useBrowserStorage() {
  // gather browser storage info on first client-side render
  useEffect(() => {
    updateBrowserStorageInfo();
  }, []);

  return useSyncExternalStore(subscribeToBrowserStorage, getCurrentBrowserStorageInfo, getCurrentBrowserStorageInfo);
}

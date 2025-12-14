"use client";

import { StateCreator } from "zustand";
import { AppStoreState } from "./store";
import { gatherRecordingsList, RecordingFileList } from "../utils/browserStorage";

export interface BrowserStorageState {
  quota: number | undefined
  usage: number | undefined
  savedRecordings: readonly RecordingFileList[]

  updateBrowserStorage: () => Promise<void>
  updateQuotaInformation: () => Promise<void>
}

export const createBrowserStorageSlice: StateCreator<
  AppStoreState,
  [],
  [],
  BrowserStorageState
> = set => ({
  quota: undefined,
  usage: undefined,
  savedRecordings: [],

  updateQuotaInformation: async () => {
    const { quota, usage } = await navigator.storage.estimate();
    set({ quota, usage });
  },

  updateBrowserStorage: async () => {
    const [ fs, recordings ] = await Promise.all([
      navigator.storage.estimate(),
      gatherRecordingsList()
    ]);

    set({
      quota: fs.quota,
      usage: fs.usage,
      savedRecordings: recordings
    });
  }
});

"use client";

import { deleteRecording } from "../utils/browserStorage";
import { useAppStore } from "./useAppStore";

/**
 * UI hook to get the current browser storage information and be re-rendered when it changes.
 */
export function useBrowserStorage() {
  const quota = useAppStore(state => state.quota);
  const usage = useAppStore(state => state.usage);
  const adjustedRecordings = useAppStore(state => state.adjustedSavedRecordings);

  const updateBrowserStorage = useAppStore(state => state.updateBrowserStorage);

  const removeSavedRecording = async (recordingName: string) => {
    await deleteRecording(recordingName);
    await updateBrowserStorage();
  };

  return {
    quota,
    usage,
    savedRecordings: adjustedRecordings,
    removeSavedRecording
  };
}



"use client";

import { useEffect } from "react";
import { deleteRecording, RecordingFileInfo, RecordingFileList } from "../utils/browserStorage";
import { useAppStore } from "./useAppStore";
import { fileSizeOverrideKey } from "../store/activeRecordingSlice";

/**
 * UI hook to get the current browser storage information and be re-rendered when it changes.
 */
export function useBrowserStorage() {
  const quota = useAppStore(state => state.quota);
  const usage = useAppStore(state => state.usage);
  const savedRecordings = useAppStore(state => state.savedRecordings);
  const fileSizeOverrides = useAppStore(state => state.fileSizeOverrides);

  const updateBrowserStorage = useAppStore(state => state.updateBrowserStorage);

  useEffect(() => {
    // gather browser storage info on first client-side render
    updateBrowserStorage();
  }, [ updateBrowserStorage ]);

  // Replace sizes for files that are currently being written to with our own byte count; OPFS
  // only reports their size after the corresponding stream is closed.
  const adjustedRecordings = savedRecordings.map(rec => <RecordingFileList> {
    ...rec,
    files: rec.files.map(file => <RecordingFileInfo> {
      ...file,
      size: fileSizeOverrides.get(fileSizeOverrideKey(rec.name, file.name)) ?? file.size
    })
  });

  const removeSavedRecording = (recordingName: string) => {
    deleteRecording(recordingName);
    updateBrowserStorage();
  };

  return {
    quota,
    usage,
    savedRecordings: adjustedRecordings,
    removeSavedRecording
  };
}

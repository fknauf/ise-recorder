"use client";

import { deleteRecording, getAllRecordingTracks } from "../utils/browserStorage";
import { useAppStore } from "./useAppStore";
import { schedulePostprocessing, uploadFile } from "../utils/serverStorage";
import { useServerEnv } from "./useServerEnv";
import { useAppSession } from "../components/SessionProvider";
import { showError } from "../utils/notifications";
import { useLecture } from "./useLecture";
import { useRefreshProcessedRecordings } from "./useProcessedRecordings";

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

export function useReuploadSavedRecording() {
  const { apiUrl } = useServerEnv();
  const { getAccessToken } = useAppSession();
  const { lecturerEmail } = useLecture();

  const signalManualUploadProgress = useAppStore(state => state.signalManualUploadProgress);
  const signalManualUploadFinished = useAppStore(state => state.signalManualUploadFinished);
  const refreshProcessedRecordings = useRefreshProcessedRecordings();

  const reuploadSavedRecording = async (recordingName: string) => {
    signalManualUploadProgress(recordingName, 0);

    const uploadName = `${recordingName}-reupload`;
    const destination = {
      apiUrl,
      getAccessToken,
      streamingImpeded: false
    };

    const retryPolicy = {
      retries: 3,
      intervalMillis: 20000
    };

    try {
      const trackBlobs = await getAllRecordingTracks(recordingName);
      const totalBytes = trackBlobs.reduce((acc, cur) => acc + cur.file.size, 0);
      let transferred = 0;

      const signalProgress = (sentBytes: number) => {
        transferred += sentBytes;
        signalManualUploadProgress(recordingName, transferred / totalBytes * 100);
      };

      const uploadTracks = async () => {
        for(const { trackName, file } of trackBlobs) {
          const succeeded = await uploadFile(destination, file, uploadName, trackName, signalProgress, retryPolicy);

          if(!succeeded) {
            showError(`Failed manual upload of ${uploadName} track ${trackName}, aborting.`);
            return false;
          }
        }

        return true;
      };

      if(trackBlobs.length === 0) {
        showError(`Nothing to upload for ${recordingName}`);
      } else if(await uploadTracks()) {
        await schedulePostprocessing(destination, uploadName, lecturerEmail, retryPolicy);
      }
    } catch(e) {
      console.error(`Unexpected error during manual upload of ${uploadName}`, e);
      showError(`Manual upload of ${uploadName} failed`);
    }

    signalManualUploadFinished(recordingName);
    refreshProcessedRecordings();
  };

  return reuploadSavedRecording;
}

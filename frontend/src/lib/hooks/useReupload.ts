import { useAppSession } from "../components/SessionProvider";
import { getAllRecordingTracks } from "../utils/browserStorage";
import { showError, showSuccess } from "../utils/notifications";
import { ApiDestination, defaultRetryPolicy, RetryPolicy, withRetries } from "../utils/apiFetch";
import { uploadFile, schedulePostprocessing } from "../utils/serverStorage";
import { useAppStore } from "./useAppStore";
import { useLecture } from "./useLecture";
import { useRefreshServerStorage } from "./useServerStorage";
import { useServerEnv } from "./useServerEnv";

export function useReupload(recordingName: string) {
  const { apiUrl } = useServerEnv();
  const { getAccessToken } = useAppSession();
  const { lecturerEmail } = useLecture();
  const progress = useAppStore(state => state.reuploadProgress.get(recordingName));

  const signalManualUploadProgress = useAppStore(state => state.signalManualUploadProgress);
  const signalManualUploadFinished = useAppStore(state => state.signalManualUploadFinished);
  const refreshProcessedRecordings = useRefreshServerStorage();

  const reupload = async () => {
    if(apiUrl === undefined) {
      console.warn(`Attempted reupload of ${recordingName}, but no backend is configured`);
      return;
    }

    signalManualUploadProgress(recordingName, 0);

    const uploadName = `${recordingName}-reupload`;
    const destination: ApiDestination = {
      apiUrl,
      getAccessToken
    };

    const retryPolicy: RetryPolicy = {
      ...defaultRetryPolicy,
      retries: 3,
      initialWaitMillis: 10000
    };

    let completed = false;

    try {
      const trackBlobs = await getAllRecordingTracks(recordingName);
      // max(1, ...) to avoid division by zero. If all files are empty, the progress indicator is meaningless, anyway.
      const totalBytes = Math.max(1, trackBlobs.reduce((acc, cur) => acc + cur.file.size, 0));
      let transferred = 0;

      const signalProgress = (sentBytes: number) => {
        transferred += sentBytes;
        signalManualUploadProgress(recordingName, transferred / totalBytes * 100);
      };

      const uploadTracks = async () => {
        for(const { trackName, file } of trackBlobs) {
          try {
            await uploadFile(destination, file, uploadName, trackName, retryPolicy, signalProgress);
          } catch(e) {
            showError(`Failed manual upload of ${uploadName} track ${trackName}`, e);
            return false;
          }
        }

        return true;
      };

      if(trackBlobs.length === 0) {
        showError(`Nothing to upload for ${recordingName}`);
      } else if(await uploadTracks()) {
        // report ok if all tracks are uploaded even if post-processing can't be scheduled. User doesn't need to
        // re-upload then, just re-render.
        completed = true;

        try {
          await withRetries(() => schedulePostprocessing(destination, uploadName, lecturerEmail, undefined), retryPolicy);
          showSuccess(`Scheduled postprocessing for recording "${uploadName}"`);
        } catch(e) {
          showError("Failed to schedule postprocessing", e);
        }
      }
    } catch(e) {
      console.error(`Unexpected error during manual upload of ${uploadName}`, e);
      showError(`Manual upload of ${uploadName} failed`, e);
    }

    signalManualUploadFinished(recordingName, completed);
    refreshProcessedRecordings();
  };

  return {
    isUploading: progress !== undefined,
    progress,
    reupload
  };
}

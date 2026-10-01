import { useAppSession } from "../components/SessionProvider";
import { getAllRecordingTracks } from "../utils/browserStorage";
import { showError, showSuccess } from "../utils/notifications";
import { uploadFile, schedulePostprocessing, RetryPolicy, UploadStatus } from "../utils/serverStorage";
import { useAppStore } from "./useAppStore";
import { useLecture } from "./useLecture";
import { useRefreshProcessedRecordings } from "./useProcessedRecordings";
import { useServerEnv } from "./useServerEnv";

export function useReupload(recordingName: string) {
  const { apiUrl } = useServerEnv();
  const { getAccessToken } = useAppSession();
  const { lecturerEmail } = useLecture();
  const progress = useAppStore(state => state.reuploadProgress.get(recordingName));

  const signalManualUploadProgress = useAppStore(state => state.signalManualUploadProgress);
  const signalManualUploadFinished = useAppStore(state => state.signalManualUploadFinished);
  const refreshProcessedRecordings = useRefreshProcessedRecordings();

  const reupload = async () => {
    signalManualUploadProgress(recordingName, 0);

    const uploadName = `${recordingName}-reupload`;
    const destination = {
      apiUrl,
      getAccessToken
    };

    let finalStatus: UploadStatus = "failed";

    const retryPolicy: RetryPolicy = {
      retries: 3,
      initialWaitMillis: 10000
    };

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
          const fileResult = await uploadFile(destination, file, uploadName, trackName, retryPolicy, signalProgress);

          if(fileResult.status !== "ok") {
            showError(`Failed manual upload of ${uploadName} track ${trackName}: ${fileResult.message ?? "unknown error"}`);
            finalStatus = fileResult.status;
            return false;
          }
        }

        // report ok if all tracks are uploaded even if post-processing can't be scheduled. User doesn't need to
        // re-upload then, just re-render.
        finalStatus = "ok";
        return true;
      };

      if(trackBlobs.length === 0) {
        showError(`Nothing to upload for ${recordingName}`);
      } else if(await uploadTracks()) {
        const postResult = await schedulePostprocessing(destination, uploadName, lecturerEmail, retryPolicy);

        if(postResult.status === "ok") {
          showSuccess(`Scheduled postprocessing for recording "${uploadName}"`);
        } else {
          showError(`Failed to schedule postprocessing: ${postResult.message}.`);
        }
      }
    } catch(e) {
      console.error(`Unexpected error during manual upload of ${uploadName}`, e);
      showError(`Manual upload of ${uploadName} failed`);
    }

    signalManualUploadFinished(recordingName, finalStatus);
    refreshProcessedRecordings();
  };

  return {
    isUploading: progress !== undefined,
    progress,
    reupload
  };
}

import { useAppSession } from "../components/SessionProvider";
import { getAllRecordingTracks } from "../utils/browserStorage";
import { showError } from "../utils/notifications";
import { uploadFile, schedulePostprocessing } from "../utils/serverStorage";
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
      getAccessToken,
      streamingImpeded: false
    };

    const retryPolicy = {
      retries: 3,
      intervalMillis: 20000
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

  return {
    isUploading: progress !== undefined,
    progress,
    reupload
  };
}

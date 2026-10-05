"use client";

import { useAppStore } from "./useAppStore";
import { RecordingDestination, recordLecture } from "../utils/recording";
import { useLecture } from "./useLecture";
import { useServerEnv } from "./useServerEnv";
import { useMediaTracks } from "./useMediaTracks";
import { showError } from "../utils/notifications";
import { SessionTransition, useAppSession } from "../components/SessionProvider";
import { useRefreshServerStorage } from "./useServerStorage";

function preventClosing(e: BeforeUnloadEvent) {
  e.preventDefault();
}

// extracted into a function to work around a react compiler limitation where && and || in try blocks cause it to bail.
const streamingDestination = (
  apiUrl: string | undefined,
  sessionState: SessionTransition,
  getAccessToken: () => Promise<string | undefined>
): RecordingDestination =>
  ({
    apiUrl,
    impeded: apiUrl !== undefined && sessionState === "cannot-stream",
    getAccessToken
  });

export const useActiveRecording = () => useAppStore(state => state.activeRecording);

export function useStartStopRecording() {
  const selectFromStore = useAppStore(state => state.selectFromStore);
  const setActiveRecording = useAppStore(state => state.setActiveRecording);
  const resetFileSizeOverrides = useAppStore(state => state.resetFileSizeOverrides);
  const updateBrowserStorage = useAppStore(state => state.updateBrowserStorage);
  const updateQuotaInformation = useAppStore(state => state.updateQuotaInformation);
  const overrideFileSize = useAppStore(state => state.overrideFileSize);
  const refreshProcessedRecordings = useRefreshServerStorage();
  const markUnstreamed = useAppStore(state => state.markUnstreamed);

  const {
    lectureTitle,
    lecturerEmail
  } = useLecture();

  const trackBundle = useMediaTracks();

  const {
    apiUrl
  } = useServerEnv();

  const {
    getAccessToken,
    expandSession
  } = useAppSession();

  const startRecording = async () => {
    const activeRecording = selectFromStore(state => state.activeRecording);
    if(activeRecording.state !== "idle") {
      return;
    }

    setActiveRecording({ state: "preparing" });

    try {
      const sessionState = await expandSession();

      const onStarting = (recordingName: string) => {
        setActiveRecording({
          state: "starting",
          name: recordingName
        });
        // Prevent accidental closing of the tab while recording
        window.addEventListener("beforeunload", preventClosing);
      };

      const onStarted = async (recordingName: string, stopFunction: () => void) => {
        setActiveRecording({
          state: "recording",
          name: recordingName,
          stop: stopFunction
        });

        await updateBrowserStorage();
      };

      const onChunkWritten = (recordingName: string, filename: string, chunkSize: number) => {
        overrideFileSize(recordingName, filename, oldSize => oldSize + chunkSize);
        // no need to await, we can continue before the quota warning updates
        updateQuotaInformation();
      };

      const onFinished = async () => {
        window.removeEventListener("beforeunload", preventClosing);
        // make sure the new file sizes are there before throwing away the overrides
        await updateBrowserStorage();
        resetFileSizeOverrides();
        refreshProcessedRecordings();
      };

      const onStreamingFailed = markUnstreamed;

      await recordLecture(
        trackBundle,
        lectureTitle, lecturerEmail,
        streamingDestination(apiUrl, sessionState, getAccessToken),
        onStarting, onStarted, onChunkWritten, onFinished, onStreamingFailed
      );
    } catch(e) {
      showError("Recording failed", e);
    }

    setActiveRecording({ state: "idle" });
  };

  const stopRecording = () => {
    const current = selectFromStore(state => state.activeRecording);

    if(current.state === "recording") {
      current.stop();
      setActiveRecording({ name: current.name, state: "stopping" });
    } else {
      console.warn("attempted to stop recording while recorder wasn't recording");
    }
  };

  return {
    startRecording,
    stopRecording
  };
}

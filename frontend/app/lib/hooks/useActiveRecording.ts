"use client";

import { useAppStore } from "./useAppStore";
import { recordLecture } from "../utils/recording";
import { useLecture } from "./useLecture";
import { useServerEnv } from "./useServerEnv";
import { useMediaTracks } from "./useMediaTracks";

function preventClosing(e: BeforeUnloadEvent) {
  e.preventDefault();
}

export const useActiveRecording = () => useAppStore(state => state.activeRecording);

export function useStartStopRecording() {
  const activeRecording = useActiveRecording();

  const setActiveRecording = useAppStore(state => state.setActiveRecording);
  const resetFileSizeOverrides = useAppStore(state => state.resetFileSizeOverrides);
  const updateBrowserStorage = useAppStore(state => state.updateBrowserStorage);
  const updateQuotaInformation = useAppStore(state => state.updateQuotaInformation);
  const overrideFileSize = useAppStore(state => state.overrideFileSize);

  const {
    lectureTitle,
    lecturerEmail
  } = useLecture();

  const {
    displayTracks,
    videoTracks,
    audioTracks,
    mainDisplay,
    overlay
  } = useMediaTracks();

  const {
    apiUrl
  } = useServerEnv();

  const startRecording = () => {
    if(activeRecording.state !== "idle") {
      return;
    }

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
      setActiveRecording({ state: "idle" });
    };

    recordLecture(
      displayTracks, videoTracks, audioTracks, mainDisplay, overlay,
      lectureTitle, lecturerEmail, apiUrl,
      onStarting, onStarted, onChunkWritten, onFinished
    );
  };

  const stopRecording = () => {
    setActiveRecording(prev => {
      if(prev.state !== "recording") {
        console.warn("attempted to stop recording while recorder wasn't recording");
        return prev;
      }

      prev.stop();
      return {
        ...prev,
        state: "stopping"
      };
    });
  };

  return {
    startRecording,
    stopRecording
  };
}

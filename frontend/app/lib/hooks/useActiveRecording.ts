import { useState } from "react";
import { useMediaStreams } from "./useMediaStreams";
import { useServerEnv } from "./useServerEnv";
import { useShallow } from "zustand/shallow";
import useLocalStorageState from "use-local-storage-state";
import { recordLecture } from "../utils/recording";

type ActiveRecording = {
  state: "idle"
  name?: undefined
} | {
  state: "starting" | "stopping"
  name: string
} | {
  state: "recording"
  name: string
  stop: () => void
};

function preventClosing(e: BeforeUnloadEvent) {
  e.preventDefault();
}

export function useActiveRecording(): [ ActiveRecording, () => void, () => void ] {
  const [ activeRecording, setActiveRecording ] = useState<ActiveRecording>({ state: "idle" });

  const [ lectureTitle ] = useLocalStorageState<string>("lecture-title", { defaultValue: "", storageSync: false });
  const [ lecturerEmail ] = useLocalStorageState<string>("lecturer-email", { defaultValue: "", storageSync: false });

  const displayTracks = useMediaStreams(useShallow(state => state.displayTracks));
  const videoTracks = useMediaStreams(useShallow(state => state.videoTracks));
  const audioTracks = useMediaStreams(useShallow(state => state.audioTracks));
  const mainDisplay = useMediaStreams(useShallow(state => state.mainDisplay));
  const overlay = useMediaStreams(useShallow(state => state.overlay));

  const serverEnv = useServerEnv();

  const startRecording = () => {
    const onStarting = (recordingName: string) => {
      setActiveRecording({ state: "starting", name: recordingName });
      // Prevent accidental closing of the tab while recording
      window.addEventListener("beforeunload", preventClosing);
    };

    const onStarted = (recordingName: string, stopFunction: () => void) => {
      setActiveRecording({ state: "recording", name: recordingName, stop: stopFunction });
    };

    const onFinished = async () => {
      window.removeEventListener("beforeunload", preventClosing);
      setActiveRecording({ state: "idle" });
    };

    recordLecture(
      displayTracks, videoTracks, audioTracks, mainDisplay, overlay,
      lectureTitle, lecturerEmail, serverEnv?.apiUrl,
      onStarting, onStarted, onFinished
    );
  };

  const stopRecording = () => {
    // This way stopRecording does not depend on activeRecording, so the React compiler can better optimize it.
    setActiveRecording(prev => {
      if(prev.state !== "recording") {
        console.warn("attempted to stop recording while recorder wasn't recording");
        return prev;
      }

      prev.stop();
      return { state: "stopping", name: prev.name };
    });
  };

  return [
    activeRecording,
    activeRecording.state === "idle" ? startRecording : () => {},
    stopRecording
  ];
}

"use client";

import { Flex, ToastContainer } from "@adobe/react-spectrum";
import { Dispatch, SetStateAction, useState } from "react";
import { QuotaWarning } from "./lib/components/QuotaWarning";
import { RecorderControls } from "./lib/components/RecorderControls";
import { SavedRecordingsSection } from "./lib/components/SavedRecordingsSection";
import { deleteRecording, downloadFile } from "./lib/utils/browserStorage";
import { recordLecture } from "./lib/utils/recording";
import { PreviewSection } from "./lib/components/PreviewSection";
import { useServerEnv } from "./lib/components/ServerEnvProvider";
import useLocalStorageState from "use-local-storage-state";
import { useBrowserStorage } from "./lib/utils/useBrowserStorage";

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

const preventClosing = (e: BeforeUnloadEvent) => e.preventDefault();

export default function Home() {
  ////////////////
  // hooks
  ////////////////

  const [ lectureTitle, setLectureTitle ] = useLocalStorageState<string>("lecture-title", { defaultValue: "", storageSync: false });
  const [ lecturerEmail, setLecturerEmail ] = useLocalStorageState<string>("lecturer-email", { defaultValue: "", storageSync: false });

  const [ videoTracks, setVideoTracks ] = useState<MediaStreamTrack[]>([]);
  const [ audioTracks, setAudioTracks ] = useState<MediaStreamTrack[]>([]);
  const [ displayTracks, setDisplayTracks ] = useState<MediaStreamTrack[]>([]);
  const [ mainDisplay, setMainDisplay ] = useState<MediaStreamTrack | null>(null);
  const [ overlay, setOverlay ] = useState<MediaStreamTrack | null>(null);

  const [ activeRecording, setActiveRecording ] = useState<ActiveRecording>({ state: "idle" });
  const browserStorage = useBrowserStorage();
  const serverEnv = useServerEnv();

  ////////////////
  // logic
  ////////////////

  const apiUrl = serverEnv?.apiUrl;

  // should only ever be one video track, but let's just grab all just in case. user can
  // still remove them manually if there happen to be more.
  const addGenericTracks = (
    tracks: MediaStreamTrack[],
    setTracks: Dispatch<SetStateAction<MediaStreamTrack[]>>
  ) => {
    setTracks(prevTracks => [ ...prevTracks, ...tracks ]);

    for(const track of tracks) {
      // Remove a track if it ends even if we weren't the ones to end it. This can happen if the user unplugs a device or revokes permissions.
      track.onended = () => {
        setMainDisplay(prevMain => (prevMain === track ? null : prevMain));
        setOverlay(prevOverlay => (prevOverlay === track ? null : prevOverlay));
        setTracks(prevTracks => prevTracks.filter(t => t !== track));
      };
    }
  };

  const addDisplayTracks = (tracks: MediaStreamTrack[]) => {
    addGenericTracks(tracks, setDisplayTracks);
    // Usually the first/only captured screen is supposed to be the main display
    setMainDisplay(prevMain => (prevMain === null ? tracks.at(0) ?? null : prevMain));
  };

  const addVideoTracks = (tracks: MediaStreamTrack[]) => {
    addGenericTracks(tracks, setVideoTracks);
    // usually the first/only captured camera is supposed to be the overlay
    setOverlay(prevOverlay => (prevOverlay === null ? tracks.at(0) ?? null : prevOverlay));
  };

  const addAudioTracks = (tracks: MediaStreamTrack[]) => {
    addGenericTracks(tracks, setAudioTracks);
  };

  const removeTrack = (track: MediaStreamTrack) => {
    // Track is removed on the "ended" event. The event doesn't fire automatically when we stop the stream ourselves, so we fire it manually.
    track.stop();
    track.dispatchEvent(new Event("ended"));
  };

  const startRecording = () => {
    if(activeRecording.state !== "idle") {
      return;
    }

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
      lectureTitle, lecturerEmail, apiUrl,
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

  ////////////////
  // view
  ////////////////

  return (
    <Flex direction="column" width="100vw" height="100vh" gap="size-100">
      <RecorderControls
        lectureTitle={lectureTitle}
        lecturerEmail={lecturerEmail}
        hasEmailField={apiUrl !== undefined}
        recorderState={activeRecording.state}
        currentVideoTracks={videoTracks}
        currentAudioTracks={audioTracks}
        onLectureTitleChanged={setLectureTitle}
        onLecturerEmailChanged={setLecturerEmail}
        onAddDisplayTracks={addDisplayTracks}
        onAddVideoTracks={addVideoTracks}
        onAddAudioTracks={addAudioTracks}
        onStartRecording={startRecording}
        onStopRecording={stopRecording}
      />

      <QuotaWarning
        usage={browserStorage.usage}
        quota={browserStorage.quota}
      />

      <PreviewSection
        displayTracks={displayTracks}
        videoTracks={videoTracks}
        audioTracks={audioTracks}
        mainDisplay={mainDisplay}
        overlay={overlay}
        canvasWidth={384}
        canvasHeight={216}
        hasDisabledButtons={activeRecording.state !== "idle"}
        onMainDisplayChanged={setMainDisplay}
        onOverlayChanged={setOverlay}
        onRemoveTrack={removeTrack}
      />

      <SavedRecordingsSection
        recordings={browserStorage.recordings}
        activeRecordingName={activeRecording.name}
        onRemoved={deleteRecording}
        onDownload={downloadFile}
      />

      <ToastContainer/>
    </Flex>
  );
}

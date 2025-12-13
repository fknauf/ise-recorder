"use client";

import { Flex, ToastContainer } from "@adobe/react-spectrum";
import { QuotaWarning } from "./lib/components/QuotaWarning";
import { RecorderControls } from "./lib/components/RecorderControls";
import { SavedRecordingsSection } from "./lib/components/SavedRecordingsSection";
import { deleteRecording, downloadFile } from "./lib/utils/browserStorage";
import { PreviewSection } from "./lib/components/PreviewSection";
import { useServerEnv } from "./lib/hooks/useServerEnv";
import useLocalStorageState from "use-local-storage-state";
import { useBrowserStorage } from "./lib/hooks/useBrowserStorage";
import { useMediaStreams } from "./lib/hooks/useMediaStreams";
import { useShallow } from "zustand/shallow";
import { useActiveRecording } from "./lib/hooks/useActiveRecording";

export default function Home() {
  ////////////////
  // hooks
  ////////////////

  const [ lectureTitle, setLectureTitle ] = useLocalStorageState<string>("lecture-title", { defaultValue: "", storageSync: false });
  const [ lecturerEmail, setLecturerEmail ] = useLocalStorageState<string>("lecturer-email", { defaultValue: "", storageSync: false });

  const [ activeRecording, startRecording, stopRecording ] = useActiveRecording();

  const browserStorage = useBrowserStorage();
  const serverEnv = useServerEnv();

  const videoDevices = useMediaStreams(useShallow(state => state.videoDevices));
  const audioDevices = useMediaStreams(useShallow(state => state.audioDevices));
  const displayTracks = useMediaStreams(useShallow(state => state.displayTracks));
  const videoTracks = useMediaStreams(useShallow(state => state.videoTracks));
  const audioTracks = useMediaStreams(useShallow(state => state.audioTracks));
  const mainDisplay = useMediaStreams(useShallow(state => state.mainDisplay));
  const overlay = useMediaStreams(useShallow(state => state.overlay));

  const refreshMediaDevices = useMediaStreams(useShallow(state => state.refreshMediaDevices));
  const openDisplayStream = useMediaStreams(useShallow(state => state.openDisplayStream));
  const openVideoStream = useMediaStreams(useShallow(state => state.openVideoStream));
  const openAudioStream = useMediaStreams(useShallow(state => state.openAudioStream));
  const selectMainDisplay = useMediaStreams(useShallow(state => state.selectMainDisplay));
  const selectOverlay = useMediaStreams(useShallow(state => state.selectOverlay));
  const removeTrack = useMediaStreams(useShallow(state => state.removeTrack));

  ////////////////
  // logic
  ////////////////

  const apiUrl = serverEnv?.apiUrl;

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
        videoDevices={videoDevices}
        audioDevices={audioDevices}
        onLectureTitleChanged={setLectureTitle}
        onLecturerEmailChanged={setLecturerEmail}
        onOpenDeviceMenu={refreshMediaDevices}
        onAddDisplayTrack={openDisplayStream}
        onAddVideoTrack={openVideoStream}
        onAddAudioTrack={openAudioStream}
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
        onMainDisplayChanged={selectMainDisplay}
        onOverlayChanged={selectOverlay}
        onRemoveTrack={removeTrack}
      />

      <SavedRecordingsSection
        recordings={browserStorage.recordings}
        activeRecordingName={activeRecording.name}
        onRemove={deleteRecording}
        onDownload={downloadFile}
      />

      <ToastContainer/>
    </Flex>
  );
}

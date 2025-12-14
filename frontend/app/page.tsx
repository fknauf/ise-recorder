"use client";

import { Flex, ToastContainer } from "@adobe/react-spectrum";
import { QuotaWarning } from "./lib/components/QuotaWarning";
import { RecorderControls } from "./lib/components/RecorderControls";
import { SavedRecordingsSection } from "./lib/components/SavedRecordingsSection";
import { downloadFile } from "./lib/utils/browserStorage";
import { PreviewSection } from "./lib/components/PreviewSection";
import { useBrowserStorage } from "./lib/hooks/useBrowserStorage";
import { useActiveRecording } from "./lib/hooks/useActiveRecording";
import { useMediaDevices } from "./lib/hooks/useMediaDevices";
import { useMediaTracks } from "./lib/hooks/useMediaTracks";
import { useLecture } from "./lib/hooks/useLecture";
import { useServerEnv } from "./lib/hooks/useServerEnv";

export default function Home() {
  const {
    lectureTitle,
    lecturerEmail,
    setLectureTitle,
    setLecturerEmail
  } = useLecture();

  const {
    activeRecording,
    startRecording,
    stopRecording
  } = useActiveRecording();

  const {
    quota,
    usage,
    savedRecordings,
    removeSavedRecording
  } = useBrowserStorage();

  const {
    apiUrl
  } = useServerEnv();

  const {
    videoDevices,
    audioDevices,
    openDisplayStream,
    openVideoStream,
    openAudioStream,
    refreshMediaDevices
  } = useMediaDevices();

  const {
    displayTracks,
    videoTracks,
    audioTracks,
    mainDisplay,
    overlay,
    selectMainDisplay,
    selectOverlay,
    removeTrack
  } = useMediaTracks();

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
        usage={usage}
        quota={quota}
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
        recordings={savedRecordings}
        activeRecordingName={activeRecording.name}
        onRemove={removeSavedRecording}
        onDownload={downloadFile}
      />

      <ToastContainer/>
    </Flex>
  );
}

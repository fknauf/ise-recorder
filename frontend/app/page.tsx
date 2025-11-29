'use client';

import { Flex, ToastContainer } from "@adobe/react-spectrum";
import { useEffect, useState } from "react";
import { QuotaWarning } from "./lib/components/QuotaWarning";
import { RecorderControls, RecorderState } from "./lib/components/RecorderControls";
import { SavedRecordingsSection } from "./lib/components/SavedRecordingsSection";
import { appendToRecordingFile, RecordingsState, getRecordingsState, deleteRecording, downloadFile } from "./lib/utils/filesystem";
import { schedulePostprocessing, sendChunkToServer } from "./lib/utils/serverStorage";
import { recordLecture, RecordingBackgroundTask } from "./lib/utils/recording";
import { PreviewSection } from "./lib/components/PreviewSection";
import { useServerEnv } from "./lib/components/ServerEnvProvider";

type ActiveRecording = {
  state: RecorderState
  name?: string
  recorders?: readonly MediaRecorder[]
}

const preventClosing = (e: BeforeUnloadEvent) => {
  e.preventDefault();
}

export default function Home() {
  ////////////////
  // hooks
  ////////////////

  const [ lectureTitle, setLectureTitle ] = useState("")
  const [ lecturerEmail, setLecturerEmail ] = useState("")

  const [ videoTracks, setVideoTracks ] = useState<MediaStreamTrack[]>([]);
  const [ audioTracks, setAudioTracks ] = useState<MediaStreamTrack[]>([]);
  const [ displayTracks, setDisplayTracks ]= useState<MediaStreamTrack[]>([]);
  const [ mainDisplay, setMainDisplay ] = useState<MediaStreamTrack | null>(null);
  const [ overlay, setOverlay ] = useState<MediaStreamTrack | null>(null);

  const [ activeRecording, setActiveRecording ] = useState<ActiveRecording>({ state: "idle" });
  const [ savedRecordingsState, setSavedRecordingsState ] = useState<RecordingsState>({ recordings: [] });

  const serverEnv = useServerEnv();

  useEffect(() => {
    getRecordingsState().then(setSavedRecordingsState);
  }, [])

  ////////////////
  // logic
  ////////////////

  const apiUrl = serverEnv?.apiUrl;

  const updateSavedRecordingsList = () => getRecordingsState().then(setSavedRecordingsState);

  const addDisplayTracks = async (tracks: MediaStreamTrack[]) => {
    // should only ever be one video track, but let's just grab all just in case. user can
    // still remove them manually if there happen to be more.
    setDisplayTracks(prev => [ ...prev, ...tracks ]);
    if(!mainDisplay) {
      setMainDisplay(tracks.at(0) ?? null)
    }
  };

  const addVideoTracks = async (tracks: MediaStreamTrack[]) => {
    setVideoTracks(prev => [ ...prev, ...tracks ])
    if(!overlay) {
      setOverlay(tracks.at(0) ?? null);
    }
  }

  const addAudioTracks = async (tracks: MediaStreamTrack[]) => {
    setAudioTracks(prev => [ ...prev, ...tracks ])
  }

  const removeTrackFromPostprocessing = (track: MediaStreamTrack) => {
    if(mainDisplay === track) {
      setMainDisplay(null);
    }
    if(overlay === track) {
      setOverlay(null);
    }
  }

  const removeVideoTrack = (track: MediaStreamTrack) => {
    removeTrackFromPostprocessing(track);
    track.stop();
    setVideoTracks(prev => prev.filter(t => t !== track));
  }

  const removeAudioTrack = (track: MediaStreamTrack) => {
    track.stop();
    setAudioTracks(prev => prev.filter(t => t !== track));
  }

  const removeDisplayTrack = (track: MediaStreamTrack) => {
    removeTrackFromPostprocessing(track);
    track.stop();
    setDisplayTracks(prev => prev.filter(t => t !== track));
  }

  const startRecording = () => {
    const onChunkAvailable = async (chunk: Blob, recordingName: string, trackTitle: string, chunkIndex: number, fileExtension: string): Promise<RecordingBackgroundTask> => {
      // No need to await: we support sending chunks to server out of order and/or concurrently.
      const backgroundPromise = sendChunkToServer(apiUrl, chunk, recordingName, trackTitle, chunkIndex);

      // For local file storage on the other hand, it's important that chunks to the same file
      // are not written concurrently and that filesystem state updates are correctly ordered.
      await appendToRecordingFile(recordingName, `${trackTitle}.${fileExtension}`, chunk);
      await updateSavedRecordingsList();

      return { promise: backgroundPromise };
    };

    const onStarted = (recordingName: string, recorders: MediaRecorder[]) => {
      window.addEventListener('beforeunload', preventClosing);
      setActiveRecording({ state: "recording", name: recordingName, recorders })
    };

    const onFinished = async (recordingName: string) => {
      await schedulePostprocessing(apiUrl, recordingName, lecturerEmail);
      window.removeEventListener('beforeunload', preventClosing);
      setActiveRecording({ state: "idle" })
    }

    recordLecture(displayTracks, videoTracks, audioTracks, mainDisplay, overlay, lectureTitle, onChunkAvailable, onStarted, onFinished);
  };

  const stopRecording = () => {
    // This way stopRecording does not depend on activeRecording, so the React compiler can better optimize it.
    setActiveRecording(prev =>
      {
        // should not happen, this is purely defensive coding.
        if(prev.state !== "recording") {
          console.warn("attempted to stop recording while recorder wasn't recording")
          return prev;
        }

        prev.recorders?.forEach(rec => rec.stop());
        return { ...prev, state: "stopping" };
      }
    );
  }

  const removeRecording = async (recording: string) => {
    await deleteRecording(recording);
    await updateSavedRecordingsList();
  }

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
        usage={savedRecordingsState.usage}
        quota={savedRecordingsState.quota}
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
        onRemoveDisplayTrack={removeDisplayTrack}
        onRemoveVideoTrack={removeVideoTrack}
        onRemoveAudioTrack={removeAudioTrack}
      />

      <SavedRecordingsSection
        recordings={savedRecordingsState.recordings}
        activeRecordingName={activeRecording.name}
        onRemoved={removeRecording}
        onDownload={downloadFile}
      />

      <ToastContainer/>
    </Flex>
  );
}

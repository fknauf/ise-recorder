'use client';

import { Flex, ToastContainer } from "@adobe/react-spectrum";
import { useEffect, useState } from "react";
import { QuotaWarning } from "./lib/components/QuotaWarning";
import { RecorderControls, RecorderState } from "./lib/components/RecorderControls";
import { SavedRecordingsSection } from "./lib/components/SavedRecordingsSection";
import { RecordingsState, getRecordingsState, deleteRecording, downloadFile } from "./lib/utils/filesystem";
import { recordLecture } from "./lib/utils/recording";
import { PreviewSection } from "./lib/components/PreviewSection";
import { useServerEnv } from "./lib/components/ServerEnvProvider";
import useLocalStorageState from "use-local-storage-state";

interface ActiveRecording {
  state: RecorderState
  name?: string
  stop?: () => void
}

const preventClosing = (e: BeforeUnloadEvent) => {
  e.preventDefault();
}

export default function Home() {
  ////////////////
  // hooks
  ////////////////

  const [ lectureTitle, setLectureTitle ] = useLocalStorageState<string>("lecture-title", { defaultValue: "", storageSync: false });
  const [ lecturerEmail, setLecturerEmail ] = useLocalStorageState<string>("lecturer-email", { defaultValue: "", storageSync: false });

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

  const updateSavedRecordingsList = async () => {
    const state = await getRecordingsState();
    setSavedRecordingsState(state);
  }

  const addDisplayTracks = (tracks: MediaStreamTrack[]) => {
    // should only ever be one video track, but let's just grab all just in case. user can
    // still remove them manually if there happen to be more.
    setDisplayTracks(prev => [ ...prev, ...tracks ]);
    if(!mainDisplay) {
      setMainDisplay(tracks.at(0) ?? null)
    }
  };

  const addVideoTracks = (tracks: MediaStreamTrack[]) => {
    setVideoTracks(prev => [ ...prev, ...tracks ])
    if(!overlay) {
      setOverlay(tracks.at(0) ?? null);
    }
  }

  const addAudioTracks = (tracks: MediaStreamTrack[]) => {
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
    if(activeRecording.state !== "idle") {
      return;
    }

    const onStarting = (recordingName: string) => {
      setActiveRecording({ state: "starting", name: recordingName })
      // Prevent accidental closing of the tab while recording
      window.addEventListener('beforeunload', preventClosing);
    };

    const onStarted = (recordingName: string, stopFunction: () => void) => {
      updateSavedRecordingsList();
      setActiveRecording({ state: "recording", name: recordingName, stop: stopFunction });
    };

    const calculatedFileSizes = new Map<string, number>();

    const onChunkWritten = (recordingName: string, filename: string, chunkSize: number) => {
      const filesize = (calculatedFileSizes.get(filename) ?? 0) + chunkSize

      calculatedFileSizes.set(filename, filesize);

      // uncommitted data don't show up in the OPFS file sizes yet, so attach them manually.
      setSavedRecordingsState(
        prevState => {
          const nextState = structuredClone(prevState);
          const recording = nextState.recordings.find(rec => rec.name == recordingName);
          const fileinfo = recording?.files.find(info => info.name == filename);

          if(fileinfo !== undefined) {
            fileinfo.size = filesize;
            return nextState;
          } else {
            return prevState;
          }
        }
      );
    };

    const onFinished = async () => {
      await updateSavedRecordingsList();
      window.removeEventListener('beforeunload', preventClosing);
      setActiveRecording({ state: "idle" })
    }

    recordLecture(
      displayTracks, videoTracks, audioTracks, mainDisplay, overlay,
      lectureTitle, lecturerEmail, apiUrl,
      onStarting, onStarted, onChunkWritten, onFinished
    );
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

        if(prev.stop !== undefined) {
          prev.stop()
        }

        return { state: "stopping", name: prev.name };
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

'use client';

import { Flex, ToastContainer } from "@adobe/react-spectrum";
import { useEffect, useState } from "react";
import { QuotaWarning } from "./lib/components/QuotaWarning";
import { RecorderControls, RecorderState } from "./lib/components/RecorderControls";
import { SavedRecordingsSection } from "./lib/components/SavedRecordingsSection";
import { RecordingsState, getRecordingsState, deleteRecording, downloadFile, openRecordingFileStream } from "./lib/utils/filesystem";
import { schedulePostprocessing, sendChunkToServer } from "./lib/utils/serverStorage";
import { recordLecture, RecordingBackgroundTask, RecordingTask } from "./lib/utils/recording";
import { PreviewSection } from "./lib/components/PreviewSection";
import { useServerEnv } from "./lib/components/ServerEnvProvider";

interface RecordingSink {
  outputStream: FileSystemWritableFileStream
  writtenBytes: number
};

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

  const updateSavedRecordingsList = async (fudgeFn?: (state: RecordingsState) => RecordingsState) => {
    let state = await getRecordingsState();

    if(fudgeFn !== undefined) {
      state = fudgeFn(state);
    }

    setSavedRecordingsState(state);
  }

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
    if(activeRecording.state !== "idle") {
      return;
    }

    const videoOptions: MediaRecorderOptions = { mimeType: "video/webm" };
    const audioOptions: MediaRecorderOptions = { mimeType: "audio/webm" }
    const formatFilename = (trackTitle: string) => `${trackTitle}.webm`;

    // Map of filename to output stream and associated information. This map is captured
    // and shared by the callback functions we pass to recordLecture below.
    const sinks = new Map<string, RecordingSink>();

    const onStarting = async (recordingName: string, tasks: RecordingTask[]) => {
      // set active recording first so the UI responds immediately. This should prevent
      // duplicate recording starts -- opening the streams below can sometimes take a noticeable
      // fraction of a second, at least in Firefox.
      setActiveRecording({
        state: "recording",
        name: recordingName,
        stop: () => tasks.forEach(t => t.stop())
      })

      // Prevent accidental closing of the tab while recording
      window.addEventListener('beforeunload', preventClosing);

      for(const task of tasks) {
        const filename = formatFilename(task.trackTitle);
        const outputStream = await openRecordingFileStream(recordingName, filename)

        sinks.set(filename, { outputStream, writtenBytes: 0 });
      }

      // have the new recording show up immediately in the list.
      updateSavedRecordingsList();
    };

    const onChunkAvailable = async (chunk: Blob, recordingName: string, trackTitle: string, chunkIndex: number): Promise<RecordingBackgroundTask> => {
      // No need to await: we support sending chunks to server out of order and/or concurrently.
      const backgroundPromise = sendChunkToServer(apiUrl, chunk, recordingName, trackTitle, chunkIndex);

      // For local file storage on the other hand, it's important that chunks to the same file
      // are not written concurrently and that filesystem state updates are correctly ordered.
      const filename = formatFilename(trackTitle);
      const sink = sinks.get(filename);

      if(sink !== undefined) {
        try {
          await sink.outputStream.write(chunk);
          sink.writtenBytes += chunk.size;
        } catch(e) {
          // If this happens, it's probably because the browser quota is exhausted.
          console.warn(`Could not write to ${filename}`, e);
          await sink.outputStream.close();
          sinks.delete(trackTitle);
        }
      }

      await updateSavedRecordingsList(
        state => {
          // uncommitted data don't show up in the OPFS file sizes yet, so attach them manually.
          const activeRecordingDir = state.recordings.find(rec => rec.name == recordingName);
          activeRecordingDir?.fileinfos?.forEach(fileinfo =>
            fileinfo.size = sinks.get(fileinfo.filename)?.writtenBytes ?? fileinfo.size
          );

          return state;
        }
      );

      return { promise: backgroundPromise };
    };

    const onFinished = async (recordingName: string) => {
      await Promise.all(sinks.values().map(sink => sink.outputStream.close()));
      await updateSavedRecordingsList();
      await schedulePostprocessing(apiUrl, recordingName, lecturerEmail);

      window.removeEventListener('beforeunload', preventClosing);
      setActiveRecording({ state: "idle" })
    }

    recordLecture(
      displayTracks, videoTracks, audioTracks,
      mainDisplay, overlay,
      lectureTitle,
      videoOptions, audioOptions,
      onChunkAvailable, onStarting, onFinished);
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

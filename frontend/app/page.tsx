'use client';

import { Flex, ToastContainer } from "@adobe/react-spectrum";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { QuotaWarning } from "./lib/components/QuotaWarning";
import { RecorderControls } from "./lib/components/RecorderControls";
import { SavedRecordingsSection } from "./lib/components/SavedRecordingsSection";
import { appendToRecordingFile, RecordingsState, getRecordingsState } from "./lib/utils/filesystem";
import { schedulePostprocessing, sendChunkToServer } from "./lib/utils/serverStorage";
import { recordLecture, stopLectureRecording, RecordingJobs } from "./lib/utils/recording";
import { clientGetPublicServerEnvironment } from "./env/lib";
import { PreviewSection } from "./lib/components/PreviewSection";

export default function Home() {
  ////////////////
  // hooks
  ////////////////

  const [ videoTracks, setVideoTracks ] = useState<MediaStreamTrack[]>([]);
  const [ audioTracks, setAudioTracks ] = useState<MediaStreamTrack[]>([]);
  const [ displayTracks, setDisplayTracks ]= useState<MediaStreamTrack[]>([]);

  const [ activeRecording, setActiveRecording ] = useState<RecordingJobs | null>(null);
  const [ savedRecordingsState, setSavedRecordingsState ] = useState<RecordingsState>({ recordings: [] });
  const [ lectureTitle, setLectureTitle ] = useState("")
  const [ lecturerEmail, setLecturerEmail ] = useState("")

  const [ mainDisplay, setMainDisplay ] = useState<MediaStreamTrack | null>(null);
  const [ overlay, setOverlay ] = useState<MediaStreamTrack | null>(null);

  const { data: serverEnv } = useSWR('env', clientGetPublicServerEnvironment)

  useEffect(() => {
    getRecordingsState().then(setSavedRecordingsState);
  }, [])

  useEffect(() => {
    if(activeRecording !== null) {
      const handleBeforeUnload = (e: BeforeUnloadEvent) => {
        e.preventDefault();
      }

      window.addEventListener('beforeunload', handleBeforeUnload);

      return () => {
        window.removeEventListener('beforeunload', handleBeforeUnload);
      };
    }
  }, [ activeRecording ]);

  ////////////////
  // logic
  ////////////////

  const isRecording = activeRecording !== null;
  const apiUrl = serverEnv?.api_url

  const addDisplayTracks = async (tracks: MediaStreamTrack[]) => {
    // should only ever be one video track, but let's just grab all just in case. user can
    // still remove them manually if there happen to be more.
    setDisplayTracks([ ...displayTracks, ...tracks ]);

    if(!mainDisplay) {
      setMainDisplay(tracks.at(0) ?? null)
    }
  };

  const addVideoTracks = async (tracks: MediaStreamTrack[]) => {
    setVideoTracks([ ...videoTracks, ...tracks ])

    if(!overlay) {
      setOverlay(tracks.at(0) ?? null);
    }
  }

  const addAudioTracks = async (tracks: MediaStreamTrack[]) => {
    setAudioTracks ([...audioTracks, ...tracks ])
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
    setVideoTracks(videoTracks.filter(t => t !== track));
  }

  const removeAudioTrack = (track: MediaStreamTrack) => {
    track.stop();
    setAudioTracks(audioTracks.filter(t => t !== track));
  }

  const removeDisplayTrack = (track: MediaStreamTrack) => {
    removeTrackFromPostprocessing(track);
    track.stop();
    setDisplayTracks(displayTracks.filter(t => t !== track));
  }

  const startRecording = () => {
    const onChunkAvailable = async (chunk: Blob, recordingName: string, trackTitle: string, chunkIndex: number, fileExtension: string) => {
      sendChunkToServer(apiUrl, chunk, recordingName, trackTitle, chunkIndex);
      await appendToRecordingFile(recordingName, `${trackTitle}.${fileExtension}`, chunk);
      setSavedRecordingsState(await getRecordingsState());
    };

    const onFinished = async (recordingName: string) => {
      schedulePostprocessing(apiUrl, recordingName, lecturerEmail);
      setSavedRecordingsState(await getRecordingsState());
    }

    recordLecture(displayTracks, videoTracks, audioTracks, mainDisplay, overlay, lectureTitle, onChunkAvailable, setActiveRecording, onFinished);
  };

  const stopRecording = () => {
    stopLectureRecording(activeRecording, () => setActiveRecording(null));
  };

  ////////////////
  // view
  ////////////////

  return (
    <Flex direction="column" width="100vw" height="100vh" gap="size-100">
      <RecorderControls
        lectureTitle={lectureTitle}
        lecturerEmail={lecturerEmail}
        isRecording={isRecording}
        currentVideoTracks={videoTracks}
        currentAudioTracks={audioTracks}
        isEmailHidden={!apiUrl}
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
        hasDisabledButtons={isRecording}
        onToggleMainDisplay={(track, isSelected) => setMainDisplay(isSelected ? track : null)}
        onToggleOverlay={(track, isSelected) => setOverlay(isSelected ? track : null)}
        onRemoveDisplayTrack={removeDisplayTrack}
        onRemoveVideoTrack={removeVideoTrack}
        onRemoveAudioTrack={removeAudioTrack}
      />

      <SavedRecordingsSection
        recordings={savedRecordingsState.recordings}
        activeRecordingName={activeRecording?.name}
        onRemoved={() => getRecordingsState().then(setSavedRecordingsState)}
      />

      <ToastContainer/>
    </Flex>
  );
}

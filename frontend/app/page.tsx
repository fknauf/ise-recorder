'use client';

import { Content, Flex, Heading, InlineAlert, ToastContainer } from "@adobe/react-spectrum";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { VideoPreview } from "./lib/components/VideoPreview";
import { AudioPreview } from "./lib/components/AudioPreview";
import { PreviewCard } from "./lib/components/PreviewCard";
import { RecorderControls } from "./lib/components/RecorderControls";
import { SavedRecordingsCard } from "./lib/components/SavedRecordingCard";
import { appendToRecordingFile, RecordingsState, getRecordingsState } from "./lib/utils/filesystem";
import { schedulePostprocessing, sendChunkToServer } from "./lib/utils/serverStorage";
import { recordLecture, stopLectureRecording, ChunkAddress, RecordingJobs } from "./lib/utils/recording";
import { clientGetPublicServerEnvironment } from "./env/lib";

const mibFormatter = new Intl.NumberFormat('en-us', { minimumFractionDigits: 0, maximumFractionDigits: 0, useGrouping: false });

function formatMib(x: number | undefined) {
  if(x === undefined) {
    return "N/A"
  } else {
    return mibFormatter.format(x / 2 ** 20) + " MiB";
  }
}

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
    const onChunkAvailable = async (chunk: Blob, address: ChunkAddress, fileExtension: string) => {
      const { recordingName, trackTitle, chunkIndex } = address;

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

  const quotaCritical =
    savedRecordingsState.quota !== undefined &&
    savedRecordingsState.usage !== undefined &&
    savedRecordingsState.quota - savedRecordingsState.usage < 2 ** 30 * 1;

  ////////////////
  // view
  ////////////////

  const video_preview_card = (track: MediaStreamTrack, label: string, onRemove: (track: MediaStreamTrack) => void) =>
    <PreviewCard
      key={`preview-card-${track.id}`}
      label={label}
      buttonDisabled={isRecording}
      onRemove={() => onRemove(track)}
    >
      <VideoPreview
        track={track}
        switchesDisabled={isRecording}
        isMainDisplay={mainDisplay === track}
        isOverlay={overlay === track}
        onToggleMainDisplay={isSelected => { setMainDisplay(isSelected ? track : null) }}
        onToggleOverlay={isSelected => { setOverlay(isSelected ? track : null)}}
      />
    </PreviewCard>;

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

      {
        quotaCritical ?
          <Flex direction="row" justifyContent="center" marginTop="size-200">
            <InlineAlert variant="notice">
              <Heading>Quota warning</Heading>
              <Content>
                Browser storage running low: {formatMib(savedRecordingsState.usage)} of {formatMib(savedRecordingsState.quota)} used. Please consider removing some old recordings.
              </Content>
            </InlineAlert>
          </Flex>
          : <></>
      }

      <Flex direction="row" gap="size-100" justifyContent="center" wrap>
        {
          displayTracks.map((track, ix) => video_preview_card(track, `Screen capture ${ix}`, removeDisplayTrack))
        }
        {
          videoTracks.map(track => video_preview_card(track, track.label, removeVideoTrack))
        }
        {
          audioTracks.map(track =>
            <PreviewCard
              key={`preview-card-${track.id}`}
              label={track.label}
              buttonDisabled={isRecording}
              onRemove={() => removeAudioTrack(track)}
            >
              <AudioPreview track={track}/>
            </PreviewCard>
          )
        }
      </Flex>

      <Flex direction="row" gap="size-100" wrap>
        {
          savedRecordingsState.recordings.map(r =>
            <SavedRecordingsCard
              key={`saved-recording-${r.name}`}
              recording={r}
              isBeingRecorded={r.name === activeRecording?.name}
              onRemoved={() => getRecordingsState().then(setSavedRecordingsState) }
            />
          )
        }
      </Flex>
      <ToastContainer/>
    </Flex>
  );
}

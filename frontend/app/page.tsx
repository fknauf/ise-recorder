'use client';

import { ActionButton, Divider, Flex, Item, Text, MenuTrigger, Menu, Key, TextField } from "@adobe/react-spectrum";
import CallCenter from '@spectrum-icons/workflow/CallCenter';
import MovieCamera from '@spectrum-icons/workflow/MovieCamera';
import Circle from '@spectrum-icons/workflow/Circle';
import DeviceDesktop from '@spectrum-icons/workflow/DeviceDesktop';
import Stop from '@spectrum-icons/workflow/Stop';
import { useEffect, useState } from "react";
import useMediaStream from "use-media-stream";
import VideoPreview from "./lib/VideoPreview";
import AudioPreview from "./lib/AudioPreview";
import { PreviewCard } from "./lib/PreviewCard";
import { SavedRecordingsCard } from "./lib/SavedRecordingCard";
import { getRecordingsList, RecordingFileList, appendToRecordingFile } from "./lib/filesystem";
import { scheduleRenderingJob, sendChunkToServer } from "./lib/serverStorage";
import isEmail from 'validator/es/lib/isEmail';
import useSWR from "swr";
import { clientGetPublicServerEnvironment } from "./env/lib";

interface RecordingJob {
  recorder: MediaRecorder
  finished: Promise<void>
}

interface RecordingJobs {
  name: string,
  recorders: MediaRecorder[]
}

const unsafeCharacters = /[^A-Za-z0-9_.-]/g;

const validateLectureTitle = (title: string) => !unsafeCharacters.test(title) || 'unsafe character in lecture title';
const validateEmail = (email: string) => email.trim() === '' || isEmail(email) || 'invalid e-mail address';

export default function Home() {
  ////////////////
  // hooks
  ////////////////

  const [ videoTracks, setVideoTracks ] = useState<MediaStreamTrack[]>([]);
  const [ audioTracks, setAudioTracks ] = useState<MediaStreamTrack[]>([]);
  const [ displayTracks, setDisplayTracks ]= useState<MediaStreamTrack[]>([]);

  const [ activeRecording, setActiveRecording ] = useState<RecordingJobs | null>(null);
  const [ recordings, setRecordings ] = useState<RecordingFileList[]>([]);
  const [ lectureTitle, setLectureTitle ] = useState("")
  const [ lecturerEmail, setLecturerEmail ] = useState("")

  const [ mainDisplay, setMainDisplay ] = useState<MediaStreamTrack | null>(null);
  const [ overlay, setOverlay ] = useState<MediaStreamTrack | null>(null);

  const { stream, getMediaDevices } = useMediaStream();

  const { data: serverEnv } = useSWR('env', clientGetPublicServerEnvironment)

  useEffect(() => {
    getRecordingsList().then(setRecordings);
  }, [])

  ////////////////
  // logic
  ////////////////

  const isRecording = activeRecording !== null;
  const apiUrl = serverEnv?.api_url

  const camVideoTracks = stream?.getVideoTracks() ?? []
  const camAudioTracks = stream?.getAudioTracks() ?? []

  const openDisplayStream = async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia();
      const screenTracks = screenStream.getVideoTracks();

      // should only ever be one video track, but let's just grab all just in case. user can
      // still remove them manually if there happen to be more.
      setDisplayTracks([ ...displayTracks, ...screenTracks ]);

      if(!mainDisplay && screenTracks.length > 0) {
        setMainDisplay(screenTracks[0])
      }
    } catch(e) {
      console.log(e);
    }
  }

  const addVideoSource = (newTrackId: Key) => {
    const newTrack = camVideoTracks.find(track => track.id === newTrackId);

    if(newTrack && !videoTracks.find(track => track.id === newTrackId)) {
      setVideoTracks([...videoTracks, newTrack ])

      if(!overlay) {
        setOverlay(newTrack);
      }
    }
  }

  const addAudioSource = (newTrackId: Key) => {
    const newTrack = camAudioTracks.find(track => track.id === newTrackId);

    if(newTrack && !audioTracks.find(track => track.id === newTrackId)) {
      setAudioTracks([ ...audioTracks, newTrack ]);
    }
  }

  const removeVideoTrack = (track: MediaStreamTrack) => {
    if(mainDisplay === track) {
      setMainDisplay(null)
    }
    if(overlay === track) {
      setOverlay(null)
    }

    setVideoTracks(videoTracks.filter(t => t !== track));
  }

  const removeAudioTrack = (track: MediaStreamTrack) => {
    setAudioTracks(audioTracks.filter(t => t !== track));
  }

  const removeDisplayTrack = (track: MediaStreamTrack) => {
    if(mainDisplay === track) {
      setMainDisplay(null)
    }
    if(overlay === track) {
      setOverlay(null)
    }

    track.stop();

    setDisplayTracks(displayTracks.filter(t => t !== track));
  }

  const recordTracks = (
    tracks: MediaStreamTrack[],
    recordingName: string,
    trackTitle: string,
    fileExtension: string,
    options?: MediaRecorderOptions
  ): RecordingJob => {
    const recordedStream = new MediaStream(tracks);
    const newRecorder = new MediaRecorder(recordedStream, options);

    // This is a little bit involved so that we're guaranteed to not drop any chunks and also
    // not process them out of order.
    //
    // This is a problem we have to solve because the OPFS api is extremely asynchronous, so in
    // a naive implementation that starts an appendToRecordingFile job in the ondataavailable
    // handler we could end up with multiple such jobs in flight at the same time, which leads
    // to data loss.
    //
    // To get around this, we instead queue incoming chunks and spawn a background task that
    // appends them to the file sequentially. The event handler signals to the background task
    // through a promise object that is exchanged after every delivered chunk. Promise objects
    // may be dropped without being awaited, but the chunks will be in the queue and handled
    // anyway. The exchange makes clever/ugly use of typescript capturing semantics, but this
    // is the least involved way I came up with.
    const chunkQueue: Blob[] = [];
    let chunkSignalResolve: (finished: boolean) => void
    let chunkSignalPromise = new Promise<boolean>(resolve => chunkSignalResolve = resolve);

    newRecorder.ondataavailable = event => {
      chunkQueue.push(event.data);
      chunkSignalResolve(false);
      chunkSignalPromise = new Promise<boolean>(resolve => chunkSignalResolve = resolve);
    }
    newRecorder.onstop = () => chunkSignalResolve(true);
    newRecorder.onerror = () => chunkSignalResolve(true);

    const finishedPromise = new Promise<void>(resolve => {
      (async () => {
        let finished = false;
        let chunkNum = 0;

        while(!finished) {
          finished = await chunkSignalPromise;

          while(chunkQueue.length > 0) {
            const chunk = chunkQueue.shift();
            if(chunk) {
              sendChunkToServer(apiUrl, chunk, recordingName, trackTitle, chunkNum);
              await appendToRecordingFile(recordingName, `${trackTitle}.${fileExtension}`, chunk);
              setRecordings(await getRecordingsList());

              ++chunkNum;
            }
          }
        }

        resolve();
      })();
    })

    newRecorder.start(5000);

    return {
      recorder: newRecorder,
      finished: finishedPromise
    };
  };

  const startRecording = async () => {
    if(isRecording) {
      return;
    }

    const allTracks = displayTracks.concat(videoTracks).concat(audioTracks);

    if(allTracks.length === 0) {
      return;
    }

    const timestamp = new Date();
    const lecturePrefix = lectureTitle ? `${lectureTitle}_` : '';
    const recordingName = `${lecturePrefix}${timestamp.toISOString()}`.replaceAll(unsafeCharacters, '');

    const recordVideoTracks = (tracks: MediaStreamTrack[], trackTitle: string) => recordTracks(tracks, recordingName, trackTitle, 'webm', { mimeType: 'video/webm' });
    const recordAudioTracks = (tracks: MediaStreamTrack[], trackTitle: string) => recordTracks(tracks, recordingName, trackTitle, 'ogg', { mimeType: 'audio/ogg' });

    let allJobs: RecordingJob[] = [];

    if(videoTracks.length > 0) {
      const mainJob = recordVideoTracks([videoTracks[0]].concat(audioTracks), 'stream');
      const videoJobs = videoTracks.slice(1).map((track, index) => recordVideoTracks([track], `video-${index + 1}`));
      const displayJobs = displayTracks.map((track, index) => recordVideoTracks([track], `display-${index}`));
      allJobs = [mainJob].concat(videoJobs).concat(displayJobs);
    } else if(displayTracks.length > 0) {
      const mainJob = recordVideoTracks([displayTracks[0]].concat(audioTracks), 'stream');
      const displayJobs = displayTracks.slice(1).map((track, index) => recordVideoTracks([track], `display-${index + 1}`));
      allJobs = [mainJob].concat(displayJobs);
    } else {
      allJobs = audioTracks.map((track, index) => recordAudioTracks([track], `audio-${index}`));
    }

    setActiveRecording({
      name: recordingName,
      recorders: allJobs.map(job => job.recorder)
    });

    await Promise.all(allJobs.map(job => job.finished));

    scheduleRenderingJob(apiUrl, recordingName, recordingName, lecturerEmail);

    setActiveRecording(null);
    setRecordings(await getRecordingsList());
  };

  const stopRecording = () => {
    activeRecording?.recorders.forEach(r => r.stop());
  };

  ////////////////
  // view
  ////////////////

  return (
    <Flex direction="column" width="100vw" height="100vh" gap="size-100">
      <Flex direction="row" justifyContent="center" gap="size-100" marginTop="size-100" wrap>
        <TextField
          label="Lecture Title"
          value={lectureTitle}
          isReadOnly={isRecording}
          validate={validateLectureTitle}
          isDisabled={isRecording}
          onChange={setLectureTitle}
        />
        {
          apiUrl !== undefined &&
            <TextField
              label="e-Mail"
              validate={validateEmail}
              value={lecturerEmail}
              isReadOnly={false}
              onChange={setLecturerEmail}
            />
        }
        <Divider orientation="vertical" size="M"/>

        <ActionButton onPress={openDisplayStream} isDisabled={isRecording} alignSelf="end">
          <DeviceDesktop/>
          <Text>Add Screen/Window</Text>
        </ActionButton>

        <MenuTrigger onOpenChange={getMediaDevices}>
          <ActionButton isDisabled={isRecording} alignSelf="end">
            <MovieCamera/>
            <Text>Add Video Source</Text>
          </ActionButton>
          <Menu onAction={addVideoSource}>
            { camVideoTracks.map(track => <Item key={track.id}>{track.label}</Item>) }
          </Menu>
        </MenuTrigger>

        <MenuTrigger onOpenChange={getMediaDevices}>
          <ActionButton isDisabled={isRecording} alignSelf="end">
            <CallCenter/>
            <Text>Add Audio Source</Text>
          </ActionButton>
          <Menu onAction={addAudioSource}>
            { camAudioTracks.map(track => <Item key={track.id}>{track.label}</Item>) }
          </Menu>
        </MenuTrigger>

        <Divider orientation="vertical" size="M"/>

        {
            isRecording
            ? <ActionButton alignSelf="end" onPress={stopRecording}><Stop/> <Text>Stop Recording</Text></ActionButton>
            : <ActionButton alignSelf="end" onPress={startRecording}><Circle/> <Text>Start Recording</Text></ActionButton>
        }
      </Flex>

      <Flex direction="row" gap="size-100" justifyContent="center" wrap>
        {
          displayTracks.map((track, ix) =>
            <PreviewCard
              key={`preview-card-${track.id}`}
              label={`Screen capture ${ix}`}
              buttonDisabled={isRecording}
              onRemove={() => removeDisplayTrack(track)}
            >
              <VideoPreview
                track={track}
                isMainDisplay={mainDisplay === track}
                isOverlay={overlay === track}
                onToggleMainDisplay={isSelected => { setMainDisplay(isSelected ? track : null) }}
                onToggleOverlay={isSelected => { setOverlay(isSelected ? track : null)}}
              />
            </PreviewCard>
          )
        }
        {
          videoTracks.map(track =>
            <PreviewCard
              key={`preview-card-${track.id}`}
              label={track.label}
              buttonDisabled={isRecording}
              onRemove={() => removeVideoTrack(track)}
            >
              <VideoPreview
                track={track}
                isMainDisplay={mainDisplay === track}
                isOverlay={overlay === track}
                onToggleMainDisplay={isSelected => { setMainDisplay(isSelected ? track : null) }}
                onToggleOverlay={isSelected => { setOverlay(isSelected ? track : null)}}
              />
            </PreviewCard>
          )
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
          recordings.map(r =>
            <SavedRecordingsCard
              key={`saved-recording-${r.name}`}
              recording={r}
              isBeingRecorded={r.name === activeRecording?.name}
              onRemoved={() => getRecordingsList().then(setRecordings) }
            />
          )
        }
      </Flex>
    </Flex>
  );
}

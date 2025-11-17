'use client';

import { ActionButton, Divider, Flex, Item, Text, MenuTrigger, Menu, Key } from "@adobe/react-spectrum";
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
import { sendChunkToServer } from "./lib/serverStorage";

interface RecordingJob {
  recorder: MediaRecorder
  finished: Promise<void>
}

interface RecordingJobs {
  name: string,
  recorders: MediaRecorder[]
}

export default function Home() {
  ////////////////
  // hooks
  ////////////////

  const [ selectedVideoSources, setSelectedVideoSources ] = useState<Key[]>([]);
  const [ selectedAudioSources, setSelectedAudioSources ] = useState<Key[]>([]);
  const [ selectedDisplayStreams, setSelectedDisplayStreams ]= useState<MediaStream[]>([]);
  const [ activeRecording, setActiveRecording ] = useState<RecordingJobs | null>(null);
  const [ recordings, setRecordings ] = useState<RecordingFileList[]>([]);

  const {
    stream,
    getMediaDevices,
    audioInputDevices,
    videoInputDevices,
  } = useMediaStream();

  useEffect(() => {
    getRecordingsList().then(setRecordings);
  }, [])

  ////////////////
  // logic
  ////////////////

  const isRecording = activeRecording != null;

  const openDisplayStream = async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia();
      setSelectedDisplayStreams(selectedDisplayStreams.concat([screenStream]));
    } catch(e) {
      console.log(e);
    }
  }

  const addSourceFn =
    (setter: (newData: Key[]) => void, currentData: Key[]) =>
      (key: Key) => {
        if(!currentData.includes(key)) {
          setter(currentData.concat([key]));
        }
      };
  const addVideoSource = addSourceFn(setSelectedVideoSources, selectedVideoSources);
  const addAudioSource = addSourceFn(setSelectedAudioSources, selectedAudioSources);

  const removeSourceFn =
    (setter: (newData: Key[]) => void, currentData: Key[]) =>
      (key: Key) => setter(currentData.filter(src => src != key));
  const removeVideoSource = removeSourceFn(setSelectedVideoSources, selectedVideoSources);
  const removeAudioSource = removeSourceFn(setSelectedAudioSources, selectedAudioSources);
  const removeDisplayStream = (stream: MediaStream) => {
    stream.getTracks().forEach(track => track.stop())
    setSelectedDisplayStreams(selectedDisplayStreams.filter(s => s !== stream));
  }

  const findTrack = (tracks: MediaStreamTrack[], deviceId: Key) => tracks.find(track => track.getSettings().deviceId == deviceId);
  const findVideoTrack = (deviceId: Key) => findTrack(stream?.getVideoTracks() ?? [], deviceId);
  const findAudioTrack = (deviceId: Key) => findTrack(stream?.getAudioTracks() ?? [], deviceId);

  const findLabel = (devs: MediaDeviceInfo[], id: Key) => devs.find(dev => dev.deviceId == id)?.label;

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
              const chunkLabel = String(chunkNum).padStart(4, '0');

              sendChunkToServer(chunk, recordingName, trackTitle, chunkNum);
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

    const videoTracks = selectedVideoSources.map(findVideoTrack).filter(track => track !== undefined);
    const audioTracks = selectedAudioSources.map(findAudioTrack).filter(track => track !== undefined);
    const displayTracks = selectedDisplayStreams.flatMap(stream => stream.getTracks());

    const allTracks = displayTracks.concat(videoTracks).concat(audioTracks);

    if(allTracks.length == 0) {
      return;
    }

    const timestamp = new Date();
    const recordingName = timestamp.toISOString();

    const recordVideoTracks = (tracks: MediaStreamTrack[], trackTitle: string) => recordTracks(tracks, recordingName, trackTitle, '.webm', { mimeType: 'video/webm' });
    const recordAudioTracks = (tracks: MediaStreamTrack[], trackTitle: string) => recordTracks(tracks, recordingName, trackTitle, '.ogg', { mimeType: 'audio/ogg' });

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
      <Flex direction="row" justifyContent="center" gap="size-100" marginTop="size-100">
        <MenuTrigger onOpenChange={getMediaDevices}>
          <ActionButton isDisabled={isRecording}>
            <MovieCamera/>
            <Text>Add Video Source</Text>
          </ActionButton>
          <Menu onAction={addVideoSource}>
            { videoInputDevices.map(dev => <Item key={dev.deviceId}>{dev.label}</Item>) }
          </Menu>
        </MenuTrigger>

        <MenuTrigger onOpenChange={getMediaDevices}>
          <ActionButton isDisabled={isRecording}>
            <CallCenter/>
            <Text>Add Audio Source</Text>
          </ActionButton>
          <Menu onAction={addAudioSource}>
            { audioInputDevices.map(dev => <Item key={dev.deviceId}>{dev.label}</Item>) }
          </Menu>
        </MenuTrigger>

        <ActionButton onPress={openDisplayStream} isDisabled={isRecording}>
          <DeviceDesktop/>
          <Text>Add Screen/Window</Text>
        </ActionButton>

        <Divider orientation="vertical" size="M"/>

        {
            isRecording
            ? <ActionButton onPress={stopRecording}><Stop/> <Text>Stop Recording</Text></ActionButton>
            : <ActionButton onPress={startRecording}><Circle/> <Text>Start Recording</Text></ActionButton>
        }
      </Flex>

      <Flex direction="row" gap="size-100" justifyContent="center" wrap={true}>
        {
          selectedVideoSources.map(deviceId =>
            <PreviewCard
              key={`preview-card-${deviceId}`}
              label={findLabel(videoInputDevices, deviceId)}
              buttonDisabled={isRecording}
              onRemove={() => removeVideoSource(deviceId)}
            >
              <VideoPreview track={findVideoTrack(deviceId)}/>
            </PreviewCard>
          )
        }
        {
          selectedAudioSources.map(deviceId =>
            <PreviewCard
              key={`preview-card-${deviceId}`}
              label={findLabel(audioInputDevices, deviceId)}
              buttonDisabled={isRecording}
              onRemove={() => removeAudioSource(deviceId)}
            >
              <AudioPreview track={findAudioTrack(deviceId)}/>
            </PreviewCard>
          )
        }
        {
          selectedDisplayStreams.map((stream, ix) =>
            <PreviewCard
              key={`preview-card-display-${ix}`}
              label={`Screen capture ${ix}`}
              buttonDisabled={isRecording}
              onRemove={() => removeDisplayStream(stream)}
            >
              <VideoPreview
                track={stream.getTracks()[0]}
              />
            </PreviewCard>
          )
        }
      </Flex>

      <Flex direction="row" gap="size-100" wrap={true}>
        {
          recordings.map(r =>
            <SavedRecordingsCard
              key={`saved-recording-${r.name}`}
              recording={r}
              isBeingRecorded={r.name == activeRecording?.name}
              onRemoved={() => getRecordingsList().then(setRecordings) }
            />
          )
        }
      </Flex>
    </Flex>
  );
}

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
import { getRecordingsList, RecordingNode, writeRecordingFile } from "./lib/filesystem";

interface SavedTrack {
  blob: Blob,
  title: string
};

interface RecordingJob {
  recorder: MediaRecorder
  promise: Promise<SavedTrack>
}

export default function Home() {
  const [ selectedVideoSources, setSelectedVideoSources ] = useState<Key[]>([]);
  const [ selectedAudioSources, setSelectedAudioSources ] = useState<Key[]>([]);
  const [ selectedDisplayStreams, setSelectedDisplayStreams ]= useState<MediaStream[]>([]);
  const [ recorders, setRecorders ] = useState<MediaRecorder[]>([]);
  const [ recordings, setRecordings ] = useState<RecordingNode[]>([]);

  useEffect(() => {
    getRecordingsList().then(setRecordings);
  }, [])

  const {
    stream,
    getMediaDevices,
    audioInputDevices,
    videoInputDevices,
  } = useMediaStream();

  const isRecording = recorders.length != 0;

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

  const recordTracks = (tracks: MediaStreamTrack[], title: string, options?: MediaRecorderOptions): RecordingJob => {
    const recordedStream = new MediaStream(tracks);
    const newRecorder = new MediaRecorder(recordedStream, options);
    const blobPromise = new Promise<SavedTrack>((resolve, reject) => {

      newRecorder.ondataavailable = event => {
        resolve({
          blob: event.data,
          title: title
        })
      };
      newRecorder.onerror = event => reject(event.error);
      newRecorder.start();
    });

    return {
      recorder: newRecorder,
      promise: blobPromise
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

    let allJobs: RecordingJob[] = [];

    const videoOptions: MediaRecorderOptions = { mimeType: 'video/mp4; codecs="avc1.4d002a"' };
    const audioOptions: MediaRecorderOptions = { mimeType: 'audio/ogg; codecs=vorbis' };

    if(videoTracks.length > 0) {
      const mainJob = recordTracks([videoTracks[0]].concat(audioTracks), 'stream.mp4', videoOptions);
      const videoJobs = videoTracks.slice(1).map((track, index) => recordTracks([track], `video-${index + 1}.mp4`), videoOptions);
      const displayJobs = displayTracks.map((track, index) => recordTracks([track], `display-${index}.mp4`), videoOptions);
      allJobs = [mainJob].concat(videoJobs).concat(displayJobs);
    } else if(displayTracks.length > 0) {
      const mainJob = recordTracks([displayTracks[0]].concat(audioTracks), 'stream.mp4', videoOptions);
      const displayJobs = displayTracks.slice(1).map((track, index) => recordTracks([track], `display-${index + 1}.mp4`), videoOptions);
      allJobs = [mainJob].concat(displayJobs);
    } else {
      allJobs = audioTracks.map((track, index) => recordTracks([track], `audio-${index}.ogg`), audioOptions);
    }

    const allRecorders = allJobs.map(job => job.recorder);
    const allBlobPromises = allJobs.map(job => job.promise);

    setRecorders(allRecorders);

    const allSavedTracks = await Promise.all(allBlobPromises);
    const recordingName = timestamp.toISOString().replace(".", "_");

    await Promise.all(allSavedTracks.map(st => writeRecordingFile(recordingName, st.title, st.blob)));

    setRecordings(await getRecordingsList());
  };

  const stopRecording = () => {
    if(!isRecording) {
      return;
    }

    recorders.forEach(rec => rec.stop());
    setRecorders([]);
  };

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

      <Flex direction="row" gap="size-100">
        {
          recordings.map(r =>
            <SavedRecordingsCard
              key={`saved-recording-${r.name}`}
              recording={r}
              onRemoved={() => getRecordingsList().then(setRecordings) }
            />
          )
        }
      </Flex>
    </Flex>
  );
}

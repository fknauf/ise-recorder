'use client';

import { ActionButton, Divider, Flex, Item, Text, Link, MenuTrigger, Menu, Key, View } from "@adobe/react-spectrum";
import CallCenter from '@spectrum-icons/workflow/CallCenter';
import MovieCamera from '@spectrum-icons/workflow/MovieCamera';
import Circle from '@spectrum-icons/workflow/Circle';
import DeviceDesktop from '@spectrum-icons/workflow/DeviceDesktop';
import Stop from '@spectrum-icons/workflow/Stop';
import { useState } from "react";
import useMediaStream from "use-media-stream";
import VideoPreview from "./lib/VideoPreview";
import AudioPreview from "./lib/AudioPreview";
import { PreviewCard } from "./lib/PreviewCard";

type SavedTrack = {
  blob: Blob,
  title: string
};

type SavedRecording = {
  timestamp: string;
  tracks: SavedTrack[]
};

export default function Home() {
  const [ selectedVideoSources, setSelectedVideoSources ] = useState<Key[]>([]);
  const [ selectedAudioSources, setSelectedAudioSources ] = useState<Key[]>([]);
  const [ selectedDisplayStreams, setSelectedDisplayStreams ]= useState<MediaStream[]>([]);
  const [ recorders, setRecorders ] = useState<MediaRecorder[]>([]);
  const [ savedRecordings, setSavedRecordings ] = useState<SavedRecording[]>([]);

  const {
    stream,
    getMediaDevices,
    audioInputDevices,
    videoInputDevices,
  } = useMediaStream();

  const openDisplayStream = async () => {
    const screenStream = await navigator.mediaDevices.getDisplayMedia();
    setSelectedDisplayStreams(selectedDisplayStreams.concat([screenStream]));
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

  const findTrack = (tracks: MediaStreamTrack[], deviceId: Key) => tracks.find(track => track.getSettings().deviceId == deviceId);
  const findVideoTrack = (deviceId: Key) => findTrack(stream?.getVideoTracks() ?? [], deviceId);
  const findAudioTrack = (deviceId: Key) => findTrack(stream?.getAudioTracks() ?? [], deviceId);

  const isRecording = recorders.length != 0;

  const recordTrack = (tracks: MediaStreamTrack[], title: string) => {
    const recordedStream = new MediaStream(tracks);
    const newRecorder = new MediaRecorder(recordedStream);
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
    const allJobs = allTracks.map((track, index) => recordTrack([track], `track_${index}_${timestamp.toISOString()}`));

    const allRecorders = allJobs.map(job => job.recorder);
    const allBlobPromises = allJobs.map(job => job.promise);

    setRecorders(allRecorders);

    const allBlobs = await Promise.all(allBlobPromises);
    const newRecording: SavedRecording = {
      tracks: allBlobs,
      timestamp: timestamp.toISOString()
    };

    setSavedRecordings(savedRecordings.concat([newRecording]));
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
        <ActionButton onPress={openDisplayStream} isDisabled={isRecording}>
          <DeviceDesktop/>
          <Text>Add Screen/Window</Text>
        </ActionButton>
        <MenuTrigger onOpenChange={getMediaDevices}>
          <ActionButton isDisabled={isRecording}>
            <MovieCamera/>
            <Text>Add Video Source</Text>
          </ActionButton>
          <Menu onAction={addVideoSource}>
            {videoInputDevices.map(
              (dev) => <Item key={dev.deviceId}>{dev.label}</Item>
            )}
          </Menu>
        </MenuTrigger>
        <MenuTrigger onOpenChange={getMediaDevices}>
          <ActionButton isDisabled={isRecording}>
            <CallCenter/>
            <Text>Add Audio Source</Text>
          </ActionButton>
          <Menu onAction={addAudioSource}>
            {audioInputDevices.map(
              (dev) => <Item key={dev.deviceId}>{dev.label}</Item>
            )}
          </Menu>
        </MenuTrigger>
        <Divider orientation="vertical" size="M"/>
        {
            isRecording
            ? <ActionButton onPress={stopRecording}><Stop/> <Text>Stop Recording</Text></ActionButton>
            : <ActionButton onPress={startRecording}><Circle/> <Text>Start Recording</Text></ActionButton>
        }
      </Flex>
      <Flex direction="row" gap="size-100" justifyContent="center" wrap={true}>
        {
          selectedDisplayStreams.map((stream, ix) =>
            <PreviewCard
              key={`preview-card-display-${ix}`}
              label={`Screen capture ${ix}`}
              buttonDisabled={isRecording}
              onRemove={() => {
                selectedDisplayStreams[ix].getTracks().forEach(track => track.stop())
                setSelectedDisplayStreams(selectedDisplayStreams.filter((stream, i) => i != ix));
              }}
            >
              <VideoPreview
                key={`video-preview-display-${ix}`}
                track={stream.getTracks()[0]}
              />
            </PreviewCard>
          )
        }
        {
          selectedVideoSources.map((deviceId) =>
            <PreviewCard
              key={`preview-card-${deviceId}`}
              label={videoInputDevices.find(dev => dev.deviceId == deviceId)?.label}
              buttonDisabled={isRecording}
              onRemove={() => removeVideoSource(deviceId)}
            >
              <VideoPreview
                key={`video-preview-${deviceId}`}
                track={stream?.getVideoTracks().find(track => track.getSettings().deviceId == deviceId)}
              />
            </PreviewCard>
          )
        }
        {
          selectedAudioSources.map(deviceId =>
            <PreviewCard
              key={`preview-card-${deviceId}`}
              label={audioInputDevices.find(dev => dev.deviceId == deviceId)?.label}
              buttonDisabled={isRecording}
              onRemove={() => removeAudioSource(deviceId)}
            >
              <AudioPreview
                key={`audio-preview-${deviceId}`}
                deviceId={deviceId}
                track={stream?.getAudioTracks().find(track => track.getSettings().deviceId == deviceId)}
              />
            </PreviewCard>
          )
        }
      </Flex>
      <Flex direction="row" gap="size-100">
        { savedRecordings.map(
            (recording, recording_index) =>
              <View
                key={`saved-recording-${recording_index}`}
                borderWidth="thin"
                borderColor="light"
                borderRadius="medium"
                padding="size-100"
              >
                <Flex direction="column" justifyContent="center" gap="size-100">
                  <Text>{recording.timestamp}</Text>
                  {
                    recording.tracks.map((track, track_index) =>
                      <Link
                        key={`recording-${recording_index}-track-${track_index}`}
                        download={`recording-${recording.timestamp}-track-${track_index}.webm`}
                        href={URL.createObjectURL(track.blob)}
                      >
                        Download
                      </Link>
                    )
                  }
                  <ActionButton onPress={() => setSavedRecordings(savedRecordings.filter((r, i) => i != recording_index))}>Remove</ActionButton>
                </Flex>
              </View>
          )
        }
      </Flex>
    </Flex>
  );
}

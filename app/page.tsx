'use client';

import { ActionButton, Divider, Flex, Item, Text, MenuTrigger, Menu, Key, View } from "@adobe/react-spectrum";
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

type SavedRecording = {
  chunks: Blob[];
  title: string;
};

export default function Home() {
  const [ selectedVideoSources, setSelectedVideoSources ] = useState<Key[]>([]);
  const [ selectedAudioSources, setSelectedAudioSources ] = useState<Key[]>([]);
  const [ selectedDisplayStreams, setSelectedDisplayStreams ]= useState<MediaStream[]>([]);
  const [ recorder, setRecorder ] = useState<MediaRecorder | null>(null);
  const [ recordedChunks, setRecordedChunks ] = useState<Blob[]>([]);
  const [ savedRecordings, setSavedRecordings ] = useState<SavedRecording[]>([]);

  const openDisplayStream = async () => {
    const screenStream = await navigator.mediaDevices.getDisplayMedia();
    setSelectedDisplayStreams(selectedDisplayStreams.concat([screenStream]));
  }

  const {
    stream,
    getMediaDevices,
    audioInputDevices,
    videoInputDevices,
  } = useMediaStream();

  const addSourceFn =
    <T,>(setter: (newData: T[]) => void, currentData: T[]) =>
      (key: T) => {
        if(!currentData.includes(key)) {
          setter(currentData.concat([key]));
        }
      };
  const removeSourceFn =
    <T,>(setter: (newData: T[]) => void, currentData: T[]) =>
      (key: T) => setter(currentData.filter(src => src != key));

  const addVideoSource = addSourceFn(setSelectedVideoSources, selectedVideoSources);
  const addAudioSource = addSourceFn(setSelectedAudioSources, selectedAudioSources);

  const removeVideoSource = removeSourceFn(setSelectedVideoSources, selectedVideoSources);
  const removeAudioSource = removeSourceFn(setSelectedAudioSources, selectedAudioSources);

  const findTrack = (tracks: MediaStreamTrack[] | undefined, deviceId: Key) => tracks?.find(track => track.getSettings().deviceId == deviceId);
  const findVideoTrack = (deviceId: Key) => findTrack(stream?.getVideoTracks(), deviceId);
  const findAudioTrack = (deviceId: Key) => findTrack(stream?.getAudioTracks(), deviceId);

  const isRecording = recorder != null;

  const startRecording = () => {
    if(isRecording) {
      return;
    }

    const videoTracks = selectedVideoSources.map(findVideoTrack).filter(track => track !== undefined);
    const audioTracks = selectedAudioSources.map(findAudioTrack).filter(track => track !== undefined);
    const displayTracks = selectedDisplayStreams.flatMap(stream => stream.getTracks());
    const allTracks = displayTracks.concat(videoTracks ?? []).concat(audioTracks ?? []);

    if(allTracks.length == 0) {
      return;
    }

    const recordedStream = new MediaStream(allTracks);
    const newRecorder = new MediaRecorder(recordedStream);
    newRecorder.start();
    newRecorder.ondataavailable = ev => {
      setRecordedChunks(recordedChunks.concat([ev.data]))
      console.log(ev);
    };
    newRecorder.onstop = () => {
      const newSavedRecording: SavedRecording = {
        chunks: recordedChunks,
        title: "foobar"
      };

      setSavedRecordings(savedRecordings.concat([newSavedRecording]));
    };

    setRecorder(newRecorder);
  };

  const stopRecording = () => {
    if(!isRecording) {
      return;
    }

    recorder.stop();
    setRecorder(null);
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
            (recording, ix) =>
              <View
                key={`saved-recording-${ix}`}
                borderWidth="thin"
                borderColor="light"
                borderRadius="medium"
                padding="size-100"
              >
                <Flex direction="column">
                  <Text>{recording.title}</Text>
                  <ActionButton onPress={() => setSavedRecordings(savedRecordings.filter((r, i) => i != ix))}>Remove</ActionButton>
                  <ActionButton onPress={() => {}}>Download</ActionButton>
                </Flex>
              </View>
          )
        }
      </Flex>
    </Flex>
  );
}

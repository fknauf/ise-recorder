'use client';

import { ActionButton, Divider, Flex, Item, Text, MenuTrigger, Menu, Key } from "@adobe/react-spectrum";
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

export default function Home() {
  const [ isRecording, setIsRecording ] = useState(false);
  const [ selectedVideoSources, setSelectedVideoSources ] = useState<Key[]>([]);
  const [ selectedAudioSources, setSelectedAudioSources ] = useState<Key[]>([]);
  const [ selectedDisplayStreams, setSelectedDisplayStreams ]= useState<MediaStream[]>([]);

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

  return (
    <Flex direction="column" width="100vw" height="100vh" gap="size-100">
      <Flex direction="row" justifyContent="center" gap="size-100">
        <ActionButton onPress={openDisplayStream}>
          <DeviceDesktop/>
          <Text>Add Screen/Window</Text>
        </ActionButton>
        <MenuTrigger onOpenChange={getMediaDevices}>
          <ActionButton>
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
          <ActionButton>
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
        <ActionButton onPress={() => { setIsRecording(!isRecording) }}>
          {
            isRecording
            ? <><Stop/> <Text>Stop Recording</Text></>
            : <><Circle/> <Text>Start Recording</Text></>
          }
        </ActionButton>
      </Flex>
      <Flex direction="row" gap="size-100" justifyContent="center">
        {
          selectedDisplayStreams.map((stream, ix) =>
            <PreviewCard
              key={`preview-card-display-${ix}`}
              deviceLabel={`Screen capture ${ix}`}
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
                deviceLabel={videoInputDevices.find(dev => dev.deviceId == deviceId)?.label}
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
              deviceLabel={audioInputDevices.find(dev => dev.deviceId == deviceId)?.label}
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
    </Flex>
  );
}

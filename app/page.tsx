'use client';

import { ActionButton, Divider, Flex, Item, Text, View, MenuTrigger, Menu, Key } from "@adobe/react-spectrum";
import CallCenter from '@spectrum-icons/workflow/CallCenter';
import MovieCamera from '@spectrum-icons/workflow/MovieCamera';
import Circle from '@spectrum-icons/workflow/Circle';
import DeviceDesktop from '@spectrum-icons/workflow/DeviceDesktop';
import Stop from '@spectrum-icons/workflow/Stop';
import { useState } from "react";
import useMediaStream from "use-media-stream";
import VideoPreview from "./lib/VideoPreview";
import { appendKey } from "./lib/util";
import AudioPreview from "./lib/AudioPreview";
import { PreviewCard } from "./lib/PreviewCard";

export default function Home() {
  const [ isRecording, setIsRecording ] = useState(false);
  const [ selectedVideoSources, setSelectedVideoSources ] = useState<Key[]>([]);
  const [ selectedAudioSources, setSelectedAudioSources ] = useState<Key[]>([]);

  const {
    start,
    stream,
    getMediaDevices,
    audioInputDevices,
    videoInputDevices,
  } = useMediaStream();

  return (
    <Flex direction="column" width="100vw" height="100vh" gap="size-100">
      <Flex direction="row" justifyContent="center" gap="size-100">
        <ActionButton>
          <DeviceDesktop/>
          <Text>Add Screen/Window</Text>
        </ActionButton>
        <MenuTrigger onOpenChange={() => { start(); getMediaDevices(); }}>
          <ActionButton>
            <MovieCamera/>
            <Text>Add Video Source</Text>
          </ActionButton>
          <Menu onAction={(key) => setSelectedVideoSources(appendKey(selectedVideoSources, key))}>
            {videoInputDevices.map(
              (dev) => <Item key={dev.deviceId}>{dev.label}</Item>
            )}
          </Menu>
        </MenuTrigger>
        <MenuTrigger onOpenChange={() => { start(); getMediaDevices(); }}>
          <ActionButton>
            <CallCenter/>
            <Text>Add Audio Source</Text>
          </ActionButton>
          <Menu onAction={(key) => setSelectedAudioSources(appendKey(selectedAudioSources, key))}>
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
          selectedVideoSources.map((deviceId) =>
            <PreviewCard
                key={`preview-card-${deviceId}`}
                deviceLabel={videoInputDevices.find(dev => dev.deviceId == deviceId)?.label}
                onRemove={() => { setSelectedVideoSources(selectedVideoSources.filter(src => src != deviceId)); }}
            >
              <VideoPreview
                key={`video-preview-${deviceId}`}
                deviceId={deviceId}
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
                onRemove={() => { setSelectedAudioSources(selectedAudioSources.filter(src => src != deviceId)); }}
            >
              <AudioPreview
                key={deviceId}
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

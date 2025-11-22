'use client';

import { ActionButton, Divider, Flex, Item, Text, MenuTrigger, Menu, TextField } from "@adobe/react-spectrum";
import CallCenter from '@spectrum-icons/workflow/CallCenter';
import MovieCamera from '@spectrum-icons/workflow/MovieCamera';
import Circle from '@spectrum-icons/workflow/Circle';
import DeviceDesktop from '@spectrum-icons/workflow/DeviceDesktop';
import Stop from '@spectrum-icons/workflow/Stop';
import { Key, useState } from "react";
import isEmail from 'validator/es/lib/isEmail';
import { unsafeTitleCharacters } from "../utils/recording";
import { showError } from "../utils/errors";

// This is necessary because device ids are not unique in FF 145. See https://bugzilla.mozilla.org/show_bug.cgi?id=2001440
const createDeviceUniqueId = (dev: MediaDeviceInfo) => JSON.stringify([ dev.groupId, dev.deviceId ])
const splitDeviceUniqueId = (devUid: string): [ string, string ] => JSON.parse(devUid);

const trackIsFromDevice = (track: MediaStreamTrack, groupId: string, deviceId: string) =>
  track.getSettings().groupId === groupId && track.getSettings().deviceId == deviceId;

const createDeviceConstraints = (groupId: string, deviceId: string): MediaTrackConstraints =>
  ({
    groupId: { exact: groupId },
    deviceId: { exact: deviceId }
  });

const validateLectureTitle = (title: string) => !unsafeTitleCharacters.test(title) || 'unsafe character in lecture title';
const validateEmail = (email: string) => email.trim() === '' || isEmail(email) || 'invalid e-mail address';

interface RecorderControlsProps {
  lectureTitle: string
  lecturerEmail: string
  isRecording: boolean
  isEmailHidden: boolean
  currentVideoTracks: MediaStreamTrack[],
  currentAudioTracks: MediaStreamTrack[],
  onLectureTitleChanged: (lectureTitle: string) => void
  onLecturerEmailChanged: (lectureTitle: string) => void
  onAddDisplayTracks: (tracks: MediaStreamTrack[]) => void
  onAddVideoTracks: (tracks: MediaStreamTrack[]) => void
  onAddAudioTracks: (tracks: MediaStreamTrack[]) => void
  onStartRecording: () => void
  onStopRecording: () => void
}

export function RecorderControls(
  {
    lectureTitle,
    lecturerEmail,
    isRecording,
    isEmailHidden,
    currentVideoTracks,
    currentAudioTracks,
    onLectureTitleChanged,
    onLecturerEmailChanged,
    onAddDisplayTracks,
    onAddVideoTracks,
    onAddAudioTracks,
    onStartRecording,
    onStopRecording
  }: RecorderControlsProps
) {
  const [ videoDevices, setVideoDevices ] = useState<MediaDeviceInfo[]>([])
  const [ audioDevices, setAudioDevices ] = useState<MediaDeviceInfo[]>([])
  const [ hasPermissions, setHasPermissions ] = useState(false);

  const refreshUserMediaDevices = async () => {
    if(!hasPermissions) {
      try {
        // Request permissions, needs to happen before devices can be enumerated
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        stream.getTracks().forEach(t => t.stop());
        setHasPermissions(true);
      } catch(e) {
        console.log(e);
        showError('Could not obtain user media permissions', e);
      }
    }

    try {
      const devs = await navigator.mediaDevices.enumerateDevices();

      setVideoDevices(devs.filter(dev => dev.kind === 'videoinput'));
      setAudioDevices(devs.filter(dev => dev.kind === "audioinput"));
    } catch(e) {
      console.log(e);
      showError('Could not enumerate devices', e);
    }
  };

  const openDisplayStream = async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia();
      onAddDisplayTracks(screenStream.getVideoTracks());
    } catch(e) {
      console.log(e);
      showError('Could not obtain display stream', e);
    }
  };

  const addVideoDevice = async (devUid: Key) => {
    const [ groupId, deviceId ] = splitDeviceUniqueId(devUid as string);
    if(currentVideoTracks.some(track => trackIsFromDevice(track, groupId, deviceId))) {
        return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: createDeviceConstraints(groupId, deviceId), audio: false });
      onAddVideoTracks(stream.getVideoTracks());
    } catch(e) {
      console.log(e);
      showError('Could not obtain video stream', e);
    }
  }

  const addAudioDevice = async (devUid: Key) => {
    const [ groupId, deviceId ] = splitDeviceUniqueId(devUid as string);
    if(currentAudioTracks.some(track => trackIsFromDevice(track, groupId, deviceId))) {
        return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: createDeviceConstraints(groupId, deviceId), video: false });
      onAddAudioTracks(stream.getAudioTracks());
    } catch(e) {
      console.log(e);
      showError('Could not obtain audio stream', e);
    }
  }

  return (
    <Flex direction="row" justifyContent="center" gap="size-100" marginTop="size-100" wrap>
      <TextField
        label="Lecture Title"
        value={lectureTitle}
        isReadOnly={isRecording}
        isDisabled={isRecording}
        validate={validateLectureTitle}
        onChange={onLectureTitleChanged}
      />

      {
        // E-Mail is only used when the postprocessing job is scheduled, so we can leave it editable during recording.
        isEmailHidden ? <></> :
          <TextField
            label="e-Mail"
            validate={validateEmail}
            value={lecturerEmail}
            onChange={onLecturerEmailChanged}
          />
      }

      <Flex direction="row" justifyContent="center" alignSelf="end" gap="size-100" wrap>
        <Divider orientation="vertical" size="S" marginX="size-100"/>

        <ActionButton onPress={openDisplayStream} isDisabled={isRecording} alignSelf="end">
          <DeviceDesktop/>
          <Text>Add Screen/Window</Text>
        </ActionButton>

        <MenuTrigger onOpenChange={refreshUserMediaDevices}>
          <ActionButton isDisabled={isRecording} alignSelf="end">
            <MovieCamera/>
            <Text>Add Video Source</Text>
          </ActionButton>
          <Menu onAction={addVideoDevice}>
            { videoDevices.map(dev => <Item key={createDeviceUniqueId(dev)}>{dev.label}</Item>) }
          </Menu>
        </MenuTrigger>

        <MenuTrigger onOpenChange={refreshUserMediaDevices}>
          <ActionButton isDisabled={isRecording} alignSelf="end">
            <CallCenter/>
            <Text>Add Audio Source</Text>
          </ActionButton>
          <Menu onAction={addAudioDevice}>
            { audioDevices.map(dev => <Item key={createDeviceUniqueId(dev)}>{dev.label}</Item>) }
          </Menu>
        </MenuTrigger>

        <Divider orientation="vertical" size="S" marginX="size-100"/>

        {
          isRecording
          ? <ActionButton alignSelf="end" onPress={onStopRecording}><Stop/> <Text>Stop Recording</Text></ActionButton>
          : <ActionButton alignSelf="end" onPress={onStartRecording}><Circle/> <Text>Start Recording</Text></ActionButton>
        }
      </Flex>
    </Flex>
  );
}

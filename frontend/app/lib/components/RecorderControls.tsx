"use client";

import { ActionButton, Divider, Flex, Item, Text, Key, MenuTrigger, Menu, TextField, ProgressCircle, View } from "@adobe/react-spectrum";
import CallCenter from "@spectrum-icons/workflow/CallCenter";
import MovieCamera from "@spectrum-icons/workflow/MovieCamera";
import Circle from "@spectrum-icons/workflow/Circle";
import DeviceDesktop from "@spectrum-icons/workflow/DeviceDesktop";
import Stop from "@spectrum-icons/workflow/Stop";
import { useState } from "react";
import isEmail from "validator/es/lib/isEmail";
import { unsafeTitleCharacters } from "../utils/recording";
import { showError } from "../utils/notifications";

export type RecorderState = "idle" | "starting" | "recording" | "stopping";

// This is necessary because device ids are not unique in FF 145. See https://bugzilla.mozilla.org/show_bug.cgi?id=2001440
const createDeviceUniqueId = (dev: MediaDeviceInfo) => JSON.stringify([ dev.groupId, dev.deviceId ]);
const splitDeviceUniqueId = (devUid: string): [ string, string ] => JSON.parse(devUid);

const trackIsFromDevice = (track: MediaStreamTrack, groupId: string, deviceId: string) =>
  track.getSettings().groupId === groupId && track.getSettings().deviceId == deviceId;

const createDeviceConstraints = (groupId: string, deviceId: string): MediaTrackConstraints =>
  ({
    groupId: { exact: groupId },
    deviceId: { exact: deviceId }
  });

const validateLectureTitle = (title: string) => !unsafeTitleCharacters.test(title) || "unsafe character in lecture title";
const validateEmail = (email: string) => email.trim() === "" || isEmail(email) || "invalid e-mail address";

interface RecordButtonProps {
  recorderState: RecorderState
  onStartRecording: () => void
  onStopRecording: () => void
}

function RecordButton(
  { recorderState, onStartRecording, onStopRecording }: Readonly<RecordButtonProps>
) {
  // The design is very human.
  //
  // We're trying to give sensible cues to the user here. That is, a visible "I'm working" signal is given during stopping to
  // pacify the user for a few seconds if we still have to retry sending a chunk, but not while starting because when we switch
  // to the "Stop recording" button the "I'm working" signal disappears even though the user just told the system to start working.
  // So in that case we just disable the button to prevent stop signals from being sent before we're in a state to process them.
  switch(recorderState) {
    case "idle":
      return (
        <ActionButton onPress={onStartRecording}>
          <Circle/>
          <Text>Start Recording</Text>
        </ActionButton>
      );
    case "starting":
      return (
        <ActionButton isDisabled>
          <Stop/>
          <Text>Stop Recording</Text>
        </ActionButton>
      );
    case "recording":
      return (
        <ActionButton onPress={onStopRecording}>
          <Stop/>
          <Text>Stop Recording</Text>
        </ActionButton>
      );
    case "stopping":
      return (
        <ActionButton isDisabled>
          <View paddingX="size-100">
            <ProgressCircle size="S" isIndeterminate/>
          </View>
          <Text>Stop Recording</Text>
        </ActionButton>
      );
  }
}

export interface RecorderControlsProps {
  lectureTitle: string
  lecturerEmail: string
  hasEmailField: boolean
  recorderState: RecorderState
  currentVideoTracks: readonly MediaStreamTrack[]
  currentAudioTracks: readonly MediaStreamTrack[]
  onLectureTitleChanged: (lectureTitle: string) => void
  onLecturerEmailChanged: (lectureTitle: string) => void
  onAddDisplayTracks: (tracks: MediaStreamTrack[]) => void
  onAddVideoTracks: (tracks: MediaStreamTrack[]) => void
  onAddAudioTracks: (tracks: MediaStreamTrack[]) => void
  onStartRecording: () => void
  onStopRecording: () => void
}

/**
 * The controls on top of the main page.
 *
 * This allows adding new streams (removing happens through the preview cards), starting/stopping recordings
 * and setting the lecture title and lecturer email (if a server backend is configured) for postprocessing
 * notifications.
 *
 * Controls are disabled (except for the "stop recording" button) while a recording is underway.
 */
export function RecorderControls(
  {
    lectureTitle,
    lecturerEmail,
    hasEmailField,
    recorderState,
    currentVideoTracks,
    currentAudioTracks,
    onLectureTitleChanged,
    onLecturerEmailChanged,
    onAddDisplayTracks,
    onAddVideoTracks,
    onAddAudioTracks,
    onStartRecording,
    onStopRecording
  }: Readonly<RecorderControlsProps>
) {
  // The controls include menus of available video and audio devices. We obtain these asynchronously
  // and store them here for display.
  const [ videoDevices, setVideoDevices ] = useState<MediaDeviceInfo[]>([]);
  const [ audioDevices, setAudioDevices ] = useState<MediaDeviceInfo[]>([]);
  const [ hasAskedPermission, setHasAskedPermission ] = useState(false);

  // For hotplugging, the device list needs to be refreshed whenever a device menu is opened, so we
  // need to be able to call this more than once. There is as yet no way to just ask for permission
  // to enumerate the available devices, so we ask for the default user media streams, and if the
  // user grants that permission we can also enumerate devices.
  const refreshUserMediaDevices = async () => {
    // Check if the user revoked the permissions. We can't use this as the only check because FF reports
    // permissions as granted before we asked for the first time (but then denies the device enumeration).
    const cameraPermissions = await navigator.permissions.query({ name: "camera" });
    const microphonePermissions = await navigator.permissions.query({ name: "microphone" });

    if(!hasAskedPermission || cameraPermissions.state !== "granted" || microphonePermissions.state !== "granted") {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

        // Technically the user clicked on "add video" or "add audio", but the first time around they
        // most likely want both. FF and Chrome show a dialog allowing the user to select a camera and
        // microphone, and my user study with N = 1 suggests that users always forget about the menu
        // when the dialog pops up and are then confused why the camera and microphone they just
        // selected don't show up in the UI. Long story short, this is POLA compliance, believe it or not.
        onAddVideoTracks(stream.getVideoTracks());
        onAddAudioTracks(stream.getAudioTracks());
        setHasAskedPermission(true);
      } catch(e) {
        showError("Could not obtain user media permissions", e);
      }
    }

    try {
      const devs = await navigator.mediaDevices.enumerateDevices();

      setVideoDevices(devs.filter(dev => dev.kind === "videoinput"));
      setAudioDevices(devs.filter(dev => dev.kind === "audioinput"));
    } catch(e) {
      showError("Could not enumerate devices", e);
    }
  };

  const openDisplayStream = async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia();
      onAddDisplayTracks(screenStream.getVideoTracks());
    } catch(e) {
      showError("Could not obtain display stream", e);
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
      showError("Could not obtain video stream", e);
    }
  };

  const addAudioDevice = async (devUid: Key) => {
    const [ groupId, deviceId ] = splitDeviceUniqueId(devUid as string);
    if(currentAudioTracks.some(track => trackIsFromDevice(track, groupId, deviceId))) {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: createDeviceConstraints(groupId, deviceId), video: false });
      onAddAudioTracks(stream.getAudioTracks());
    } catch(e) {
      showError("Could not obtain audio stream", e);
    }
  };

  const hasDisabledTrackControls = recorderState !== "idle";

  return (
    <Flex direction="row" justifyContent="center" gap="size-100" marginTop="size-100" wrap>
      <TextField
        label="Lecture Title"
        value={lectureTitle}
        isReadOnly={hasDisabledTrackControls}
        isDisabled={hasDisabledTrackControls}
        validate={validateLectureTitle}
        onChange={onLectureTitleChanged}
      />

      {
        hasEmailField &&
          <TextField
            label="e-Mail"
            value={lecturerEmail}
            isReadOnly={hasDisabledTrackControls}
            isDisabled={hasDisabledTrackControls}
            validate={validateEmail}
            onChange={onLecturerEmailChanged}
          />
      }

      <Flex direction="row" alignContent="end" gap="size-100" wrap>
        <Divider orientation="vertical" size="S" marginX="size-100"/>

        <ActionButton onPress={openDisplayStream} isDisabled={hasDisabledTrackControls}>
          <DeviceDesktop/>
          <Text>Add Screen/Window</Text>
        </ActionButton>

        <MenuTrigger onOpenChange={refreshUserMediaDevices}>
          <ActionButton isDisabled={hasDisabledTrackControls}>
            <MovieCamera/>
            <Text>Add Video Source</Text>
          </ActionButton>
          <Menu onAction={addVideoDevice}>
            { videoDevices.map(dev => <Item key={createDeviceUniqueId(dev)}>{dev.label}</Item>) }
          </Menu>
        </MenuTrigger>

        <MenuTrigger onOpenChange={refreshUserMediaDevices}>
          <ActionButton isDisabled={hasDisabledTrackControls}>
            <CallCenter/>
            <Text>Add Audio Source</Text>
          </ActionButton>
          <Menu onAction={addAudioDevice}>
            { audioDevices.map(dev => <Item key={createDeviceUniqueId(dev)}>{dev.label}</Item>) }
          </Menu>
        </MenuTrigger>

        <Divider orientation="vertical" size="S" marginX="size-100"/>

        <RecordButton
          recorderState={recorderState}
          onStartRecording={onStartRecording}
          onStopRecording={onStopRecording}
        />
      </Flex>
    </Flex>
  );
}

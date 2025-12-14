"use client";

import { ActionButton, Divider, Flex, Item, Key, Text, MenuTrigger, Menu, TextField, ProgressCircle, View } from "@adobe/react-spectrum";
import CallCenter from "@spectrum-icons/workflow/CallCenter";
import MovieCamera from "@spectrum-icons/workflow/MovieCamera";
import Circle from "@spectrum-icons/workflow/Circle";
import DeviceDesktop from "@spectrum-icons/workflow/DeviceDesktop";
import Stop from "@spectrum-icons/workflow/Stop";
import isEmail from "validator/es/lib/isEmail";
import { unsafeTitleCharacters } from "../utils/recording";
import { MediaDeviceUid } from "../store/mediaDevicesSlice";

export type RecorderState = "idle" | "starting" | "recording" | "stopping";

const createDeviceKey = (dev: MediaDeviceInfo) =>
  JSON.stringify({ groupId: dev.groupId, deviceId: dev.deviceId } as MediaDeviceUid);
const parseDeviceKey = (devUid: Key): MediaDeviceUid =>
  JSON.parse(devUid as string);

const validateLectureTitle = (title: string) => !unsafeTitleCharacters.test(title) || "unsafe character in lecture title";
const validateEmail = (email: string) => email.trim() === "" || isEmail(email) || "invalid e-mail address";

interface RecordButtonProps {
  recorderState: RecorderState
  onStartRecording?: () => void
  onStopRecording?: () => void
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
            <ProgressCircle size="S" isIndeterminate aria-label="stopping..."/>
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
  videoDevices: readonly MediaDeviceInfo[]
  audioDevices: readonly MediaDeviceInfo[]
  onLectureTitleChanged?: (lectureTitle: string) => void
  onLecturerEmailChanged?: (lectureTitle: string) => void
  onOpenDeviceMenu?: () => void
  onAddDisplayTrack?: () => void
  onAddVideoTrack?: (devUid: MediaDeviceUid) => void
  onAddAudioTrack?: (devUid: MediaDeviceUid) => void
  onStartRecording?: () => void
  onStopRecording?: () => void
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
    videoDevices,
    audioDevices,
    onLectureTitleChanged,
    onLecturerEmailChanged,
    onOpenDeviceMenu,
    onAddDisplayTrack,
    onAddVideoTrack,
    onAddAudioTrack,
    onStartRecording,
    onStopRecording
  }: Readonly<RecorderControlsProps>
) {
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
        autoFocus
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

      <Flex direction="row" alignContent="start" gap="size-100" marginTop="size-300" wrap>
        <Divider orientation="vertical" size="S" marginX="size-100"/>

        <ActionButton onPress={onAddDisplayTrack} isDisabled={hasDisabledTrackControls}>
          <DeviceDesktop/>
          <Text>Add Screen/Window</Text>
        </ActionButton>

        <MenuTrigger onOpenChange={onOpenDeviceMenu}>
          <ActionButton isDisabled={hasDisabledTrackControls}>
            <MovieCamera/>
            <Text>Add Video Source</Text>
          </ActionButton>
          <Menu onAction={devUid => onAddVideoTrack?.(parseDeviceKey(devUid))}>
            { videoDevices.map(dev => <Item key={createDeviceKey(dev)}>{dev.label}</Item>) }
          </Menu>
        </MenuTrigger>

        <MenuTrigger onOpenChange={onOpenDeviceMenu}>
          <ActionButton isDisabled={hasDisabledTrackControls}>
            <CallCenter/>
            <Text>Add Audio Source</Text>
          </ActionButton>
          <Menu onAction={devUid => onAddAudioTrack?.(parseDeviceKey(devUid))}>
            { audioDevices.map(dev => <Item key={createDeviceKey(dev)}>{dev.label}</Item>) }
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

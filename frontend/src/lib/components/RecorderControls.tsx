"use client";

import { ActionButton, Divider, Text, MenuTrigger, Menu, TextField, ProgressCircle, MenuItem } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import CallCenter from "@react-spectrum/s2/icons/CallCenter";
import MovieCamera from "@react-spectrum/s2/icons/MovieCamera";
import Circle from "@react-spectrum/s2/icons/Circle";
import DeviceDesktop from "@react-spectrum/s2/icons/DeviceDesktop";
import Stop from "@react-spectrum/s2/icons/StopProcessing";
import isEmail from "validator/es/lib/isEmail";
import { createDeviceKey } from "../store/store";
import { useActiveRecording, useStartStopRecording } from "../hooks/useActiveRecording";
import { useMediaDevices } from "../hooks/useMediaDevices";
import { useLecture } from "../hooks/useLecture";
import { useServerEnv } from "../hooks/useServerEnv";
import { ActiveRecording } from "../store/store";
import { useMediaTracks } from "../hooks/useMediaTracks";
import { normalizeLectureTitle, sanitizeLectureTitle } from "../utils/recording";
import { useHydrated } from "../hooks/useHydrated";

export type RecorderState = ActiveRecording["state"];

function validateLectureTitle(lectureTitle: string): string | true {
  const normalizedTitle = normalizeLectureTitle(lectureTitle);
  const sanitizedTitle = sanitizeLectureTitle(lectureTitle);

  if(sanitizedTitle === "" && normalizedTitle !== "") {
    return "sanitizes to empty string";
  }

  if(sanitizedTitle !== normalizedTitle) {
    return `sanitizes to ${sanitizedTitle}`;
  }

  return true;
}

const validateEmail = (email: string) => email.trim() === "" || isEmail(email) || "invalid e-mail address";

function RecordButton() {
  // The design is very human.
  //
  // We're trying to give sensible cues to the user here. That is, a visible "I'm working" signal is given during stopping to
  // pacify the user for a few seconds if we still have to retry sending a chunk, but not while starting because when we switch
  // to the "Stop recording" button the "I'm working" signal disappears even though the user just told the system to start working.
  // So in that case we just disable the button to prevent stop signals from being sent before we're in a state to process them.
  const activeRecording = useActiveRecording();
  const mediaTracks = useMediaTracks();
  const hydrated = useHydrated();

  const noTracksConfigured = mediaTracks.displayTracks.length + mediaTracks.videoTracks.length + mediaTracks.audioTracks.length === 0;

  const {
    startRecording,
    stopRecording
  } = useStartStopRecording();

  switch(activeRecording.state) {
    case "idle":
      return (
        // need hydration check here to work around a Firefox limitation: On a soft reload, Firefox's
        // form autocomplete will strip the disabled tag from the SSR-rendered button if the button
        // was enabled before the reload, which then leads to a React hydration error. It'll never add
        // a disabled flag, so we can sidestep it with this check.
        <ActionButton onPress={startRecording} isDisabled={hydrated && noTracksConfigured}>
          <Circle/>
          <Text>Start Recording</Text>
        </ActionButton>
      );
    case "starting":
    case "preparing":
      return (
        <ActionButton isDisabled>
          <Stop/>
          <Text>Stop Recording</Text>
        </ActionButton>
      );
    case "recording":
      return (
        <ActionButton onPress={stopRecording}>
          <Stop/>
          <Text>Stop Recording</Text>
        </ActionButton>
      );
    case "stopping":
      return (
        <ActionButton isDisabled>
          <div className={style({ display: "flex", flexDirection: "row", gap: 8 })}>
            <ProgressCircle size="S" isIndeterminate aria-label="stopping..."/>
            <Text>Stop Recording</Text>
          </div>
        </ActionButton>
      );
  }
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
export function RecorderControls() {
  const {
    apiUrl
  } = useServerEnv();

  const {
    lectureTitle,
    lecturerEmail,
    setLectureTitle,
    setLecturerEmail
  } = useLecture();

  const activeRecording = useActiveRecording();

  const {
    videoDevices,
    audioDevices,
    openDisplayStream,
    openVideoStream,
    openAudioStream,
    refreshMediaDevices
  } = useMediaDevices();

  const isBackendConfigured = apiUrl !== undefined;
  const hasDisabledTrackControls = activeRecording.state !== "idle";

  const onMenuOpenChange = (isOpen: boolean) => {
    if(isOpen) {
      refreshMediaDevices();
    }
  };

  return (
    <div className={style({
      display: "flex",
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "center",
      gap: 8,
      marginTop: 8
    })}
    >
      <TextField
        label="Lecture Title"
        value={lectureTitle}
        isReadOnly={hasDisabledTrackControls}
        isDisabled={hasDisabledTrackControls}
        validate={validateLectureTitle}
        validationBehavior="aria"
        onChange={setLectureTitle}
        autoFocus
      />

      {
        isBackendConfigured &&
          <TextField
            label="e-Mail"
            value={lecturerEmail}
            isReadOnly={hasDisabledTrackControls}
            isDisabled={hasDisabledTrackControls}
            validate={validateEmail}
            validationBehavior="aria"
            onChange={setLecturerEmail}
          />
      }

      <div className={style({
        alignContent: "start",
        display: "flex",
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 8,
        marginTop: 24
      })}
      >
        <Divider orientation="vertical" size="S" styles={style({ marginX: 8 })}/>

        <ActionButton onPress={openDisplayStream} isDisabled={hasDisabledTrackControls}>
          <DeviceDesktop/>
          <Text>Add Screen/Window</Text>
        </ActionButton>

        <MenuTrigger onOpenChange={onMenuOpenChange}>
          <ActionButton isDisabled={hasDisabledTrackControls}>
            <MovieCamera/>
            <Text>Add Video Source</Text>
          </ActionButton>
          <Menu>
            {
              videoDevices.map(dev =>
                <MenuItem
                  key={createDeviceKey(dev)}
                  onAction={() => openVideoStream(dev)}
                >{dev.label}
                </MenuItem>)
            }
          </Menu>
        </MenuTrigger>

        <MenuTrigger onOpenChange={onMenuOpenChange}>
          <ActionButton isDisabled={hasDisabledTrackControls}>
            <CallCenter/>
            <Text>Add Audio Source</Text>
          </ActionButton>
          <Menu>
            {
              audioDevices.map(dev =>
                <MenuItem
                  key={createDeviceKey(dev)}
                  onAction={() => openAudioStream(dev)}
                >{dev.label}
                </MenuItem>)
            }
          </Menu>
        </MenuTrigger>

        <Divider orientation="vertical" size="S" styles={style({ marginX: 8 })}/>

        <RecordButton/>
      </div>
    </div>
  );
}

"use client";

import { MicrophoneIcon, MonitorIcon, RecordIcon, StopIcon, VideoCameraIcon } from "@phosphor-icons/react";
import isEmail from "validator/es/lib/isEmail";
import { createDeviceKey } from "../store/store";
import { useActiveRecording, useStartStopRecording } from "../hooks/useActiveRecording";
import { useMediaDevices } from "../hooks/useMediaDevices";
import { useLecture } from "../hooks/useLecture";
import { ActiveRecording } from "../store/store";
import { useMediaTracks } from "../hooks/useMediaTracks";
import { normalizeLectureTitle, sanitizeLectureTitle } from "../utils/recording";
import { useHydrated } from "../hooks/useHydrated";
import { UserMenu } from "./UserMenu";
import { useAppSession } from "./SessionProvider";
import { ReactNode, useState } from "react";
import { Button, Divider, Group, Input, Loader, Menu, TextInput } from "@mantine/core";

export type RecorderState = ActiveRecording["state"];

function validateLectureTitle(lectureTitle: string): string | undefined {
  const normalizedTitle = normalizeLectureTitle(lectureTitle);
  const sanitizedTitle = sanitizeLectureTitle(lectureTitle);

  if(sanitizedTitle === "" && normalizedTitle !== "") {
    return "sanitizes to empty string";
  }

  if(sanitizedTitle !== normalizedTitle) {
    return `sanitizes to ${sanitizedTitle}`;
  }

  return undefined;
}

const validateEmail = (email: string | undefined) =>
  (email === undefined || email.trim() === "" || isEmail(email)
    ? undefined
    : "invalid e-mail address");

export const UnlabelledRow = ({ children }: Readonly<{ children: ReactNode }>) =>
  <Input.Wrapper label={" "} labelElement="div" labelProps={{ "aria-hidden": true }}>
    <Group>{children}</Group>
  </Input.Wrapper>;

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
        <Button
          data-testid="rc-btn-record"
          onClick={startRecording}
          disabled={hydrated && noTracksConfigured}
          leftSection={<RecordIcon/>}
        >
          Start Recording
        </Button>
      );
    case "starting":
    case "preparing":
      return (
        <Button
          data-testid="rc-btn-record"
          disabled
          leftSection={<StopIcon/>}
        >
          Stop Recording
        </Button>
      );
    case "recording":
      return (
        <Button
          data-testid="rc-btn-record"
          onClick={stopRecording}
          leftSection={<StopIcon/>}
        >
          Stop Recording
        </Button>
      );
    case "stopping":
      return (
        <Button
          data-testid="rc-btn-record"
          disabled
          leftSection={<Loader size="xs" role="progressbar"/>}
        >
          Stop Recording
        </Button>
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
    lectureTitle,
    lecturerEmail,
    isLecturerEmailUsed,
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

  const { authRequired } = useAppSession();

  const [ videoMenuOpen, setVideoMenuOpen ] = useState(false);
  const [ audioMenuOpen, setAudioMenuOpen ] = useState(false);

  const hasDisabledTrackControls = activeRecording.state !== "idle";

  const onMenuOpenChangeHandler = (setOpen: (isOpen: boolean) => void) => async (isOpen: boolean) => {
    setOpen(isOpen);

    if(isOpen) {
      const effect = await refreshMediaDevices();

      // if the refresh handler added video/audio tracks, that means the browser asked for permission
      // and we took that as the main user action. In that case, the user doesn't need the menu anymore,
      // may not even recognize that it's still open, and needs to click twice on whatever he does next
      // to close the menu and only then actually register the desired action. So in that case, close
      // the menu here so the user is in a more expected state.
      if(effect === "added-tracks") {
        setOpen(false);
      }
    }
  };

  const titleError = validateLectureTitle(lectureTitle);
  const emailError = validateEmail(lecturerEmail);

  return (
    <Group wrap="wrap" align="flex-start">
      {
        authRequired && <UnlabelledRow><UserMenu/></UnlabelledRow>
      }

      <TextInput
        label="Lecture Title"
        data-testid="rc-txt-title"
        value={lectureTitle}
        disabled={hasDisabledTrackControls}
        error={titleError}
        onChange={event => setLectureTitle(event.currentTarget.value)}
        h={61}
        autoFocus
      />

      {
        isLecturerEmailUsed &&
          <TextInput
            label="e-Mail"
            data-testid="rc-txt-email"
            value={lecturerEmail}
            disabled={hasDisabledTrackControls}
            error={emailError}
            onChange={event => setLecturerEmail(event.currentTarget.value)}
            h={61}
          />
      }

      <UnlabelledRow>
        <Group>
          <Divider orientation="vertical"/>

          <Button onClick={openDisplayStream} disabled={hasDisabledTrackControls} data-testid="rc-btn-addscreen" leftSection={<MonitorIcon/>}>
            Add Screen/Window
          </Button>

          <Menu opened={videoMenuOpen} onChange={onMenuOpenChangeHandler(setVideoMenuOpen)}>
            <Menu.Target>
              <Button disabled={hasDisabledTrackControls} data-testid="rc-btn-addvideo" leftSection={<VideoCameraIcon/>}>Add Video Source</Button>
            </Menu.Target>
            <Menu.Dropdown>
              { videoDevices.map(dev => <Menu.Item key={createDeviceKey(dev)} onClick={() => openVideoStream(dev)}>{dev.label}</Menu.Item>) }
            </Menu.Dropdown>
          </Menu>

          <Menu opened={audioMenuOpen} onChange={onMenuOpenChangeHandler(setAudioMenuOpen)}>
            <Menu.Target>
              <Button disabled={hasDisabledTrackControls} data-testid="rc-btn-addaudio" leftSection={<MicrophoneIcon/>}>Add Audio Source</Button>
            </Menu.Target>
            <Menu.Dropdown>
              { audioDevices.map(dev => <Menu.Item key={createDeviceKey(dev)} onClick={() => openAudioStream(dev)}>{dev.label}</Menu.Item>) }
            </Menu.Dropdown>
          </Menu>

          <Divider orientation="vertical"/>

          <RecordButton/>
        </Group>
      </UnlabelledRow>
    </Group>
  );
}

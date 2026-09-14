"use client";

import { MediaDeviceUid } from "../store/store";
import { showError } from "../utils/notifications";
import { useAppStore } from "./useAppStore";
import { createDeviceConstraints } from "../store/store";

const trackIsFromDevice = (track: MediaStreamTrack, uid: MediaDeviceUid) =>
  track.getSettings().groupId === uid.groupId && track.getSettings().deviceId === uid.deviceId;

// Extracted into a function to work around a limitation in babel's react-compiler at time of writing: as of
// 2026-09 it can't handle && and || in try blocks.
const userPickedDevices = (userInteractionExpected: boolean, durationMillis: number, thresholdMillis: number) =>
  userInteractionExpected || (durationMillis > thresholdMillis && navigator.userAgent.includes("Firefox"));

async function queryPermissions(name: PermissionName) {
  try {
    const permissions = await navigator.permissions.query({ name });
    return permissions.state;
  } catch(e) {
    // For old browsers that don't support permissions, fall back to denied. We can't really work with them, so
    // that is about the sanest default.
    console.error(`Unable to query ${name} permissions`, e);
    return "denied";
  }
}

export function useMediaDevices() {
  const videoDevices = useAppStore(state => state.videoDevices);
  const audioDevices = useAppStore(state => state.audioDevices);
  const videoTracks = useAppStore(state => state.videoTracks);
  const audioTracks = useAppStore(state => state.audioTracks);
  const obtainedDevicePermissions = useAppStore(state => state.obtainedDevicePermissions);

  const setObtainedDevicePermissions = useAppStore(state => state.setObtainedDevicePermissions);
  const setMediaDevices = useAppStore(state => state.setMediaDevices);
  const addDisplayTracks = useAppStore(state => state.addDisplayTracks);
  const addVideoTracks = useAppStore(state => state.addVideoTracks);
  const addAudioTracks = useAppStore(state => state.addAudioTracks);

  const refreshMediaDevices = async () => {
    // Permissions API is unreliable on Firefox. If the user has granted temporary permission to a site before,
    // then reloads the site or restarts the browser, the permissions API will report "granted" even though the
    // browser is going to prompt. Mozilla's position is that this is in spec, and the spec is evidently written
    // to cover this behavior, insane as it may seem.
    const cameraPermissions = await queryPermissions("camera");
    const microphonePermissions = await queryPermissions("microphone");
    const userInteractionExpected = cameraPermissions === "prompt" || microphonePermissions === "prompt";

    if(!obtainedDevicePermissions || userInteractionExpected) {
      try {
        const before = new Date();

        const stream = await navigator.mediaDevices.getUserMedia({
          video: cameraPermissions !== "denied",
          audio: microphonePermissions !== "denied"
        });

        // Because the user interaction prediction above is unreliable in Firefox, we use a timing side
        // channel on FF to determine whether user interaction has actually occurred. The idea is that
        // rerendering without user interaction should take less than 200 ms and interacting with the
        // permissions dialog should take longer.
        const after = new Date();
        const duration = after.getTime() - before.getTime();

        if(userPickedDevices(userInteractionExpected, duration, 200)) {
          // User just saw the "please grant permissions" dialog and forgot about clicking our menu,
          // so in this case we just add the streams he just selected.
          addVideoTracks(stream.getVideoTracks());
          addAudioTracks(stream.getAudioTracks());
        } else {
          // Here we had the permissions when the site was loaded, so the user didn't select any
          // device for us to get this stream. In this case close the streams and let the user pick
          // from the menu.
          stream.getTracks().forEach(t => t.stop());
        }

        setObtainedDevicePermissions();
      } catch(e) {
        showError("Could not obtain device permissions", e);
      }
    }

    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      setMediaDevices(devs);
    } catch(e) {
      showError("Could not enumerate devices", e);
    }
  };

  const openDisplayStream = async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia();

      addDisplayTracks(screenStream.getVideoTracks());
      // Audio tracks are going to be rare here. This can happen when a user captures
      // a browser tab that's playing audio.
      addAudioTracks(screenStream.getAudioTracks());
    } catch(e) {
      showError("Could not obtain display stream", e);
    }
  };

  const openVideoStream = async (devUid: MediaDeviceUid) => {
    if(videoTracks.some(track => trackIsFromDevice(track, devUid))) {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: createDeviceConstraints(devUid),
        audio: false
      });
      const tracks = stream.getVideoTracks();

      addVideoTracks(tracks);
    } catch(e) {
      showError("Could not obtain video stream", e);
    }
  };

  const openAudioStream = async (devUid: MediaDeviceUid) => {
    if(audioTracks.some(track => trackIsFromDevice(track, devUid))) {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: createDeviceConstraints(devUid)
      });

      addAudioTracks(stream.getAudioTracks());
    } catch(e) {
      showError("Could not obtain audio stream", e);
    }
  };

  return {
    videoDevices,
    audioDevices,
    refreshMediaDevices,
    openDisplayStream,
    openVideoStream,
    openAudioStream
  };
}

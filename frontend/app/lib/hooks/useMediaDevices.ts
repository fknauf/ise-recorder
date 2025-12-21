"use client";

import { MediaDeviceUid } from "../store/store";
import { showError } from "../utils/notifications";
import { useAppStore } from "./useAppStore";

const trackIsFromDevice = (track: MediaStreamTrack, uid: MediaDeviceUid) =>
  track.getSettings().groupId === uid.groupId && track.getSettings().deviceId === uid.deviceId;

const createDeviceConstraints = (devUid: MediaDeviceUid): MediaTrackConstraints =>
  ({
    groupId: { exact: devUid.groupId },
    deviceId: { exact: devUid.deviceId }
  });

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
    // This is unreliable on Firefox. If the user has granted temporary permission to a site before, then reloads
    // the site or restarts the browser, the permissions API will report "granted" even though the browser is going
    // to prompt. Mozilla's position is that this is in spec, and the spec is evidently written to cover this
    // behavior, insane as it may seem.
    const cameraPermissions = await navigator.permissions.query({ name: "camera" }).then(p => p.state);
    const microphonePermissions = await navigator.permissions.query({ name: "microphone" }).then(p => p.state);
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
        // rerendering without user interaction should take less than 200 ms and interacting witht the
        // permissions dialog should take longer.
        const after = new Date();
        const duration = after.getTime() - before.getTime();
        const userInteractionDected = navigator.userAgent.includes("Firefox") && duration > 200;

        if(userInteractionExpected || userInteractionDected) {
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
      const tracks = screenStream.getVideoTracks();

      addDisplayTracks(tracks);
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

"use client";

import { create } from "zustand";
import { showError } from "../utils/notifications";

// This is necessary because device ids are not unique in FF 145. See https://bugzilla.mozilla.org/show_bug.cgi?id=2001440
export const createDeviceUniqueId = (dev: MediaDeviceInfo) => JSON.stringify([ dev.groupId, dev.deviceId ]);
const splitDeviceUniqueId = (devUid: string): [ string, string ] => JSON.parse(devUid);

const trackIsFromDevice = (track: MediaStreamTrack, groupId: string, deviceId: string) =>
  track.getSettings().groupId === groupId && track.getSettings().deviceId === deviceId;

const createDeviceConstraints = (groupId: string, deviceId: string): MediaTrackConstraints =>
  ({
    groupId: { exact: groupId },
    deviceId: { exact: deviceId }
  });

interface MediaStreamState {
  canEnumerateDevices: boolean
  videoDevices: readonly MediaDeviceInfo[]
  audioDevices: readonly MediaDeviceInfo[]
  displayTracks: readonly MediaStreamTrack[]
  videoTracks: readonly MediaStreamTrack[]
  audioTracks: readonly MediaStreamTrack[]
  mainDisplay: MediaStreamTrack | undefined
  overlay: MediaStreamTrack | undefined
}

interface MediaStreamActions {
  refreshMediaDevices: () => Promise<void>
  openDisplayStream: () => Promise<void>
  openVideoStream: (devUid: string) => Promise<void>
  openAudioStream: (devUid: string) => Promise<void>
  selectMainDisplay: (newMainDisplay: MediaStreamTrack | undefined) => void
  selectOverlay: (newOverlay: MediaStreamTrack | undefined) => void
  removeTrack: (track: MediaStreamTrack) => void
}

type MediaStreamStore = MediaStreamState & MediaStreamActions;

export const selectMediaDevices = (state: MediaStreamStore) => ({
  videoDevices: state.videoDevices,
  audioDevices: state.audioDevices,
  refreshMediaDevices: state.refreshMediaDevices
});

export const selectMediaStreamActions = (state: MediaStreamStore) => ({
  openDisplayStream: state.openDisplayStream,
  openVideoStream: state.openVideoStream,
  openAudioStream: state.openAudioStream
});

export const useMediaStreams = create<MediaStreamState & MediaStreamActions>()((set, get) => {
  const unselectTrack = (track: MediaStreamTrack) => {
    set(state => ({
      mainDisplay: state.mainDisplay === track ? undefined : state.mainDisplay,
      overlay: state.overlay === track ? undefined : state.overlay
    }));
  };

  return {
    canEnumerateDevices: false,
    videoDevices: [],
    audioDevices: [],
    displayTracks: [],
    videoTracks: [],
    audioTracks: [],
    mainDisplay: undefined,
    overlay: undefined,

    refreshMediaDevices: async () => {
      // This is unreliable on Firefox 145; there we sometimes get "granted" even if the permission is actually "prompt".
      // I suspect it depends on whether the user has given temporary permission to the site before, but it's hard
      // to be sure. When Firefix misinforms us, we'll ask for permissions as normal but not realize that the user
      // chose devices, so in that case we'll close the streams and the user has to pick from the menu.
      const cameraPermissions = await navigator.permissions.query({ name: "camera" }).then(p => p.state);
      const microphonePermissions = await navigator.permissions.query({ name: "microphone" }).then(p => p.state);
      const userInteractionExpected = cameraPermissions === "prompt" || microphonePermissions === "prompt";

      if(!get().canEnumerateDevices || userInteractionExpected) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: cameraPermissions !== "denied",
            audio: microphonePermissions !== "denied"
          });

          if(userInteractionExpected) {
            // User just saw the "please grant permissions" dialog and forgot about clicking our menu,
            // so in this case we just add the streams he just selected.
            set(state => ({
              videoTracks: [ ...state.videoTracks, ...stream.getVideoTracks() ],
              audioTracks: [ ...state.audioTracks, ...stream.getAudioTracks() ],
              canEnumerateDevices: true
            }));
          } else {
            // Here we had the permissions when the site was loaded, so the user didn't select any
            // device for us to get this stream. In this case close the streams and let the user pick
            // from the menu.
            stream.getTracks().forEach(t => t.stop());
            set({ canEnumerateDevices: true });
          }
        } catch(e) {
          showError("Could not obtain device permissions", e);
        }

        try {
          const devs = await navigator.mediaDevices.enumerateDevices();

          set({
            videoDevices: devs.filter(dev => dev.kind === "videoinput"),
            audioDevices: devs.filter(dev => dev.kind === "audioinput")
          });
        } catch(e) {
          showError("Could not enumerate devices", e);
        }
      }
    },

    openDisplayStream: async () => {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia();
        const tracks = screenStream.getVideoTracks();

        for(const track of tracks) {
          // Remove a track if it ends even if we weren't the ones to end it. This can happen if the user unplugs a device or revokes permissions.
          track.onended = () => {
            unselectTrack(track);
            set(state => ({ displayTracks: state.displayTracks.filter(t => t !== track) }));
          };
        }

        // Usually the first/only captured screen is supposed to be the main display
        set(state => ({
          displayTracks: [ ...state.displayTracks, ...tracks ],
          mainDisplay: state.mainDisplay ?? tracks[0]
        }));
      } catch(e) {
        showError("Could not obtain display stream", e);
      }
    },

    openVideoStream: async devUid => {
      const [ groupId, deviceId ] = splitDeviceUniqueId(devUid);
      if(get().videoTracks.some(track => trackIsFromDevice(track, groupId, deviceId))) {
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: createDeviceConstraints(groupId, deviceId),
          audio: false
        });
        const tracks = stream.getVideoTracks();

        for(const track of tracks) {
          track.onended = () => {
            unselectTrack(track);
            set(state => ({ videoTracks: state.videoTracks.filter(t => t !== track) }));
          };
        }

        // usually the first/only captured camera is supposed to be the overlay
        set(state => ({
          videoTracks: [ ...state.videoTracks, ...tracks ],
          overlay: state.overlay ?? tracks[0]
        }));
      } catch(e) {
        showError("Could not obtain video stream", e);
      }
    },

    openAudioStream: async devUid => {
      const [ groupId, deviceId ] = splitDeviceUniqueId(devUid as string);
      if(get().audioTracks.some(track => trackIsFromDevice(track, groupId, deviceId))) {
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: createDeviceConstraints(groupId, deviceId)
        });
        const tracks = stream.getAudioTracks();

        for(const track of tracks) {
          track.onended = () => {
            set(state => ({ audioTracks: state.audioTracks.filter(t => t !== track) }));
          };
        }

        set(state => ({ audioTracks: [ ...state.audioTracks, ...tracks ] }));
      } catch(e) {
        showError("Could not obtain audio stream", e);
      }
    },

    removeTrack: track => {
      // Track is removed on the "ended" event. The event doesn't fire automatically when we stop the stream ourselves, so we fire it manually.
      track.stop();
      track.dispatchEvent(new Event("ended"));
    },

    selectMainDisplay: (track: MediaStreamTrack | undefined) => {
      set({ mainDisplay: track });
    },

    selectOverlay: (track: MediaStreamTrack | undefined) => {
      set({ overlay: track });
    }
  };
});

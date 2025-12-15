"use client";

import { createStore } from "zustand/vanilla";
import { persist } from "zustand/middleware";
import { ServerEnv } from "../utils/serverEnv";
import { gatherRecordingsList, RecordingFileList } from "../utils/browserStorage";
import { StateCreator } from "zustand";

export type ActiveRecording = {
  state: "idle"
  name?: undefined
} | {
  state: "starting" | "stopping"
  name: string
} | {
  state: "recording"
  name: string
  stop: () => void
};

export type StateUpdate<T> = T | ((old: T) => T);

function applyStateUpdate<T>(oldValue: T, update: StateUpdate<T>) {
  if(update instanceof Function) {
    return update(oldValue);
  } else {
    return update;
  }
}

// This is necessary because device ids are not unique in FF 145. See https://bugzilla.mozilla.org/show_bug.cgi?id=2001440
export interface MediaDeviceUid {
  groupId: string
  deviceId: string
}

export const createDeviceConstraints = (devUid: MediaDeviceUid): MediaTrackConstraints =>
  ({
    groupId: { exact: devUid.groupId },
    deviceId: { exact: devUid.deviceId }
  });

export const fileSizeOverrideKey = (recordingName: string, filename: string) => `${recordingName}/${filename}`;

type TrackSelection = MediaStreamTrack | undefined;

export interface AppStoreState {
  serverEnv: ServerEnv
  lectureTitle: string
  lecturerEmail: string
  obtainedDevicePermissions: boolean
  videoDevices: readonly MediaDeviceInfo[]
  audioDevices: readonly MediaDeviceInfo[]
  displayTracks: readonly MediaStreamTrack[]
  videoTracks: readonly MediaStreamTrack[]
  audioTracks: readonly MediaStreamTrack[]
  mainDisplay: MediaStreamTrack | undefined
  overlay: MediaStreamTrack | undefined
  activeRecording: ActiveRecording
  fileSizeOverrides: Map<string, number>
  quota: number | undefined
  usage: number | undefined
  savedRecordings: readonly RecordingFileList[]

  setLectureTitle: (lectureTitle: string) => void
  setLecturerEmail: (lecturerEmail: string) => void
  setObtainedDevicePermissions: () => void
  setMediaDevices: (devices: MediaDeviceInfo[]) => void
  addDisplayTracks: (tracks: MediaStreamTrack[]) => void
  addVideoTracks: (tracks: MediaStreamTrack[]) => void
  addAudioTracks: (tracks: MediaStreamTrack[]) => void
  removeTrack: (track: MediaStreamTrack) => void
  selectMainDisplay: (newMainDisplay: StateUpdate<TrackSelection>) => void
  selectOverlay: (newOverlay: StateUpdate<TrackSelection>) => void
  setActiveRecording: (newActiveRecording: StateUpdate<ActiveRecording>) => void
  overrideFileSize: (recordingName: string, filename: string, newFileSize: StateUpdate<number>) => void
  resetFileSizeOverrides: () => void
  updateBrowserStorage: () => Promise<void>
  updateQuotaInformation: () => Promise<void>
}

const createRawAppStore = (
  serverEnv: ServerEnv
): StateCreator<AppStoreState, [], [], AppStoreState> => set => ({
  serverEnv,
  lectureTitle: "",
  lecturerEmail: "",
  obtainedDevicePermissions: false,
  videoDevices: [],
  audioDevices: [],
  displayTracks: [],
  videoTracks: [],
  audioTracks: [],
  mainDisplay: undefined,
  overlay: undefined,
  activeRecording: { state: "idle" },
  fileSizeOverrides: new Map<string, number>(),
  quota: undefined,
  usage: undefined,
  savedRecordings: [],

  setLectureTitle: lectureTitle => set({ lectureTitle }),
  setLecturerEmail: lecturerEmail => set({ lecturerEmail }),
  setObtainedDevicePermissions: () => set({ obtainedDevicePermissions: true }),

  setMediaDevices: devs =>
    set({
      videoDevices: devs.filter(dev => dev.kind === "videoinput"),
      audioDevices: devs.filter(dev => dev.kind === "audioinput")
    }),

  addDisplayTracks: tracks => {
    for(const track of tracks) {
      // Remove a track if it ends even if we weren't the ones to end it. This can happen if the user unplugs a device or revokes permissions.
      track.onended = () => {
        set(state => ({
          mainDisplay: state.mainDisplay === track ? undefined : state.mainDisplay,
          overlay: state.overlay === track ? undefined : state.overlay,
          displayTracks: state.displayTracks.filter(t => t !== track)
        }));
      };
    }

    set(state => ({ displayTracks: [ ...state.displayTracks, ...tracks ] }));
  },

  addVideoTracks: tracks => {
    for(const track of tracks) {
      track.onended = () => {
        set(state => ({
          mainDisplay: state.mainDisplay === track ? undefined : state.mainDisplay,
          overlay: state.overlay === track ? undefined : state.overlay,
          videoTracks: state.videoTracks.filter(t => t !== track)
        }));
      };
    }

    set(state => ({ videoTracks: [ ...state.videoTracks, ...tracks ] }));
  },

  addAudioTracks: tracks => {
    for(const track of tracks) {
      // Remove a track if it ends even if we weren't the ones to end it. This can happen if the user unplugs a device or revokes permissions.
      track.onended = () => {
        set(state => ({ audioTracks: state.audioTracks.filter(t => t !== track) }));
      };
    }

    set(state => ({ audioTracks: [ ...state.audioTracks, ...tracks ] }));
  },

  removeTrack: track => {
    // Track is removed on the "ended" event. The event doesn't fire automatically when we stop the stream ourselves, so we fire it manually.
    track.stop();
    track.dispatchEvent(new Event("ended"));
  },

  selectMainDisplay: (newMainDisplay: StateUpdate<TrackSelection>) =>
    set(state => ({ mainDisplay: applyStateUpdate(state.mainDisplay, newMainDisplay) })),
  selectOverlay: (newOverlay: StateUpdate<TrackSelection>) =>
    set(state => ({ overlay: applyStateUpdate(state.overlay, newOverlay) })),

  setActiveRecording: newActiveRecording =>
    set(state => ({ activeRecording: applyStateUpdate(state.activeRecording, newActiveRecording) })),

  overrideFileSize: (recordingName: string, filename: string, newFileSize: StateUpdate<number>) => {
    set(state => {
      const key = fileSizeOverrideKey(recordingName, filename);
      const oldSize = state.fileSizeOverrides.get(key) ?? 0;
      const newSize = applyStateUpdate(oldSize, newFileSize);

      return {
        fileSizeOverrides: new Map(state.fileSizeOverrides).set(key, newSize)
      };
    });
  },

  resetFileSizeOverrides: () => set({ fileSizeOverrides: new Map() }),

  updateQuotaInformation: async () => {
    const { quota, usage } = await navigator.storage.estimate();
    set({ quota, usage });
  },

  updateBrowserStorage: async () => {
    const [ fs, recordings ] = await Promise.all([
      navigator.storage.estimate(),
      gatherRecordingsList()
    ]);

    set({
      quota: fs.quota,
      usage: fs.usage,
      savedRecordings: recordings
    });
  }
});

export const createAppStore = (
  serverEnv: ServerEnv
) => createStore<AppStoreState>()(
  persist(
    createRawAppStore(serverEnv),
    {
      name: "ise-record-storage",
      partialize: state => ({
        lectureTitle: state.lectureTitle,
        lecturerEmail: state.lecturerEmail
      })
    }
  )
);

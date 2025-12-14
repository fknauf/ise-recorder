"use client";

import { StateCreator } from "zustand";
import { AppStoreState } from "./store";

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

export interface MediaDevicesState {
  obtainedDevicePermissions: boolean
  videoDevices: readonly MediaDeviceInfo[]
  audioDevices: readonly MediaDeviceInfo[]

  setObtainedDevicePermissions: () => void
  setMediaDevices: (devices: MediaDeviceInfo[]) => void
}

export const createMediaDevicesSlice: StateCreator<
  AppStoreState,
  [],
  [],
  MediaDevicesState
> = set => ({
  obtainedDevicePermissions: false,
  videoDevices: [],
  audioDevices: [],

  setObtainedDevicePermissions: () => set({ obtainedDevicePermissions: true }),

  setMediaDevices: devs =>
    set({
      videoDevices: devs.filter(dev => dev.kind === "videoinput"),
      audioDevices: devs.filter(dev => dev.kind === "audioinput")
    })
});

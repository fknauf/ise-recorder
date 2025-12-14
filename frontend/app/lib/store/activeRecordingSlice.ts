"use client";

import { StateCreator } from "zustand";
import { AppStoreState } from "./store";

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

export interface ActiveRecordingState {
  activeRecording: ActiveRecording
  fileSizeOverrides: Map<string, number>

  setActiveRecording: (newState: ActiveRecording | ((oldState: ActiveRecording) => ActiveRecording)) => void
  registerChunk: (recordingName: string, filename: string, chunkSize: number) => void
  resetFileSizeOverrides: () => void
}

export const fileSizeOverrideKey = (recordingName: string, filename: string) => `${recordingName}/${filename}`;

export const createActiveRecordingSlice: StateCreator<
  AppStoreState,
  [],
  [],
  ActiveRecordingState
> = set => ({
  activeRecording: { state: "idle" },
  fileSizeOverrides: new Map<string, number>(),

  setActiveRecording: newState => {
    if(newState instanceof Function) {
      set(state => ({ activeRecording: newState(state.activeRecording) }));
    } else {
      set({ activeRecording: newState });
    }
  },

  registerChunk: (recordingName: string, filename: string, chunkSize: number) => {
    set(state => {
      const key = fileSizeOverrideKey(recordingName, filename);
      const oldSize = state.fileSizeOverrides.get(key) ?? 0;
      const newSize = oldSize + chunkSize;

      return {
        fileSizeOverrides: new Map(state.fileSizeOverrides).set(key, newSize)
      };
    });
  },

  resetFileSizeOverrides: () => set({ fileSizeOverrides: new Map() })
});

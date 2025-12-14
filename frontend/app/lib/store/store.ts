"use client";

import { createStore } from "zustand/vanilla";
import { ActiveRecordingState, createActiveRecordingSlice } from "./activeRecordingSlice";
import { createMediaDevicesSlice, MediaDevicesState } from "./mediaDevicesSlice";
import { createMediaStreamsSlice, MediaTracksState } from "./mediaTracksSlice";
import { BrowserStorageState, createBrowserStorageSlice } from "./browserStorageSlice";
import { ServerEnv } from "../utils/serverEnv";
import { createServerEnvSlice, ServerEnvState } from "./serverEnvSlice";

export type AppStoreState =
  MediaDevicesState &
  MediaTracksState &
  ActiveRecordingState &
  BrowserStorageState &
  ServerEnvState;

export const createAppStore = (
  serverEnv: ServerEnv
) => createStore<AppStoreState>()((...a) => (
  {
    ...createMediaDevicesSlice(...a),
    ...createMediaStreamsSlice(...a),
    ...createActiveRecordingSlice(...a),
    ...createBrowserStorageSlice(...a),
    ...createServerEnvSlice(serverEnv)(...a)
  }
));

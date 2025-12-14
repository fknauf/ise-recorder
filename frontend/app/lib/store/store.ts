"use client";

import { createStore } from "zustand/vanilla";
import { persist } from "zustand/middleware";
import { ActiveRecordingState, createActiveRecordingSlice } from "./activeRecordingSlice";
import { createMediaDevicesSlice, MediaDevicesState } from "./mediaDevicesSlice";
import { createMediaStreamsSlice, MediaTracksState } from "./mediaTracksSlice";
import { BrowserStorageState, createBrowserStorageSlice } from "./browserStorageSlice";
import { ServerEnv } from "../utils/serverEnv";
import { createServerEnvSlice, ServerEnvState } from "./serverEnvSlice";
import { createLectureSlice, LectureState } from "./lectureSlice";

export type AppStoreState =
  MediaDevicesState &
  MediaTracksState &
  ActiveRecordingState &
  BrowserStorageState &
  ServerEnvState &
  LectureState;

export const createAppStore = (
  serverEnv: ServerEnv
) => createStore<AppStoreState>()(
  persist(
    (...a) => ({
      ...createServerEnvSlice(serverEnv)(...a),
      ...createLectureSlice(...a),
      ...createMediaDevicesSlice(...a),
      ...createMediaStreamsSlice(...a),
      ...createActiveRecordingSlice(...a),
      ...createBrowserStorageSlice(...a)
    }),
    {
      name: "ise-record-storage",
      partialize: state => ({
        lectureTitle: state.lectureTitle,
        lecturerEmail: state.lecturerEmail
      })
    }
  )
);

"use client";

import { StateCreator } from "zustand";
import { AppStoreState } from "./store";

export interface LectureState {
  lectureTitle: string
  lecturerEmail: string

  setLectureTitle: (lectureTitle: string) => void
  setLecturerEmail: (lecturerEmail: string) => void
}

export const createLectureSlice: StateCreator<
  AppStoreState,
  [],
  [],
  LectureState
> = set => ({
  lectureTitle: "",
  lecturerEmail: "",

  setLectureTitle: lectureTitle => set({ lectureTitle }),
  setLecturerEmail: lecturerEmail => set({ lecturerEmail })
});

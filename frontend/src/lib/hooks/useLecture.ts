"use client";

import { useAppStore } from "./useAppStore";

export function useLecture() {
  const lectureTitle = useAppStore(state => state.lectureTitle);
  const lecturerEmail = useAppStore(state => state.lecturerEmail);
  const setLectureTitle = useAppStore(state => state.setLectureTitle);
  const setLecturerEmail = useAppStore(state => state.setLecturerEmail);

  return {
    lectureTitle,
    lecturerEmail,
    setLectureTitle,
    setLecturerEmail
  };
}

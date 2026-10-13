"use client";

import { useAppStore } from "./useAppStore";
import { useServerEnv } from "./useServerEnv";

export function useLecture() {
  const lectureTitle = useAppStore(state => state.lectureTitle);
  const lecturerEmail = useAppStore(state => state.lecturerEmail);
  const setLectureTitle = useAppStore(state => state.setLectureTitle);
  const setLecturerEmail = useAppStore(state => state.setLecturerEmail);
  const { apiUrl, smtpRecipientOverride: smtpRecipient } = useServerEnv();

  const isLecturerEmailUsed = apiUrl !== undefined && smtpRecipient !== "disabled";

  return {
    lectureTitle,
    lecturerEmail: isLecturerEmailUsed ? lecturerEmail : undefined,
    isLecturerEmailUsed,
    setLectureTitle,
    setLecturerEmail
  };
}

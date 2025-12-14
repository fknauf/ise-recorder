import useLocalStorageState from "use-local-storage-state";

export function useLecture() {
  const [ lectureTitle, setLectureTitle ] = useLocalStorageState<string>("lecture-title", { defaultValue: "", storageSync: false });
  const [ lecturerEmail, setLecturerEmail ] = useLocalStorageState<string>("lecturer-email", { defaultValue: "", storageSync: false });

  return {
    lectureTitle,
    lecturerEmail,
    setLectureTitle,
    setLecturerEmail
  };
}

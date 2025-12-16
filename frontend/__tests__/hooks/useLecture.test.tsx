import { beforeEach, expect, test } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { AppStoreProvider } from "@/app/lib/hooks/useAppStore";
import { ReactNode, useEffect } from "react";
import { useLecture } from "@/app/lib/hooks/useLecture";

const wrapper = ({ children }: Readonly<{ children: ReactNode }>) =>
  <AppStoreProvider serverEnv={{ apiUrl: "http://localhost:5000" }}>
    {children}
  </AppStoreProvider>;

beforeEach(() => {
  localStorage.clear();
});

test("useLecture starts with empty data", () => {
  const renderResult = renderHook(() => useLecture(), { wrapper });

  expect(renderResult.result.current.lectureTitle).toBe("");
  expect(renderResult.result.current.lecturerEmail).toBe("");
});


test("useLecture handles lecture data", () => {
  const renderResult = renderHook(() => {
    const {
      lectureTitle,
      lecturerEmail,
      setLectureTitle,
      setLecturerEmail
    } = useLecture();

    useEffect(() => {
      setLectureTitle("GVS");
      setLecturerEmail("someoneelse@vss.uni-hannover.de");
    }, [ setLectureTitle, setLecturerEmail ]);

    return { lectureTitle, lecturerEmail };
  }, { wrapper });

  waitFor(() => {
    expect(renderResult.result.current.lectureTitle).toBe("GVS");
    expect(renderResult.result.current.lecturerEmail).toBe("someoneelse@vss.uni-hannover.de");
  });
});

test("useLecture persists data", () => {
  renderHook(() => {
    const {
      setLectureTitle,
      setLecturerEmail
    } = useLecture();

    useEffect(() => {
      setLectureTitle("GVS");
      setLecturerEmail("someoneelse@vss.uni-hannover.de");
    }, [ setLectureTitle, setLecturerEmail ]);
  }, { wrapper });

  // Render in new instance of AppStoreProvider
  const renderResult = renderHook(() => useLecture(), { wrapper });

  expect(renderResult.result.current.lectureTitle).toBe("GVS");
  expect(renderResult.result.current.lecturerEmail).toBe("someoneelse@vss.uni-hannover.de");
});

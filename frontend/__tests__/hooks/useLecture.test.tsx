import { afterEach, beforeEach, expect, test } from "vitest";
import { appStoreWrapper } from "../helpers/appStore";
import { act, renderHook } from "@testing-library/react";
import { useLecture } from "@/lib/hooks/useLecture";

// The hook only selects from the store; that the store starts empty and persists the lecture
// data is the store's business, in store/store.test.tsx.

const wrapper = appStoreWrapper();

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

test("useLecture reads and sets the lecture data in the store", () => {
  const { result } = renderHook(() => useLecture(), { wrapper });

  expect(result.current.lectureTitle).toBe("");
  expect(result.current.lecturerEmail).toBe("");

  act(() => {
    result.current.setLectureTitle("GVS");
    result.current.setLecturerEmail("someoneelse@vss.uni-hannover.de");
  });

  expect(result.current.lectureTitle).toBe("GVS");
  expect(result.current.lecturerEmail).toBe("someoneelse@vss.uni-hannover.de");
});

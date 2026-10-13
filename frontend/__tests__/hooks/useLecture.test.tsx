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


// --- whether the lecture needs an address ------------------------------------
//
// Only for a backend that sends reports and lets the lecturer name the recipient. Where there
// is none, the hook hands out no address at all, so nothing the store kept from an earlier
// deployment -- it persists the lecture data -- reaches a render request.

test.each([
  [ "a backend", { apiUrl: "http://localhost:5000" }, true ],
  [ "a backend that offers the field", { apiUrl: "http://localhost:5000", smtpRecipientOverride: "default" as const }, true ],
  [ "no backend", { apiUrl: undefined }, false ],
  [ "a backend that does not offer the field", { apiUrl: "http://localhost:5000", smtpRecipientOverride: "disabled" as const }, false ]
])("whether an address is wanted, with %s", (_label, serverEnv, wanted) => {
  const { result } = renderHook(() => useLecture(), { wrapper: appStoreWrapper(serverEnv) });

  act(() => result.current.setLecturerEmail("lecturer@vss.uni-hannover.de"));

  expect(result.current.isLecturerEmailUsed).toBe(wanted);
  expect(result.current.lecturerEmail).toBe(wanted ? "lecturer@vss.uni-hannover.de" : undefined);
});

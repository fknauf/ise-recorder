import { beforeEach, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { AppStoreProvider, useAppStore } from "@/lib/hooks/useAppStore";
import { useReupload } from "@/lib/hooks/useReupload";
import { useLecture } from "@/lib/hooks/useLecture";
import { gatherRecordingsList, getAllRecordingTracks } from "@/lib/utils/browserStorage";
import { schedulePostprocessing, uploadFile } from "@/lib/utils/serverStorage";
import { showError } from "@/lib/utils/notifications";

// Sends a locally saved recording to the server under a name of its own, so it cannot mix
// with whatever the live upload left there, and schedules its postprocessing. How a file is
// split into chunks is uploadFile's business, in serverStorage.test.ts; where the button
// appears and when it can be pressed is SavedRecordingsSection.test.tsx's.

const wrapper = ({ children }: Readonly<{ children: ReactNode }>) =>
  <AppStoreProvider serverEnv={{ apiUrl: "http://localhost:5000" }}>
    {children}
  </AppStoreProvider>;

vi.mock("@/lib/utils/browserStorage");
vi.mock("@/lib/utils/serverStorage");
vi.mock("@/lib/utils/notifications", () => ({
  showError: vi.fn(),
  showSuccess: vi.fn(),
  showMessage: vi.fn()
}));

const getAccessToken = async () => "test-token";
vi.mock("@/lib/components/SessionProvider", () => ({
  useAppSession: () => ({ getAccessToken })
}));

// the refresh goes through the SWR cache, which is useProcessedRecordings.test.tsx's business
const refreshProcessedRecordings = vi.fn();
vi.mock("@/lib/hooks/useProcessedRecordings", () => ({
  useRefreshProcessedRecordings: () => refreshProcessedRecordings
}));

const trackOf = (trackName: string) => ({ trackName, file: new File([ trackName ], `${trackName}.webm`) });

beforeEach(() => {
  vi.mocked(getAllRecordingTracks).mockReset();
  vi.mocked(uploadFile).mockReset();
  vi.mocked(uploadFile).mockResolvedValue(true);
  vi.mocked(schedulePostprocessing).mockReset();
  vi.mocked(schedulePostprocessing).mockResolvedValue(true);
  vi.mocked(showError).mockClear();
  refreshProcessedRecordings.mockClear();
  vi.mocked(gatherRecordingsList).mockResolvedValue([]);
  navigator.storage.estimate = vi.fn().mockResolvedValue({ quota: 10 * 2 ** 30, usage: 0 });
});

/**
 * The hook for one recording, plus a second one for a recording next to it and the store's
 * progress map, so a test can see that an upload touches its own recording and no other.
 */
function renderReupload(recordingName = "GVS_2025") {
  const rendered = renderHook(() => ({
    upload: useReupload(recordingName),
    neighbour: useReupload("PSU_2026"),
    lecture: useLecture(),
    progress: useAppStore(state => state.reuploadProgress)
  }), { wrapper });

  act(() => rendered.result.current.lecture.setLecturerEmail("lecturer@example.edu"));

  return rendered;
}

const destination = expect.objectContaining({ apiUrl: "http://localhost:5000", getAccessToken, streamingImpeded: false });

test("every track goes up under a name of its own, then the job is scheduled", async () => {
  vi.mocked(getAllRecordingTracks).mockResolvedValue([ trackOf("overlay"), trackOf("stream") ]);
  const { result } = renderReupload();

  await act(() => result.current.upload.reupload());

  expect(getAllRecordingTracks).toHaveBeenCalledExactlyOnceWith("GVS_2025");
  expect(vi.mocked(uploadFile).mock.calls.map(([ , file, recording, track ]) => [ recording, track, (file as File).name ])).toStrictEqual([
    [ "GVS_2025-reupload", "overlay", "overlay.webm" ],
    [ "GVS_2025-reupload", "stream", "stream.webm" ]
  ]);
  expect(uploadFile).toHaveBeenCalledWith(destination, expect.anything(), expect.anything(), expect.anything(), expect.any(Function), expect.anything());
  // the report goes to whoever is in the lecture form now; the backend keeps no record of
  // the original recipient
  expect(schedulePostprocessing).toHaveBeenCalledExactlyOnceWith(destination, "GVS_2025-reupload", "lecturer@example.edu", expect.anything());
  expect(refreshProcessedRecordings).toHaveBeenCalledOnce();
});

test("the job is only scheduled once every track is up", async () => {
  // a job that started early would render whatever had arrived so far
  const order: string[] = [];
  vi.mocked(getAllRecordingTracks).mockResolvedValue([ trackOf("overlay"), trackOf("stream") ]);
  vi.mocked(uploadFile).mockImplementation(async (_d, _f, _r, track) => {
    order.push(`upload ${track}`);
    return true;
  });
  vi.mocked(schedulePostprocessing).mockImplementation(async () => {
    order.push("schedule");
    return true;
  });
  const { result } = renderReupload();

  await act(() => result.current.upload.reupload());

  expect(order).toStrictEqual([ "upload overlay", "upload stream", "schedule" ]);
});

test("a recording that is not being uploaded says so", () => {
  const { result } = renderReupload();

  expect(result.current.upload.isUploading).toBe(false);
  expect(result.current.upload.progress).toBeUndefined();
});

test("the recording is marked as uploading for exactly as long as the upload runs", async () => {
  let finishUpload: (succeeded: boolean) => void = () => {};
  vi.mocked(getAllRecordingTracks).mockResolvedValue([ trackOf("stream") ]);
  vi.mocked(uploadFile).mockReturnValue(new Promise(resolve => {
    finishUpload = resolve;
  }));
  const { result } = renderReupload();

  let running: Promise<void> = Promise.resolve();
  act(() => {
    running = result.current.upload.reupload();
  });

  // under the local name, which is what the card is keyed by -- not the upload name --
  // and at zero before the first chunk is through, so the card changes at once
  await waitFor(() => expect(result.current.upload.isUploading).toBe(true));
  expect(result.current.upload.progress).toBe(0);
  expect(result.current.progress).toStrictEqual(new Map([ [ "GVS_2025", 0 ] ]));
  // the recording next to it is not caught up in it
  expect(result.current.neighbour.isUploading).toBe(false);

  await act(async () => {
    finishUpload(true);
    await running;
  });

  expect(result.current.upload.isUploading).toBe(false);
  expect(result.current.upload.progress).toBeUndefined();
  expect(result.current.progress).toStrictEqual(new Map());
});

test("a failed track stops the upload before anything is scheduled", async () => {
  // the tracks after it would only make a partial recording look complete
  vi.mocked(getAllRecordingTracks).mockResolvedValue([ trackOf("audio-0"), trackOf("overlay"), trackOf("stream") ]);
  vi.mocked(uploadFile).mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);
  const { result } = renderReupload();

  await act(() => result.current.upload.reupload());

  expect(vi.mocked(uploadFile).mock.calls.map(([ , , , track ]) => track)).toStrictEqual([ "audio-0", "overlay" ]);
  expect(schedulePostprocessing).not.toHaveBeenCalled();
  expect(showError).toHaveBeenCalledWith(expect.stringContaining("overlay"));
  // released and refreshed all the same, so the button can be pressed again
  expect(result.current.upload.isUploading).toBe(false);
  expect(refreshProcessedRecordings).toHaveBeenCalledOnce();
});

test("a recording without any tracks says so instead of doing nothing", async () => {
  vi.mocked(getAllRecordingTracks).mockResolvedValue([]);
  const { result } = renderReupload();

  await act(() => result.current.upload.reupload());

  expect(uploadFile).not.toHaveBeenCalled();
  expect(schedulePostprocessing).not.toHaveBeenCalled();
  expect(showError).toHaveBeenCalledWith(expect.stringContaining("GVS_2025"));
  expect(result.current.upload.isUploading).toBe(false);
});

test("an upload that blows up is reported and gives the button back", async () => {
  vi.mocked(getAllRecordingTracks).mockResolvedValue([ trackOf("stream") ]);
  vi.mocked(uploadFile).mockRejectedValue(new Error("boom"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const { result } = renderReupload();

  await act(() => result.current.upload.reupload());

  expect(showError).toHaveBeenCalledWith(expect.stringContaining("GVS_2025-reupload"));
  expect(result.current.upload.isUploading).toBe(false);
  expect(refreshProcessedRecordings).toHaveBeenCalledOnce();
  error.mockRestore();
});

test("progress is the share of all tracks' bytes that has arrived", async () => {
  // counted across tracks rather than per track, so it does not start over at each one
  const sized = (trackName: string, size: number) => ({ trackName, file: new File([ new Uint8Array(size) ], `${trackName}.webm`) });
  vi.mocked(getAllRecordingTracks).mockResolvedValue([ sized("overlay", 100), sized("stream", 300) ]);

  const gates: (() => void)[] = [];
  const gate = () => new Promise<void>(resolve => gates.push(resolve));

  vi.mocked(uploadFile)
    .mockImplementationOnce(async (_d, file, _r, _t, signalProgress) => {
      signalProgress?.(file.size);
      await gate();
      return true;
    })
    .mockImplementationOnce(async (_d, _f, _r, _t, signalProgress) => {
      signalProgress?.(150);
      await gate();
      signalProgress?.(150);
      return true;
    });

  const { result } = renderReupload();

  let running: Promise<void> = Promise.resolve();
  act(() => {
    running = result.current.upload.reupload();
  });

  await waitFor(() => expect(result.current.upload.progress).toBe(25));
  act(() => gates.shift()!());

  await waitFor(() => expect(result.current.upload.progress).toBe(62.5));
  await act(async () => {
    gates.shift()!();
    await running;
  });

  expect(result.current.upload.progress).toBeUndefined();
});

test("a recording whose files are all empty goes up without its progress becoming NaN", async () => {
  // nothing to divide by; a NaN would reach the progress circle as its value
  const empty = (trackName: string) => ({ trackName, file: new File([], `${trackName}.webm`) });
  vi.mocked(getAllRecordingTracks).mockResolvedValue([ empty("overlay"), empty("stream") ]);

  const seen: (number | undefined)[] = [];
  vi.mocked(uploadFile).mockImplementation(async (_d, file, _r, _t, signalProgress) => {
    signalProgress?.(file.size);
    return true;
  });

  const { result } = renderHook(() => {
    const hook = useReupload("GVS_2025");
    seen.push(hook.progress);
    return hook;
  }, { wrapper });

  await act(() => result.current.reupload());

  expect(seen.filter(progress => progress !== undefined).length).toBeGreaterThan(0);
  expect(seen.every(progress => progress === undefined || Number.isFinite(progress))).toBe(true);
  expect(schedulePostprocessing).toHaveBeenCalledOnce();
});

import { beforeEach, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { AppStoreProvider, useAppStore } from "@/lib/hooks/useAppStore";
import { useBrowserStorage, useReuploadSavedRecording } from "@/lib/hooks/useBrowserStorage";
import { ReactNode, useEffect } from "react";
import { gatherRecordingsList, getAllRecordingTracks, RecordingFileList } from "@/lib/utils/browserStorage";
import { schedulePostprocessing, uploadFile } from "@/lib/utils/serverStorage";
import { showError } from "@/lib/utils/notifications";
import { useLecture } from "@/lib/hooks/useLecture";

const wrapper = ({ children }: Readonly<{ children: ReactNode }>) =>
  <AppStoreProvider serverEnv={{ apiUrl: "http://localhost:5000" }}>
    {children}
  </AppStoreProvider>;

const mockRecordings: RecordingFileList[] = [
  {
    name: "FOO",
    files: [
      {
        name: "stream.webm",
        size: 1.23 * 2 ** 20
      }
    ]
  },
  {
    name: "BAR",
    files: [
      {
        name: "stream.webm",
        size: undefined
      },
      {
        name: "overlay.webm",
        size: undefined
      }
    ]
  }
];

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

test("useBrowserStorage initializes at first render", async () => {
  vi.mocked(gatherRecordingsList).mockResolvedValue(mockRecordings);
  navigator.storage.estimate = vi.fn().mockImplementation(async () => ({
    quota: 10 * 2 ** 30,
    usage: 1234
  }));

  const renderResult = renderHook(() => useBrowserStorage(), { wrapper });

  await waitFor(() => {
    expect(vi.mocked(gatherRecordingsList)).toHaveBeenCalledOnce();

    expect(renderResult.result.current.savedRecordings).toStrictEqual(mockRecordings);
    expect(renderResult.result.current.quota).toBe(10 * 2 ** 30);
    expect(renderResult.result.current.usage).toBe(1234);
  });
});

test("useBrowserStorage reacts to file size overrides", async () => {
  vi.mocked(gatherRecordingsList).mockResolvedValue(mockRecordings);
  navigator.storage.estimate = vi.fn().mockImplementation(async () => ({
    quota: 10 * 2 ** 30,
    usage: 1234
  }));

  const renderResult = renderHook(() => {
    const overrideFileSize = useAppStore(state => state.overrideFileSize);

    useEffect(() => {
      overrideFileSize("FOO", "stream.webm", 42);
    }, [ overrideFileSize ]);

    return useBrowserStorage();
  }, { wrapper });

  await waitFor(() => {
    const adjustedMockRecordings = mockRecordings.map(rec => (
      rec.name === "FOO"
        ? {
            ...rec,
            files: rec.files.map(file => (
              file.name === "stream.webm" ? { ...file, size: 42 } : file
            ))
          }
        : rec
    ));

    expect(renderResult.result.current.savedRecordings).toStrictEqual(adjustedMockRecordings);
  });
});


// --- manual re-upload ------------------------------------------------------
//
// Sends a locally saved recording to the server under a name of its own, so it cannot mix
// with whatever the live upload left there, and schedules its postprocessing. How a file is
// split into chunks is uploadFile's business, in serverStorage.test.ts.

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

function renderReupload() {
  const rendered = renderHook(() => ({
    reupload: useReuploadSavedRecording(),
    lecture: useLecture(),
    uploading: useAppStore(state => state.manuallyUploading)
  }), { wrapper });

  act(() => rendered.result.current.lecture.setLecturerEmail("lecturer@example.edu"));

  return rendered;
}

const destination = expect.objectContaining({ apiUrl: "http://localhost:5000", getAccessToken, streamingImpeded: false });

test("every track goes up under a name of its own, then the job is scheduled", async () => {
  vi.mocked(getAllRecordingTracks).mockResolvedValue([ trackOf("overlay"), trackOf("stream") ]);
  const { result } = renderReupload();

  await act(() => result.current.reupload("GVS_2025"));

  expect(vi.mocked(uploadFile).mock.calls.map(([ , file, recording, track ]) => [ recording, track, (file as File).name ])).toStrictEqual([
    [ "GVS_2025-manual", "overlay", "overlay.webm" ],
    [ "GVS_2025-manual", "stream", "stream.webm" ]
  ]);
  expect(uploadFile).toHaveBeenCalledWith(destination, expect.anything(), expect.anything(), expect.anything(), expect.anything());
  // the report goes to whoever is in the lecture form now; the backend keeps no record of
  // the original recipient
  expect(schedulePostprocessing).toHaveBeenCalledExactlyOnceWith(destination, "GVS_2025-manual", "lecturer@example.edu", expect.anything());
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

  await act(() => result.current.reupload("GVS_2025"));

  expect(order).toStrictEqual([ "upload overlay", "upload stream", "schedule" ]);
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
    running = result.current.reupload("GVS_2025");
  });

  // under the local name, which is what the button is keyed by -- not the upload name
  await waitFor(() => expect(result.current.uploading).toStrictEqual([ "GVS_2025" ]));

  await act(async () => {
    finishUpload(true);
    await running;
  });

  expect(result.current.uploading).toStrictEqual([]);
});

test("a failed track stops the upload before anything is scheduled", async () => {
  // the tracks after it would only make a partial recording look complete
  vi.mocked(getAllRecordingTracks).mockResolvedValue([ trackOf("audio-0"), trackOf("overlay"), trackOf("stream") ]);
  vi.mocked(uploadFile).mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);
  const { result } = renderReupload();

  await act(() => result.current.reupload("GVS_2025"));

  expect(vi.mocked(uploadFile).mock.calls.map(([ , , , track ]) => track)).toStrictEqual([ "audio-0", "overlay" ]);
  expect(schedulePostprocessing).not.toHaveBeenCalled();
  expect(showError).toHaveBeenCalledWith(expect.stringContaining("overlay"));
  // released and refreshed all the same, so the button can be pressed again
  expect(result.current.uploading).toStrictEqual([]);
  expect(refreshProcessedRecordings).toHaveBeenCalledOnce();
});

test("a recording without any tracks says so instead of doing nothing", async () => {
  vi.mocked(getAllRecordingTracks).mockResolvedValue([]);
  const { result } = renderReupload();

  await act(() => result.current.reupload("GVS_2025"));

  expect(uploadFile).not.toHaveBeenCalled();
  expect(schedulePostprocessing).not.toHaveBeenCalled();
  expect(showError).toHaveBeenCalledWith(expect.stringContaining("GVS_2025"));
  expect(result.current.uploading).toStrictEqual([]);
});

test("an upload that blows up is reported and gives the button back", async () => {
  vi.mocked(getAllRecordingTracks).mockResolvedValue([ trackOf("stream") ]);
  vi.mocked(uploadFile).mockRejectedValue(new Error("boom"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const { result } = renderReupload();

  await act(() => result.current.reupload("GVS_2025"));

  expect(showError).toHaveBeenCalledWith(expect.stringContaining("GVS_2025-manual"));
  expect(result.current.uploading).toStrictEqual([]);
  expect(refreshProcessedRecordings).toHaveBeenCalledOnce();
  error.mockRestore();
});

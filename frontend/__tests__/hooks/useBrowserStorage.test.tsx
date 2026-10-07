import { expect, test, vi } from "vitest";
import { appStoreWrapper } from "../helpers/appStore";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAppStore } from "@/lib/hooks/useAppStore";
import { useBrowserStorage } from "@/lib/hooks/useBrowserStorage";
import { useEffect } from "react";
import { showError } from "@/lib/utils/notifications";
import { deleteRecording, gatherRecordingsList, RecordingFileList } from "@/lib/utils/browserStorage";

const wrapper = appStoreWrapper();

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
vi.mock("@/lib/utils/notifications");
// The store gathers browser storage once, when the provider mounts, rather than every hook
// that reads it doing so on its own -- a hook used once per saved recording would otherwise
// rescan the whole of it once per card.

test("the provider gathers browser storage at first render", async () => {
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

test("browser storage is gathered once however many components read it", async () => {
  vi.mocked(gatherRecordingsList).mockClear();
  vi.mocked(gatherRecordingsList).mockResolvedValue(mockRecordings);
  navigator.storage.estimate = vi.fn().mockResolvedValue({ quota: 10 * 2 ** 30, usage: 1234 });

  const renderResult = renderHook(() => [ useBrowserStorage(), useBrowserStorage(), useBrowserStorage() ], { wrapper });

  await waitFor(() => {
    expect(renderResult.result.current.map(storage => storage.savedRecordings)).toStrictEqual([ mockRecordings, mockRecordings, mockRecordings ]);
  });
  expect(gatherRecordingsList).toHaveBeenCalledOnce();
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


test("removing a recording deletes it from the browser and lists what is left", async () => {
  vi.mocked(gatherRecordingsList).mockResolvedValue(mockRecordings);
  navigator.storage.estimate = vi.fn().mockResolvedValue({ quota: 10 * 2 ** 30, usage: 0 });

  const { result } = renderHook(() => useBrowserStorage(), { wrapper });
  await waitFor(() => expect(result.current.savedRecordings).toHaveLength(2));

  // the list is read back from the browser rather than edited in place, so it shows what the
  // delete actually left behind
  vi.mocked(deleteRecording).mockImplementation(async () => {
    vi.mocked(gatherRecordingsList).mockResolvedValue(mockRecordings.slice(1));
  });

  await act(() => result.current.removeSavedRecording("FOO"));

  expect(deleteRecording).toHaveBeenCalledExactlyOnceWith("FOO");
  expect(result.current.savedRecordings.map(recording => recording.name)).toStrictEqual([ "BAR" ]);
});

test("the app store refuses to work outside its provider", () => {
  // a component mounted outside the provider would otherwise read a store of its own, and
  // silently show nothing the rest of the page does
  vi.spyOn(console, "error").mockImplementation(() => {});

  expect(() => renderHook(() => useAppStore(state => state.lectureTitle))).toThrow(/AppStoreProvider/);
});

test("a browser storage that cannot be read when the page loads is reported", async () => {
  // no OPFS in some private windows; the page still works, but the lecturer has to know
  // that nothing will be kept in the browser
  const failure = new DOMException("no origin private file system here", "SecurityError");
  vi.mocked(gatherRecordingsList).mockRejectedValue(failure);
  navigator.storage.estimate = vi.fn().mockResolvedValue({ quota: 10 * 2 ** 30, usage: 0 });

  renderHook(() => useBrowserStorage(), { wrapper });

  await waitFor(() => expect(showError).toHaveBeenCalledWith(expect.anything(), failure));
});

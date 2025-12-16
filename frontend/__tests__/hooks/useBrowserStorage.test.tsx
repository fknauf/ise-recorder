import { expect, test, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { AppStoreProvider, useAppStore } from "@/app/lib/hooks/useAppStore";
import { useBrowserStorage } from "@/app/lib/hooks/useBrowserStorage";
import { ReactNode, useEffect } from "react";
import { gatherRecordingsList, RecordingFileList } from "@/app/lib/utils/browserStorage";

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

vi.mock("@/app/lib/utils/browserStorage");

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

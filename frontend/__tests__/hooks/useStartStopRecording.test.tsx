import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { AppStoreProvider, useAppStore } from "@/lib/hooks/useAppStore";
import { AccessTokenSourceContext, useAccessTokenSource } from "@/lib/hooks/useAuthTokenSource";
import { useActiveRecording, useStartStopRecording } from "@/lib/hooks/useActiveRecording";
import { recordLecture, RecordingTrackBundle } from "@/lib/utils/recording";
import { ServerStorageDestination } from "@/lib/utils/serverStorage";
import { gatherRecordingsList } from "@/lib/utils/browserStorage";
import { showError } from "@/lib/utils/notifications";
import { ServerEnv } from "@/lib/utils/serverEnv";

// recordLecture is mocked so the tests can drive its UI callbacks directly. This hook's
// job is the state machine around recording, not the recording itself, and the real
// implementation would need media devices and six seconds of wall clock.
vi.mock("@/lib/utils/recording");
vi.mock("@/lib/utils/notifications");
vi.mock("@/lib/utils/browserStorage");

type AccessTokenSource = ReturnType<typeof useAccessTokenSource>;

interface CapturedRecording {
  trackBundle: RecordingTrackBundle
  lectureTitle: string
  lecturerEmail: string
  destination: ServerStorageDestination
  onStarting: (recordingName: string) => Promise<void> | void
  onStarted: (recordingName: string, stopFunction: () => void) => Promise<void> | void
  onChunkWritten: (recordingName: string, filename: string, chunkSize: number) => Promise<void> | void
  onFinished: (recordingName: string) => Promise<void> | void
}

let captured: CapturedRecording | undefined;
let releaseRecordLecture: (() => void) | undefined;

const makeTokenSource = (authRequired: boolean, token: string | undefined) => ({
  authRequired,
  getAccessToken: vi.fn(async () => token),
  refreshAccessToken: vi.fn(async () => token)
});

function renderRecorder(
  tokenSource: AccessTokenSource,
  serverEnv: ServerEnv = { apiUrl: "http://localhost:5000" }
) {
  const wrapper = ({ children }: Readonly<{ children: ReactNode }>) =>
    <AppStoreProvider serverEnv={serverEnv}>
      <AccessTokenSourceContext.Provider value={tokenSource}>
        {children}
      </AccessTokenSourceContext.Provider>
    </AppStoreProvider>;

  return renderHook(() => ({
    ...useStartStopRecording(),
    activeRecording: useActiveRecording(),
    store: useAppStore(state => state)
  }), { wrapper });
}

/**
 * Kick off startRecording without awaiting it: the mocked recordLecture hangs until
 * releaseRecordLecture is called, mirroring a recording that is still in progress.
 */
async function startAndCapture(start: () => Promise<void>): Promise<CapturedRecording> {
  await act(async () => {
    void start();
  });

  await waitFor(() => expect(captured).toBeDefined());
  return captured as CapturedRecording;
}

beforeEach(() => {
  captured = undefined;
  releaseRecordLecture = undefined;
  localStorage.clear();

  vi.mocked(gatherRecordingsList).mockResolvedValue([]);
  navigator.storage.estimate = vi.fn().mockResolvedValue({ quota: 10 * 2 ** 30, usage: 1234 });

  vi.mocked(recordLecture).mockImplementation(async (
    trackBundle, lectureTitle, lecturerEmail, destination,
    onStarting, onStarted, onChunkWritten, onFinished
  ) => {
    captured = {
      trackBundle, lectureTitle, lecturerEmail, destination,
      onStarting, onStarted, onChunkWritten, onFinished
    };

    await new Promise<void>(resolve => {
      releaseRecordLecture = resolve;
    });
  });
});

afterEach(() => {
  // let any in-flight startRecording settle so it doesn't leak into the next test
  releaseRecordLecture?.();
  localStorage.clear();
});

test("useStartStopRecording starts idle", () => {
  const { result } = renderRecorder(makeTokenSource(false, undefined));

  expect(result.current.activeRecording.state).toBe("idle");
});

test("startRecording hands the lecture details and tracks to recordLecture", async () => {
  const { result } = renderRecorder(makeTokenSource(false, undefined));

  const canvas = document.createElement("canvas");
  const displayTracks = canvas.captureStream().getVideoTracks();

  act(() => {
    result.current.store.setLectureTitle("GVS");
    result.current.store.setLecturerEmail("lecturer@example.com");
    result.current.store.addDisplayTracks(displayTracks);
  });

  const call = await startAndCapture(result.current.startRecording);

  expect(call.lectureTitle).toBe("GVS");
  expect(call.lecturerEmail).toBe("lecturer@example.com");
  expect(call.trackBundle.displayTracks).toStrictEqual(displayTracks);
  // first captured display becomes the main display
  expect(call.trackBundle.mainDisplay).toBe(displayTracks[0]);
  expect(call.destination.apiUrl).toBe("http://localhost:5000");
});

test("startRecording is a no-op while a recording is already active", async () => {
  const { result } = renderRecorder(makeTokenSource(false, undefined));

  act(() => {
    result.current.store.setActiveRecording({
      state: "recording",
      name: "ALREADY_RUNNING",
      stop: vi.fn(),
      streamingImpeded: false
    });
  });

  await act(async () => {
    await result.current.startRecording();
  });

  expect(vi.mocked(recordLecture)).not.toHaveBeenCalled();
  expect(result.current.activeRecording.name).toBe("ALREADY_RUNNING");
});

// --- streamingImpeded ------------------------------------------------------

test("streaming is not impeded and no token is minted when auth is not required", async () => {
  const tokenSource = makeTokenSource(false, undefined);
  const { result } = renderRecorder(tokenSource);

  const call = await startAndCapture(result.current.startRecording);

  expect(call.destination.streamingImpeded).toBe(false);
  expect(tokenSource.refreshAccessToken).not.toHaveBeenCalled();
});

test("no token is minted when no backend is configured", async () => {
  const tokenSource = makeTokenSource(true, "test-token");
  const { result } = renderRecorder(tokenSource, { apiUrl: undefined });

  const call = await startAndCapture(result.current.startRecording);

  expect(call.destination.streamingImpeded).toBe(false);
  expect(tokenSource.refreshAccessToken).not.toHaveBeenCalled();
});

test("streaming is not impeded when a fresh token is available", async () => {
  const tokenSource = makeTokenSource(true, "test-token");
  const { result } = renderRecorder(tokenSource);

  const call = await startAndCapture(result.current.startRecording);

  expect(tokenSource.refreshAccessToken).toHaveBeenCalledOnce();
  expect(call.destination.streamingImpeded).toBe(false);
});

test("streaming is impeded when no token can be minted", async () => {
  const tokenSource = makeTokenSource(true, undefined);
  const { result } = renderRecorder(tokenSource);

  const call = await startAndCapture(result.current.startRecording);

  expect(tokenSource.refreshAccessToken).toHaveBeenCalledOnce();
  expect(call.destination.streamingImpeded).toBe(true);
});

// --- state machine ---------------------------------------------------------

test("the recorder walks idle -> starting -> recording -> idle", async () => {
  const tokenSource = makeTokenSource(true, undefined);
  const { result } = renderRecorder(tokenSource);

  const call = await startAndCapture(result.current.startRecording);
  const stop = vi.fn();

  expect(result.current.activeRecording.state).toBe("idle");

  await act(async () => {
    await call.onStarting("REC_1");
  });

  expect(result.current.activeRecording.state).toBe("starting");
  expect(result.current.activeRecording.name).toBe("REC_1");

  await act(async () => {
    await call.onStarted("REC_1", stop);
  });

  expect(result.current.activeRecording.state).toBe("recording");
  expect(result.current.activeRecording.name).toBe("REC_1");
  // the impeded flag determined at start is carried into the active recording
  expect(result.current.activeRecording).toMatchObject({ streamingImpeded: true });

  await act(async () => {
    await call.onFinished("REC_1");
  });

  expect(result.current.activeRecording.state).toBe("idle");
  expect(result.current.activeRecording.name).toBeUndefined();
});

test("the unload guard is armed while starting and disarmed when finished", async () => {
  const { result } = renderRecorder(makeTokenSource(false, undefined));

  const addListener = vi.spyOn(window, "addEventListener");
  const removeListener = vi.spyOn(window, "removeEventListener");

  const call = await startAndCapture(result.current.startRecording);

  await act(async () => {
    await call.onStarting("REC_1");
  });

  const armed = addListener.mock.calls.filter(([ event ]) => event === "beforeunload");
  expect(armed.length).toBe(1);

  await act(async () => {
    await call.onFinished("REC_1");
  });

  const disarmed = removeListener.mock.calls.filter(([ event ]) => event === "beforeunload");
  expect(disarmed.length).toBe(1);
  // the same handler must come off again, or the guard would outlive the recording
  expect(disarmed[0][1]).toBe(armed[0][1]);
});

test("arriving chunks accumulate into the file size overrides and refresh the quota", async () => {
  vi.mocked(gatherRecordingsList).mockResolvedValue([{ name: "REC_1", files: [ { name: "stream.webm", size: 0 } ] }]);

  const { result } = renderRecorder(makeTokenSource(false, undefined));
  const call = await startAndCapture(result.current.startRecording);

  await act(async () => {
    await call.onStarting("REC_1");
    await call.onStarted("REC_1", vi.fn());
  });

  await act(async () => {
    await call.onChunkWritten("REC_1", "stream.webm", 100);
    await call.onChunkWritten("REC_1", "stream.webm", 250);
  });

  await waitFor(() => {
    expect(result.current.store.adjustedSavedRecordings)
      .toStrictEqual([ { name: "REC_1", files: [ { name: "stream.webm", size: 350 } ] } ]);
  });

  expect(navigator.storage.estimate).toHaveBeenCalled();

  // finishing re-reads the real sizes and drops the overrides
  await act(async () => {
    await call.onFinished("REC_1");
  });

  expect(result.current.store.fileSizeOverrides.size).toBe(0);
  await waitFor(() => {
    expect(result.current.store.adjustedSavedRecordings)
      .toStrictEqual([ { name: "REC_1", files: [ { name: "stream.webm", size: 0 } ] } ]);
  });
});

// --- stopping --------------------------------------------------------------

test("stopRecording stops the recording and moves to stopping", async () => {
  const { result } = renderRecorder(makeTokenSource(false, undefined));
  const call = await startAndCapture(result.current.startRecording);
  const stop = vi.fn();

  await act(async () => {
    await call.onStarting("REC_1");
    await call.onStarted("REC_1", stop);
  });

  act(() => {
    result.current.stopRecording();
  });

  expect(stop).toHaveBeenCalledOnce();
  expect(result.current.activeRecording.state).toBe("stopping");
  expect(result.current.activeRecording.name).toBe("REC_1");
});

test("stopRecording is a no-op when nothing is being recorded", () => {
  const { result } = renderRecorder(makeTokenSource(false, undefined));

  act(() => {
    result.current.stopRecording();
  });

  expect(result.current.activeRecording.state).toBe("idle");
});

// --- failure ---------------------------------------------------------------

test("a failing recording is reported to the user", async () => {
  const failure = new Error("no media for you");
  vi.mocked(recordLecture).mockRejectedValue(failure);

  const { result } = renderRecorder(makeTokenSource(false, undefined));

  await act(async () => {
    await result.current.startRecording();
  });

  expect(vi.mocked(showError)).toHaveBeenCalledWith("Recording failed", failure);
  expect(result.current.activeRecording.state).toBe("idle");
});

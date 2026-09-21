import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { AppStoreProvider, useAppStore } from "@/lib/hooks/useAppStore";
import { SessionTransition, useAccessTokenSource } from "@/lib/hooks/useAccessTokenSource";
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
vi.mock("@/lib/utils/notifications", () => ({
  // An explicit factory, not automocking: vi.mock() alone yields spies that still call
  // through, so the real showError logs and queues Spectrum toasts during the suite.
  showError: vi.fn(),
  showSuccess: vi.fn(),
  showMessage: vi.fn()
}));
vi.mock("@/lib/utils/browserStorage");

const mockUseAccessTokenSource = vi.fn();
vi.mock("@/lib/hooks/useAccessTokenSource", () => ({
  useAccessTokenSource: () => mockUseAccessTokenSource()
}));

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

const makeTokenSource = (
  authRequired: boolean,
  token: string | undefined,
  sessionResult: SessionTransition = "still-fresh"
): AccessTokenSource => ({
  authRequired,
  autoSignin: false,
  getAccessToken: vi.fn(async () => token),
  signOut: vi.fn(async () => {}),
  expandSessionHeadroom: vi.fn(async (): Promise<SessionTransition> => sessionResult)
});

function renderRecorder(
  tokenSource: AccessTokenSource,
  serverEnv: ServerEnv = { apiUrl: "http://localhost:5000" }
) {
  mockUseAccessTokenSource.mockReturnValue(tokenSource);

  const wrapper = ({ children }: Readonly<{ children: ReactNode }>) =>
    <AppStoreProvider serverEnv={serverEnv}>
      {children}
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

afterEach(async () => {
  // Let any in-flight startRecording settle so it doesn't leak into the next test.
  //
  // Inside act, because settling is not silent any more: startRecording claims "idle"
  // itself once recordLecture returns, rather than leaving it to the onFinished callback,
  // so releasing the parked recordLecture here renders the still-mounted hook. Bare, that
  // is a state update outside act, and every test that parks a recording earns two
  // warnings on the way out.
  await act(async () => {
    releaseRecordLecture?.();
  });

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

// --- session headroom and streamingImpeded --------------------------------

test("the session headroom is expanded before every recording", async () => {
  // unconditional: even an unauthenticated deployment goes through it, because the
  // anonymous source answers "still-fresh" for free.
  const tokenSource = makeTokenSource(false, undefined);
  const { result } = renderRecorder(tokenSource);

  await startAndCapture(result.current.startRecording);

  expect(tokenSource.expandSessionHeadroom).toHaveBeenCalledOnce();
});

test("a renewed session aborts the start so the user can press record again", async () => {
  const tokenSource = makeTokenSource(true, "test-token", "renewed");
  const { result } = renderRecorder(tokenSource);

  await act(async () => {
    await result.current.startRecording();
  });

  // the re-login popup just interrupted them; starting now would record the confusion
  expect(vi.mocked(recordLecture)).not.toHaveBeenCalled();
  expect(result.current.activeRecording.state).toBe("idle");
});

test("streaming is impeded when the session has expired", async () => {
  const tokenSource = makeTokenSource(true, undefined, "expired");
  const { result } = renderRecorder(tokenSource);

  const call = await startAndCapture(result.current.startRecording);

  expect(call.destination.streamingImpeded).toBe(true);
});

test("streaming is not impeded when the session is still fresh", async () => {
  const tokenSource = makeTokenSource(true, "test-token", "still-fresh");
  const { result } = renderRecorder(tokenSource);

  const call = await startAndCapture(result.current.startRecording);

  expect(call.destination.streamingImpeded).toBe(false);
});

test("streaming is not impeded when re-auth failed but the old token still works", async () => {
  const tokenSource = makeTokenSource(true, "test-token", "still-stale");
  const { result } = renderRecorder(tokenSource);

  const call = await startAndCapture(result.current.startRecording);

  // "still-stale" means the session is older than policy but the token is usable,
  // so uploads carry on as normal.
  expect(call.destination.streamingImpeded).toBe(false);
});

test("streaming is not impeded without a backend, whatever the session state", async () => {
  const tokenSource = makeTokenSource(true, undefined, "expired");
  const { result } = renderRecorder(tokenSource, { apiUrl: undefined });

  const call = await startAndCapture(result.current.startRecording);

  expect(call.destination.streamingImpeded).toBe(false);
});

test("streaming is not impeded when auth is not required, whatever the session state", async () => {
  const tokenSource = makeTokenSource(false, undefined, "expired");
  const { result } = renderRecorder(tokenSource);

  const call = await startAndCapture(result.current.startRecording);

  expect(call.destination.streamingImpeded).toBe(false);
});

// --- state machine ---------------------------------------------------------

test("the recorder walks idle -> preparing -> starting -> recording -> idle", async () => {
  const tokenSource = makeTokenSource(true, undefined, "expired");
  const { result } = renderRecorder(tokenSource);

  const call = await startAndCapture(result.current.startRecording);
  const stop = vi.fn();

  // "preparing" is claimed synchronously, before expandSessionHeadroom is awaited, so a
  // second press during that await sees a non-idle state and bails. The recording has no
  // name yet -- recordLecture has not been reached -- and nothing is on disk to protect.
  expect(result.current.activeRecording.state).toBe("preparing");
  expect(result.current.activeRecording.name).toBeUndefined();

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

  // onFinished hands back the file sizes and disarms the unload guard, but "idle" is
  // claimed by startRecording once recordLecture returns rather than by the callback.
  // That way the path where recordLecture resolves without ever invoking a callback --
  // no tracks to record -- cannot leave the UI wedged. See the test below.
  await act(async () => {
    releaseRecordLecture?.();
  });

  await waitFor(() => expect(result.current.activeRecording.state).toBe("idle"));
  expect(result.current.activeRecording.name).toBeUndefined();
});

test("a recording that never gets off the ground returns the UI to idle", async () => {
  // With no tracks configured there is nothing to record, so recordLecture resolves
  // without calling onStarting, onStarted or onFinished. Nothing else would take the
  // state back out of "preparing", and a wedged "preparing" is unrecoverable: the Stop
  // button stays disabled and every track control stays locked by state !== "idle".
  vi.mocked(recordLecture).mockResolvedValue(undefined);

  const { result } = renderRecorder(makeTokenSource(false, undefined));

  await act(async () => {
    await result.current.startRecording();
  });

  expect(result.current.activeRecording.state).toBe("idle");
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

test("a stopRecording captured before the recording began still stops it", async () => {
  // The reason stopRecording reads the store through getStoreState() rather than using
  // the activeRecording captured at render: it can be called from a closure taken before
  // the recording existed -- an async path, a timer, an event handler bound early. A
  // render-time capture would see "idle" there and refuse to stop, stranding the
  // recording with no way to end it.
  const { result } = renderRecorder(makeTokenSource(false, undefined));

  // taken while still idle, and deliberately not re-read afterwards
  const stopTakenWhileIdle = result.current.stopRecording;

  const call = await startAndCapture(result.current.startRecording);
  const stop = vi.fn();

  await act(async () => {
    await call.onStarting("REC_1");
    await call.onStarted("REC_1", stop);
  });

  act(() => {
    stopTakenWhileIdle();
  });

  expect(stop).toHaveBeenCalledOnce();
  expect(result.current.activeRecording.state).toBe("stopping");
});

test("stopRecording is a no-op when nothing is being recorded", () => {
  // The hook warns on this path deliberately, so silence it here rather than letting
  // it litter the suite output -- and assert it, since the warning is the behavior.
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    const { result } = renderRecorder(makeTokenSource(false, undefined));

    act(() => {
      result.current.stopRecording();
    });

    expect(result.current.activeRecording.state).toBe("idle");
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("wasn't recording"));
  } finally {
    consoleWarn.mockRestore();
  }
});

// --- failure ---------------------------------------------------------------

test("pressing start twice before the session check resolves records once", async () => {
  // The guard reads the store, but until "preparing" is claimed the store still says
  // "idle" for the whole duration of the expandSessionHeadroom await -- which can be a
  // silent sign-in lasting seconds, while the button stays enabled. Both presses used to
  // get through, producing two recordings writing two sets of files.
  const { result } = renderRecorder(makeTokenSource(false, undefined));

  await act(async () => {
    void result.current.startRecording();
    void result.current.startRecording();
  });

  await waitFor(() => expect(captured).toBeDefined());

  expect(vi.mocked(recordLecture)).toHaveBeenCalledOnce();
});

test("a failing recording is reported to the user", async () => {
  const failure = new Error("no media for you");
  vi.mocked(recordLecture).mockRejectedValue(failure);

  const { result } = renderRecorder(makeTokenSource(false, undefined));

  await act(async () => {
    await result.current.startRecording();
  });

  expect(vi.mocked(showError)).toHaveBeenCalledWith("Recording failed", failure);

  // recordLecture can reject before onStarting ever runs -- no media, a getUserMedia
  // denial, an OPFS failure -- and nothing else resets the state on that path. Left at
  // "preparing" the UI is wedged: a permanently disabled "Stop Recording" button, every
  // track control locked by state !== "idle", and no way back except a page reload.
  expect(result.current.activeRecording.state).toBe("idle");
});

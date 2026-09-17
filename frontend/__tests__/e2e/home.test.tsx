import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { ReactNode } from "react";
import { AppStoreProvider } from "@/lib/hooks/useAppStore";
import { Home } from "@/app/page";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { gatherRecordingsList } from "@/lib/utils/browserStorage";
import { AccessTokenSourceContext, useAccessTokenSource } from "@/lib/hooks/useAccessTokenSource";

const makeDevice = (deviceId: string, groupId: string, kind: MediaDeviceKind, label: string): MediaDeviceInfo => ({
  deviceId, groupId, kind, label,
  toJSON: () => JSON.stringify({ deviceId, groupId, kind, label })
});

// AuthStatusMessage drives the real sign-in flow when authentication is required. These
// tests are about what the uploader sends, not about the redirect dance, so the OIDC
// library is stubbed out as already-signed-in. The token itself comes from the injected
// AccessTokenSourceContext below, which is the seam the uploader actually reads.
vi.mock("react-oidc-context", () => ({
  useAutoSignin: () => ({ isLoading: false, isAuthenticated: true, error: undefined }),
  useAuth: () => ({ isLoading: false, isAuthenticated: true, error: undefined }),
  AuthProvider: ({ children }: { children: ReactNode }) => children
}));

type AccessTokenSource = ReturnType<typeof useAccessTokenSource>;

const anonymousTokenSource: AccessTokenSource = {
  authRequired: false,
  getAccessToken: async () => undefined,
  interactiveLogin: async () => {},
  expandSessionHeadroom: async () => "still-fresh"
};

const authenticatedTokenSource: AccessTokenSource = {
  authRequired: true,
  getAccessToken: async () => "test-token",
  interactiveLogin: async () => {},
  expandSessionHeadroom: async () => "still-fresh"
};

const cleanupBetweenTests = async () => {
  // react-spectrum queues toasts globally, outside the React tree, so they survive cleanup()
  // and reappear when the next test mounts a ToastContainer. Only one is shown at a time, so
  // a leftover would hide the next test's toast until its five second timeout elapsed.
  for(const closeButton of screen.queryAllByRole("button", { name: /clear|close|dismiss/i })) {
    fireEvent.click(closeButton);
  }

  localStorage.clear();
  const rootDir = await navigator.storage.getDirectory();
  for await (const key of rootDir.keys()) {
    await rootDir.removeEntry(key, { recursive: true });
  }

  cleanup();
};

beforeEach(cleanupBetweenTests);
afterAll(cleanupBetweenTests);

/**
 * Drives a complete recording through the UI: adds sources, fills in the lecture details,
 * records for two seconds, stops, and checks the resulting local files. Parameterized by the
 * access token source so the same session can be run for an unauthenticated deployment and
 * for one behind an OpenID provider.
 */
async function recordAStream(tokenSource: AccessTokenSource, lectureTitle: string) {
  window.fetch = vi.fn().mockResolvedValue(Response.json("", { status: 201 }));

  let x = 0;

  const animate = (canvas: HTMLCanvasElement | null) => {
    if(canvas === null) {
      return;
    }

    const renderFunction = () => {
      const ctx = canvas.getContext("2d");

      if(ctx === null) {
        return;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();

      x = (x + 1) % canvas.width;
    };

    const timer = setInterval(renderFunction, 1000 / 30);
    return () => clearInterval(timer);
  };

  const tree = render(
    <>
      <Provider theme={defaultTheme}>
        <AccessTokenSourceContext.Provider value={tokenSource}>
          <AppStoreProvider serverEnv={{ apiUrl: "http://localhost:5000" }}>
            <Home/>
          </AppStoreProvider>
        </AccessTokenSourceContext.Provider>
      </Provider>
      <canvas width={384} height={216} data-testid="display-src" ref={animate}/>
      <canvas width={384} height={216} data-testid="video-src" ref={animate}/>
    </>
  );

  const mockDevices: MediaDeviceInfo[] = [
    makeDevice("aaa", "AAA", "videoinput", "Webcam Model T"),
    makeDevice("bbb", "BBB", "audioinput", "Webcam Microphone")
  ];

  const displaySrc = await screen.findByTestId("display-src") as HTMLCanvasElement;
  const displayStream = displaySrc.captureStream();

  const videoSrc = await screen.findByTestId("video-src") as HTMLCanvasElement;
  const videoStream = videoSrc.captureStream();

  const audioCtx = new AudioContext();
  const oscillator = audioCtx.createOscillator();
  const audioDest = audioCtx.createMediaStreamDestination();
  oscillator.connect(audioDest);

  // necessary to keep playwright-chromium from capturing an empty stream for stream.webm (to
  // which this audio stream will be connected), but also breaks the test there the first time
  // running because audioCtx.resume() never resolves. The test runs to completion the second
  // time when npm run test is in watch mode.
  //
  // The reasons for this are rather unclear, possibly related to chromium's notion of media
  // engagement index wrt whether autoplay is allowed/automatically enabled for the audio context.
  // I haven't found a way to make this work from the get-go so far, so for the moment we accept
  // that this test will sometimes produce an empty stream for stream.webm on chromium and skip
  // the file size > 0 test below.
  //
  // oscillator.start()
  // await act(() => audioCtx.resume());

  const audioStream = audioDest.stream;
  const mediaStream = new MediaStream([ ...videoStream.getTracks(), ...audioStream.getTracks() ]);

  expect(mediaStream.getAudioTracks().length).toBe(1);
  expect(mediaStream.getVideoTracks().length).toBe(1);

  let permState = "prompt";

  navigator.permissions.query = vi.fn().mockImplementation(async () => ({ state: permState }));
  navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue(mockDevices);
  navigator.mediaDevices.getDisplayMedia = vi.fn().mockResolvedValue(displayStream);
  navigator.mediaDevices.getUserMedia = vi.fn().mockImplementation(async () => {
    permState = "granted";
    return mediaStream;
  });

  const user = userEvent.setup();

  await user.click(tree.getByText("Add Screen/Window"));
  await user.click(tree.getByText("Add Video Source"));

  const previews = await screen.findAllByTestId(/^preview-/);

  expect(previews.length).toBe(3);
  expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(1);
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);

  await user.click(tree.getByLabelText("Lecture Title"));
  await user.type(tree.getByLabelText("Lecture Title"), lectureTitle);
  await user.click(tree.getByLabelText("e-Mail"));
  await user.type(tree.getByLabelText("e-Mail"), "speaker@example.com");

  vi.setSystemTime("2025-12-21T12:34:56.789Z");
  const recordingName = `${lectureTitle}_2025-12-21T123456.789Z`;

  await user.click(tree.getByText("Start Recording"));

  await waitFor(() => {
    expect(tree.getByText("Stop Recording")).toBeInTheDocument();
    expect(tree.getByText("Stop Recording")).not.toBeDisabled();
  });

  await act(() => new Promise(resolve => setTimeout(resolve, 2000)));
  await user.click(tree.getByText("Stop Recording"));

  await waitFor(() => {
    expect(tree.getByText("Start Recording")).toBeInTheDocument();
  });

  // wait for the "postprocessing scheduled" toast displayed as part of the end-of-recording
  // sequence. Without this the test framework will intermittently complain about things not
  // being run inside act -- not because we actually run things here that would require act,
  // but because react-spectrum's toast queue does. We're not waiting for the toast to disappear
  // here, so if the test later becomes long-running after this point (more than 5 seconds), the
  // complaints might pop up again.
  // Only one toast is shown at a time. cleanupBetweenTests dismisses leftovers, but that
  // races with the toast animation, so allow for waiting out a previous toast's 5s timeout.
  await screen.findByText(
    new RegExp(`${recordingName}.*postprocessing scheduled`, "i"),
    {},
    { timeout: 8000 }
  );

  const recordings = await gatherRecordingsList();

  expect(recordings.length).toBe(1);
  expect(recordings[0].name).toBe(recordingName);
  expect(recordings[0].files.length).toBe(2);
  expect(recordings[0].files[0].name).toBe("overlay.webm");
  expect(recordings[0].files[0].size).toBeGreaterThan(0);
  expect(recordings[0].files[1].name).toBe("stream.webm");
  // Flaky on chromium, see comment above on audioCtx.resume().
  // expect(recordings[0].files[1].size).toBeGreaterThan(0);
  return recordingName;
}

test("e2e recording a stream works", async () => {
  const recordingName = await recordAStream(anonymousTokenSource, "FOO_101");

  expect(window.fetch).toHaveBeenCalledTimes(3);
  expect(window.fetch).toHaveBeenCalledWith("http://localhost:5000/api/chunks", { method: "POST", body: expect.anything() });
  expect(window.fetch).toHaveBeenCalledWith(
    "http://localhost:5000/api/jobs",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        recording: recordingName,
        recipient: "speaker@example.com"
      })
    }
  );
});

test("e2e recording a stream sends the access token to the server", async () => {
  const recordingName = await recordAStream(authenticatedTokenSource, "BAR_202");

  expect(window.fetch).toHaveBeenCalledTimes(3);
  expect(window.fetch).toHaveBeenCalledWith(
    "http://localhost:5000/api/chunks",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token"
      },
      body: expect.anything()
    }
  );
  expect(window.fetch).toHaveBeenCalledWith(
    "http://localhost:5000/api/jobs",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-token"
      },
      body: JSON.stringify({
        recording: recordingName,
        recipient: "speaker@example.com"
      })
    }
  );
});

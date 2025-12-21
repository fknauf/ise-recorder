import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { AppStoreProvider } from "@/app/lib/hooks/useAppStore";
import { Home } from "@/app/page";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { gatherRecordingsList } from "@/app/lib/utils/browserStorage";
import { commands } from "vitest/browser";

const makeDevice = (deviceId: string, groupId: string, kind: MediaDeviceKind, label: string): MediaDeviceInfo => ({
  deviceId, groupId, kind, label,
  toJSON: () => JSON.stringify({ deviceId, groupId, kind, label })
});

const cleanupBetweenTests = async () => {
  localStorage.clear();
  const rootDir = await navigator.storage.getDirectory();
  for await (const key of rootDir.keys()) {
    await rootDir.removeEntry(key, { recursive: true });
  }

  cleanup();
};

beforeEach(cleanupBetweenTests);
afterAll(cleanupBetweenTests);

test("e2e recording a stream works", async () => {
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
        <AppStoreProvider serverEnv={{ apiUrl: "http://localhost:5000" }}>
          <Home/>
        </AppStoreProvider>
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

  const previews = await screen.findAllByRole("img");

  expect(previews.length).toBe(3);
  expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(1);
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);

  await user.click(tree.getByLabelText("Lecture Title"));
  await user.type(tree.getByLabelText("Lecture Title"), "FOO_101");
  await user.click(tree.getByLabelText("e-Mail"));
  await user.type(tree.getByLabelText("e-Mail"), "speaker@example.com");

  vi.setSystemTime("2025-12-21T12:34:56.789Z");

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

  await act(() => new Promise(resolve => setTimeout(resolve, 2000)));

  const recordings = await gatherRecordingsList();

  expect(recordings.length).toBe(1);
  expect(recordings[0].name).toBe("FOO_101_2025-12-21T123456.789Z");
  expect(recordings[0].files.length).toBe(2);
  expect(recordings[0].files[0].name).toBe("overlay.webm");
  expect(recordings[0].files[0].size).toBeGreaterThan(0);
  expect(recordings[0].files[1].name).toBe("stream.webm");
  expect(recordings[0].files[1].size).toBeGreaterThan(0);

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
        recording: "FOO_101_2025-12-21T123456.789Z",
        recipient: "speaker@example.com"
      })
    }
  );
});

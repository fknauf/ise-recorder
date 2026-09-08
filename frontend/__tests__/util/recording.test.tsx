import { afterEach, expect, test, vi } from "vitest";
import { RecordingTrackBundle, recordLecture } from "@/lib/utils/recording";
import { gatherRecordingsList } from "@/lib/utils/browserStorage";
import { render, screen } from "@testing-library/react";
import { sendChunkToServer, schedulePostprocessing, ServerStorageDestination } from "@/lib/utils/serverStorage";

vi.mock("@/lib/utils/serverStorage");

const accessToken = async () => "test-token";

afterEach(async () => {
  const rootDir = await navigator.storage.getDirectory();
  for await (const key of rootDir.keys()) {
    await rootDir.removeEntry(key, { recursive: true });
  }
});

test("recordLecture does nothing when there are no tracks", async () => {
  const onStarting = vi.fn();
  const onStarted = vi.fn();
  const onChunkWritten = vi.fn();
  const onFinished = vi.fn();

  const destination: ServerStorageDestination = {
    apiUrl: "http://example.com",
    streamingImpeded: false,
    getAccessToken: accessToken
  };

  const trackBundle: RecordingTrackBundle = {
    displayTracks: [],
    videoTracks: [],
    audioTracks: [],
    mainDisplay: undefined,
    overlay: undefined
  };

  await recordLecture(
    trackBundle,
    "FOO", "lecturer@example.com",
    destination,
    onStarting, onStarted, onChunkWritten, onFinished);

  expect(onStarting).not.toHaveBeenCalled();
  expect(onStarted).not.toHaveBeenCalled();
  expect(onChunkWritten).not.toHaveBeenCalled();
  expect(onFinished).not.toHaveBeenCalled();
  expect(await gatherRecordingsList()).toStrictEqual([]);
});

test("recordLecture records lectures", async () => {
  const animate = (canvas: HTMLCanvasElement | null) => {
    if(canvas === null) {
      return;
    }

    let x = 0;

    const renderFunction = () => {
      const ctx = canvas.getContext("2d");

      if(ctx === null) {
        return;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.beginPath();
      ctx.moveTo(x, canvas.height);
      ctx.lineTo(x, 0);
      ctx.stroke();

      x = (x + 1) % canvas.width;
    };

    const timer = setInterval(renderFunction, 1000 / 30);
    return () => clearInterval(timer);
  };

  render(
    <>
      <canvas width={384} height={192} data-testid="scr" ref={animate}/>
      <canvas width={384} height={192} data-testid="vid" ref={animate}/>
    </>
  );

  const scrCanvas = await screen.findByTestId("scr") as HTMLCanvasElement;
  const vidCanvas = await screen.findByTestId("vid") as HTMLCanvasElement;

  const scrStream = scrCanvas.captureStream();
  const vidStream = vidCanvas.captureStream();

  const displayTracks = scrStream.getVideoTracks();
  const videoTracks = vidStream.getVideoTracks();

  const mainDisplay = displayTracks[0];
  const overlay = videoTracks[0];

  let recordingName = "";
  let stopRecording = () => {};

  const onStarting = vi.fn().mockImplementation((name: string) => {
    recordingName = name;
  });
  const onStarted = vi.fn().mockImplementation(
    (name: string, stopFn: () => void) => {
      stopRecording = stopFn;
    }
  );
  const onChunkWritten = vi.fn();
  const onFinished = vi.fn();

  window.fetch = vi.fn().mockResolvedValue(Response.json("", { status: 201 }));

  const trackBundle: RecordingTrackBundle = {
    displayTracks,
    videoTracks,
    audioTracks: [],
    mainDisplay,
    overlay
  };

  const destination: ServerStorageDestination = {
    apiUrl: "http://example.com",
    streamingImpeded: false,
    getAccessToken: accessToken
  };

  const renderPromise = recordLecture(
    trackBundle,
    "FOO", "lecturer@example.com",
    destination,
    onStarting, onStarted, onChunkWritten, onFinished);

  await new Promise(resolve => setTimeout(resolve, 6000));
  stopRecording();

  await renderPromise;

  expect(onStarting).toHaveBeenCalledExactlyOnceWith(recordingName);
  expect(onStarted).toHaveBeenCalledExactlyOnceWith(recordingName, stopRecording);
  expect(onChunkWritten).toHaveBeenCalledTimes(4);
  expect(onChunkWritten).toHaveBeenCalledWith(recordingName, "stream.webm", expect.anything());
  expect(onChunkWritten).toHaveBeenCalledWith(recordingName, "overlay.webm", expect.anything());
  expect(onFinished).toHaveBeenCalledExactlyOnceWith(recordingName);

  const recordings = await gatherRecordingsList();

  expect(recordings.length).toBe(1);
  expect(recordings[0].name).toBe(recordingName);
  expect(recordings[0].files.length).toBe(2);
  expect(recordings[0].files[0].name).toBe("overlay.webm");
  expect(recordings[0].files[1].name).toBe("stream.webm");

  expect(vi.mocked(sendChunkToServer)).toHaveBeenCalledTimes(4);
  expect(vi.mocked(sendChunkToServer)).toHaveBeenCalledWith(destination, expect.anything(), recordingName, "stream", 0);
  expect(vi.mocked(sendChunkToServer)).toHaveBeenCalledWith(destination, expect.anything(), recordingName, "stream", 1);
  expect(vi.mocked(sendChunkToServer)).toHaveBeenCalledWith(destination, expect.anything(), recordingName, "overlay", 0);
  expect(vi.mocked(sendChunkToServer)).toHaveBeenCalledWith(destination, expect.anything(), recordingName, "overlay", 1);
  expect(vi.mocked(schedulePostprocessing)).toHaveBeenCalledWith(destination, recordingName, "lecturer@example.com");
});

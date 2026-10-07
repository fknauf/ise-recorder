import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { wipeOpfs } from "../helpers/opfs";
import { RecordingDestination, RecordingTrackBundle, recordLecture } from "@/lib/utils/recording";
import { gatherRecordingsList } from "@/lib/utils/browserStorage";
import { render, screen } from "@testing-library/react";
import { uploadChunk, schedulePostprocessing } from "@/lib/utils/serverStorage";

vi.mock("@/lib/utils/serverStorage");
// recordLecture says how the job request went; a real toast would outlive the test
vi.mock("@/lib/utils/notifications");

beforeEach(() => {
  // stand-ins for a backend that accepts everything
  vi.mocked(uploadChunk).mockResolvedValue();
  vi.mocked(schedulePostprocessing).mockImplementation(async (_destination, recording) => ({ state: "rendering", name: recording }));
});

const accessToken = async () => "test-token";

afterEach(async () => {
  await wipeOpfs();
});

test("recordLecture does nothing when there are no tracks", async () => {
  const onStarting = vi.fn();
  const onStarted = vi.fn();
  const onChunkWritten = vi.fn();
  const onFinished = vi.fn();
  const onStreamingFailed = vi.fn();

  const destination: RecordingDestination = {
    apiUrl: "http://example.com",
    impeded: false,
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
    onStarting, onStarted, onChunkWritten, onFinished, onStreamingFailed);

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
  const onStreamingFailed = vi.fn();

  window.fetch = vi.fn().mockResolvedValue(Response.json("", { status: 201 }));

  const trackBundle: RecordingTrackBundle = {
    displayTracks,
    videoTracks,
    audioTracks: [],
    mainDisplay,
    overlay
  };

  const destination: RecordingDestination = {
    apiUrl: "http://example.com",
    impeded: false,
    getAccessToken: accessToken
  };

  const renderPromise = recordLecture(
    trackBundle,
    "FOO", "lecturer@example.com",
    destination,
    onStarting, onStarted, onChunkWritten, onFinished, onStreamingFailed);

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

  // the backend is addressed without the impeded flag, which only concerns recordLecture itself
  const apiDestination = { apiUrl: destination.apiUrl, getAccessToken: accessToken };

  expect(vi.mocked(uploadChunk)).toHaveBeenCalledTimes(4);
  expect(vi.mocked(uploadChunk)).toHaveBeenCalledWith(apiDestination, expect.any(Blob), recordingName, "stream", 0, expect.any(AbortSignal));
  expect(vi.mocked(uploadChunk)).toHaveBeenCalledWith(apiDestination, expect.any(Blob), recordingName, "stream", 1, expect.any(AbortSignal));
  expect(vi.mocked(uploadChunk)).toHaveBeenCalledWith(apiDestination, expect.any(Blob), recordingName, "overlay", 0, expect.any(AbortSignal));
  expect(vi.mocked(uploadChunk)).toHaveBeenCalledWith(apiDestination, expect.any(Blob), recordingName, "overlay", 1, expect.any(AbortSignal));
  expect(vi.mocked(schedulePostprocessing)).toHaveBeenCalledWith(apiDestination, recordingName, "lecturer@example.com", expect.any(AbortSignal));
  // every chunk arrived, so there is nothing to re-upload
  expect(onStreamingFailed).not.toHaveBeenCalled();
});

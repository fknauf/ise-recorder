import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { VideoPreview } from "@/app/lib/components/VideoPreview";
import { MediaMock, devices } from "@eatsjobs/media-mock";
import userEvent from "@testing-library/user-event";

test("VideoPreview displays video track", async () => {
  const width = 640;
  const height = 480;
  const srcImageUrl = "__tests__/assets/lorempicsum-560-640x480.png";

  MediaMock.mock(devices["Mac Desktop"]);
  await MediaMock.setMediaURL(srcImageUrl);

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: width,
      height: height
    },
    audio: false
  });
  const track = stream.getVideoTracks().at(0) as MediaStreamTrack;

  // canary in case someone ever fiddles with the playwright configuration. media-mock
  // switches width and height around when it believes the window is in portrait orientation
  expect(track.getSettings().height).toBe(height);
  expect(track.getSettings().width).toBe(width);

  render(
    <>
      <VideoPreview
        track={track}
        width={width}
        height={height}
        isMainDisplay={true}
        isOverlay={false}
        switchesDisabled={false}
        onToggleMainDisplay={() => {}}
        onToggleOverlay={() => {}}
      />
      {
        // Apparently the only way to extract image data from video elements and image files in Javascript is
        // to render them to a canvas and extract from there. This strikes me as extremely silly API design,
        // but I'll just have to deal with it, won't I.
      }
      <canvas
        width={width}
        height={height}
        data-testid="test-img-snapshot-extractor"
      />
      <canvas
        width={width}
        height={height}
        data-testid="test-img-srcimage-extractor"
      />
    </>
  );

  const display = await screen.findByRole("img") as HTMLVideoElement;
  await display.play();

  expect(display.width).toBe(width);
  expect(display.height).toBe(height);

  // extract image data from video preview
  const snapshotCanvas = await screen.findByTestId("test-img-snapshot-extractor") as HTMLCanvasElement;
  const snapshotContext = snapshotCanvas.getContext("2d") as CanvasRenderingContext2D;
  snapshotContext?.drawImage(display, 0, 0, width, height);
  const snapshotData = snapshotContext?.getImageData(0, 0, width, height, { colorSpace: "srgb" });

  // extract image data from source file
  const srcImageResponse = await fetch(srcImageUrl);
  const srcImageBlob = await srcImageResponse.blob();
  const srcImageBitmap = await createImageBitmap(srcImageBlob);
  const srcImageCanvas = await screen.findByTestId("test-img-srcimage-extractor") as HTMLCanvasElement;
  const srcImageContext = srcImageCanvas.getContext("2d") as CanvasRenderingContext2D;
  srcImageContext?.drawImage(srcImageBitmap, 0, 0);
  const srcImageData = srcImageContext?.getImageData(0, 0, width, height, { colorSpace: "srgb" });

  expect(srcImageData).not.toBeUndefined();
  expect(snapshotData).not.toBeUndefined();

  // This is semantically the same as expect(snapshotData.data).toEqual(srcImageData). We do it this way
  // because checking with toEqual on such a long array is extremely slow in playwright with chromium.
  const mismatches = snapshotData.data.some((x, i) => x !== srcImageData.data[i]);
  expect(mismatches).toBeFalsy();
});

test("VideoPreview handles user input", async () => {
  const srcImageUrl = "__tests__/assets/lorempicsum-560-640x480.png";

  MediaMock.mock(devices["Mac Desktop"]);
  await MediaMock.setMediaURL(srcImageUrl);

  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const track = stream.getVideoTracks().at(0) as MediaStreamTrack;

  const onToggleMainDisplay = vi.fn();
  const onToggleOverlay = vi.fn();

  const user = userEvent.setup();

  render(
    <VideoPreview
      track={track}
      width={384}
      height={216}
      isMainDisplay={true}
      isOverlay={false}
      switchesDisabled={false}
      onToggleMainDisplay={onToggleMainDisplay}
      onToggleOverlay={onToggleOverlay}
    />
  );

  const mainToggleSwitch = await screen.findByTestId("vp-toggle-main");
  const overlayToggleSwitch = await screen.findByTestId("vp-toggle-overlay");

  await user.click(mainToggleSwitch);
  expect(onToggleMainDisplay).toHaveBeenLastCalledWith(false);

  await user.click(overlayToggleSwitch);
  expect(onToggleOverlay).toHaveBeenLastCalledWith(true);
});

test("VideoPreview doesn't handle user input when disabled", async () => {
  const srcImageUrl = "__tests__/assets/lorempicsum-560-640x480.png";

  MediaMock.mock(devices["Mac Desktop"]);
  await MediaMock.setMediaURL(srcImageUrl);

  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const track = stream.getVideoTracks().at(0) as MediaStreamTrack;

  const onToggleMainDisplay = vi.fn();
  const onToggleOverlay = vi.fn();

  const user = userEvent.setup();

  render(
    <VideoPreview
      track={track}
      width={384}
      height={216}
      isMainDisplay={true}
      isOverlay={false}
      switchesDisabled={true}
      onToggleMainDisplay={onToggleMainDisplay}
      onToggleOverlay={onToggleOverlay}
    />
  );

  const mainToggleSwitch = await screen.findByTestId("vp-toggle-main");
  const overlayToggleSwitch = await screen.findByTestId("vp-toggle-overlay");

  expect(mainToggleSwitch).toBeDisabled();
  expect(overlayToggleSwitch).toBeDisabled();

  await user.click(mainToggleSwitch);
  expect(onToggleMainDisplay).not.toHaveBeenCalled();

  await user.click(overlayToggleSwitch);
  expect(onToggleOverlay).not.toHaveBeenCalled();
});

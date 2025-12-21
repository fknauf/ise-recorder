import { expect, test, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { VideoPreview } from "@/app/lib/components/VideoPreview";
import userEvent from "@testing-library/user-event";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { useEffect, useState } from "react";

test("VideoPreview displays video track", async () => {
  const width = 640;
  const height = 480;
  const srcImageUrl = "__tests__/assets/lorempicsum-560-640x480.png";

  let setPreviewTrack: (track: MediaStreamTrack) => void = () => {};

  const TestComponent = () => {
    const [ track, setTrack ] = useState<MediaStreamTrack>();

    useEffect(() => {
      setPreviewTrack = setTrack;
    }, []);

    return (
      <Provider theme={defaultTheme}>
        {
          track &&
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
        }
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
      </Provider>
    );
  };

  render(<TestComponent/>);

  // extract image data from source file
  const srcImageResponse = await fetch(srcImageUrl);
  const srcImageBlob = await srcImageResponse.blob();
  const srcImageBitmap = await createImageBitmap(srcImageBlob);
  const srcImageCanvas = await screen.findByTestId("test-img-srcimage-extractor") as HTMLCanvasElement;
  const srcImageContext = srcImageCanvas.getContext("2d") as CanvasRenderingContext2D;
  srcImageContext?.drawImage(srcImageBitmap, 0, 0);
  const srcImageData = srcImageContext?.getImageData(0, 0, width, height, { colorSpace: "srgb" });

  const stream = srcImageCanvas.captureStream(30);
  act(() => setPreviewTrack(stream.getVideoTracks()[0]));

  const display = await screen.findByRole("img") as HTMLVideoElement;
  await display.play();

  expect(display.width).toBe(width);
  expect(display.height).toBe(height);

  // extract image data from video preview
  const snapshotCanvas = await screen.findByTestId("test-img-snapshot-extractor") as HTMLCanvasElement;
  const snapshotContext = snapshotCanvas.getContext("2d") as CanvasRenderingContext2D;
  snapshotContext?.drawImage(display, 0, 0, width, height);
  const snapshotData = snapshotContext?.getImageData(0, 0, width, height, { colorSpace: "srgb" });

  expect(srcImageData).not.toBeUndefined();
  expect(snapshotData).not.toBeUndefined();

  // This is semantically the same as expect(snapshotData.data).toEqual(srcImageData). We do it this way
  // because checking with toEqual on such a long array is extremely slow in playwright with chromium.
  const mismatches = snapshotData.data.some((x, i) => x !== srcImageData.data[i]);
  expect(mismatches).toBeFalsy();
});

test("VideoPreview handles user input", async () => {
  const onToggleMainDisplay = vi.fn();
  const onToggleOverlay = vi.fn();

  const user = userEvent.setup();
  let setPreviewTrack: (track: MediaStreamTrack) => void = () => {};

  const TestComponent = () => {
    const [ track, setTrack ] = useState<MediaStreamTrack>();

    useEffect(() => {
      setPreviewTrack = setTrack;
    }, []);

    return (
      <Provider theme={defaultTheme}>
        {
          track &&
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
        }
        <canvas
          width={384}
          height={192}
          data-testid="track-src"
        />
      </Provider>
    );
  };

  render(<TestComponent/>);

  const trackSrc = await screen.findByTestId("track-src") as HTMLCanvasElement;
  const stream = trackSrc.captureStream();
  const track = stream.getVideoTracks()[0];

  expect(track).not.toBeUndefined();
  act(() => setPreviewTrack(track));

  const mainToggleSwitch = await screen.findByTestId("vp-toggle-main");
  const overlayToggleSwitch = await screen.findByTestId("vp-toggle-overlay");

  await user.click(mainToggleSwitch);
  expect(onToggleMainDisplay).toHaveBeenLastCalledWith(false);

  await user.click(overlayToggleSwitch);
  expect(onToggleOverlay).toHaveBeenLastCalledWith(true);
});

test("VideoPreview doesn't handle user input when disabled", async () => {
  const onToggleMainDisplay = vi.fn();
  const onToggleOverlay = vi.fn();

  const user = userEvent.setup();
  let setPreviewTrack: (track: MediaStreamTrack) => void = () => {};

  const TestComponent = () => {
    const [ track, setTrack ] = useState<MediaStreamTrack>();

    useEffect(() => {
      setPreviewTrack = setTrack;
    }, []);

    return (
      <Provider theme={defaultTheme}>
        {
          track &&
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
        }
        <canvas
          width={384}
          height={192}
          data-testid="track-src"
        />
      </Provider>
    );
  };

  render(<TestComponent/>);

  const trackSrc = await screen.findByTestId("track-src") as HTMLCanvasElement;
  const stream = trackSrc.captureStream();
  const track = stream.getVideoTracks()[0];

  expect(track).not.toBeUndefined();
  act(() => setPreviewTrack(track));

  const mainToggleSwitch = await screen.findByTestId("vp-toggle-main");
  const overlayToggleSwitch = await screen.findByTestId("vp-toggle-overlay");

  expect(mainToggleSwitch).toBeDisabled();
  expect(overlayToggleSwitch).toBeDisabled();

  await user.click(mainToggleSwitch);
  expect(onToggleMainDisplay).not.toHaveBeenCalled();

  await user.click(overlayToggleSwitch);
  expect(onToggleOverlay).not.toHaveBeenCalled();
});

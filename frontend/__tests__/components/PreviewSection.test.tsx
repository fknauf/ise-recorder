import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useEffect } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { AppStoreProvider, useAppStore } from "@/lib/hooks/useAppStore";
import { PreviewSection } from "@/lib/components/PreviewSection";
import { ActiveRecording } from "@/lib/store/store";

/**
 * Only the two things in PreviewSection that are logic rather than presentation.
 *
 * Deliberately not covered: the order previews appear in, their labels, and the layout.
 * Nothing depends on those, so asserting them would freeze arbitrary choices and make
 * the file expensive to change for no benefit.
 */

vi.mock("@/lib/components/AudioPreview", () => ({
  AudioPreview: () => <div data-testid="preview-audio"/>
}));

interface Handles {
  addDisplayTracks: (tracks: MediaStreamTrack[]) => void
  addVideoTracks: (tracks: MediaStreamTrack[]) => void
  setActiveRecording: (recording: ActiveRecording) => void
  mainDisplay: MediaStreamTrack | undefined
  overlay: MediaStreamTrack | undefined
}

let handles: Handles;

/** Publishes the store's setters and current selection, so a test can drive and read it. */
function StoreHandles() {
  const addDisplayTracks = useAppStore(state => state.addDisplayTracks);
  const addVideoTracks = useAppStore(state => state.addVideoTracks);
  const setActiveRecording = useAppStore(state => state.setActiveRecording);
  const mainDisplay = useAppStore(state => state.mainDisplay);
  const overlay = useAppStore(state => state.overlay);

  useEffect(() => {
    handles = { addDisplayTracks, addVideoTracks, setActiveRecording, mainDisplay, overlay };
  });

  return null;
}

const videoTrack = () => {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 48;
  return canvas.captureStream().getVideoTracks()[0];
};

let tracks: MediaStreamTrack[] = [];

function renderSection() {
  render(
    <Provider theme={defaultTheme}>
      <AppStoreProvider serverEnv={{}}>
        <StoreHandles/>
        <PreviewSection canvasWidth={64} canvasHeight={48}/>
      </AppStoreProvider>
    </Provider>
  );
}

/** One captured screen, which the store makes the main display on arrival. */
function withOneDisplay() {
  const display = videoTrack();
  tracks.push(display);
  renderSection();
  act(() => handles.addDisplayTracks([ display ]));
  return display;
}

beforeEach(() => {
  tracks = [];
});

afterEach(() => {
  for(const track of tracks) {
    track.stop();
  }
  cleanup();
});

// --- controls are locked while a recording is in flight --------------------

const RECORDING: ActiveRecording = { state: "recording", name: "GVS", stop: () => {}, streamingImpeded: false };

test("every control is live while idle", () => {
  withOneDisplay();

  expect(screen.getByRole("button", { name: "Remove" })).toBeEnabled();
  expect(screen.getByTestId("vp-toggle-main")).not.toBeDisabled();
  expect(screen.getByTestId("vp-toggle-overlay")).not.toBeDisabled();
});

test.each([
  [ "starting", { state: "starting", name: "GVS" } as ActiveRecording ],
  [ "recording", RECORDING ],
  [ "stopping", { state: "stopping", name: "GVS" } as ActiveRecording ]
])("controls are locked while %s", (_state, activeRecording) => {
  withOneDisplay();
  act(() => handles.setActiveRecording(activeRecording));

  // Removing a track mid-recording pulls it out from under a live MediaRecorder, and
  // changing the main display or overlay after the output files are laid out would put
  // the wrong content in them. Every non-idle state has to be locked, not just "recording".
  expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
  expect(screen.getByTestId("vp-toggle-main")).toBeDisabled();
  expect(screen.getByTestId("vp-toggle-overlay")).toBeDisabled();
});

test("controls come back once the recording is finished", () => {
  withOneDisplay();

  act(() => handles.setActiveRecording(RECORDING));
  expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();

  act(() => handles.setActiveRecording({ state: "idle" }));

  expect(screen.getByRole("button", { name: "Remove" })).toBeEnabled();
});

// --- switching a role off clears it ----------------------------------------

test("switching off the main display clears the selection rather than reselecting", async () => {
  const display = withOneDisplay();
  expect(handles.mainDisplay).toBe(display);

  await userEvent.click(screen.getByTestId("vp-toggle-main"));

  // the callback passes undefined when deselecting. Passing the track either way looks
  // identical on screen but leaves the role stuck on, and the mistake only surfaces
  // later as the wrong track in the recorded output.
  expect(handles.mainDisplay).toBeUndefined();
});

test("switching on the main display selects that track", async () => {
  const display = withOneDisplay();

  await userEvent.click(screen.getByTestId("vp-toggle-main"));
  expect(handles.mainDisplay).toBeUndefined();

  await userEvent.click(screen.getByTestId("vp-toggle-main"));

  expect(handles.mainDisplay).toBe(display);
});

test("switching off the overlay clears the selection", async () => {
  const display = withOneDisplay();

  await userEvent.click(screen.getByTestId("vp-toggle-overlay"));
  expect(handles.overlay).toBe(display);

  await userEvent.click(screen.getByTestId("vp-toggle-overlay"));

  expect(handles.overlay).toBeUndefined();
});

test("the two roles are independent", async () => {
  const display = withOneDisplay();

  await userEvent.click(screen.getByTestId("vp-toggle-overlay"));

  // turning on the overlay must not disturb the main display
  expect(handles.overlay).toBe(display);
  expect(handles.mainDisplay).toBe(display);
});

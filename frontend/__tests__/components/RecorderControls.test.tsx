import { expect, test, vi } from "vitest";
import { makeDevice } from "../helpers/media";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecorderControls } from "@/lib/components/RecorderControls";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { useServerEnv } from "@/lib/hooks/useServerEnv";
import { useLecture } from "@/lib/hooks/useLecture";
import { useActiveRecording, useStartStopRecording } from "@/lib/hooks/useActiveRecording";
import { RefreshEffect, useMediaDevices } from "@/lib/hooks/useMediaDevices";
import { useMediaTracks } from "@/lib/hooks/useMediaTracks";
import { ActiveRecording } from "@/lib/store/store";
import { SessionProvider } from "@/lib/components/SessionProvider";

vi.mock("@/lib/hooks/useServerEnv");
vi.mock("@/lib/hooks/useLecture");
vi.mock("@/lib/hooks/useActiveRecording");
vi.mock("@/lib/hooks/useMediaDevices");
vi.mock("@/lib/hooks/useMediaTracks");

/**
 * A track, as far as this component is concerned: it only ever counts them. Building real
 * ones through canvas.captureStream would cost a working media pipeline per test for no
 * extra coverage.
 */
const aTrack = () => ({}) as MediaStreamTrack;

interface ConfiguredTracks {
  displayTracks?: MediaStreamTrack[]
  videoTracks?: MediaStreamTrack[]
  audioTracks?: MediaStreamTrack[]
}

function setupMockHooks(
  apiUrl: string | undefined,
  lectureTitle: string,
  lecturerEmail: string,
  videoDevices: MediaDeviceInfo[],
  audioDevices: MediaDeviceInfo[],
  activeRecording: ActiveRecording,
  // defaults to something recordable: these tests are about the other controls, and an
  // empty default would silently disable the start button underneath all of them
  tracks: ConfiguredTracks = { displayTracks: [ aTrack() ] }
) {
  const setLectureTitle = vi.fn();
  const setLecturerEmail = vi.fn();
  const startRecording = vi.fn();
  const stopRecording = vi.fn();
  const refreshMediaDevices = vi.fn();
  const openDisplayStream = vi.fn();
  const openVideoStream = vi.fn();
  const openAudioStream = vi.fn();

  vi.mocked(useServerEnv).mockReturnValue({
    apiUrl: apiUrl
  });

  vi.mocked(useLecture).mockReturnValue({
    lectureTitle,
    lecturerEmail,
    setLectureTitle,
    setLecturerEmail
  });

  vi.mocked(useActiveRecording).mockReturnValue(activeRecording);

  vi.mocked(useStartStopRecording).mockReturnValue({
    startRecording,
    stopRecording
  });

  vi.mocked(useMediaTracks).mockReturnValue({
    displayTracks: tracks.displayTracks ?? [],
    videoTracks: tracks.videoTracks ?? [],
    audioTracks: tracks.audioTracks ?? [],
    mainDisplay: undefined,
    overlay: undefined,
    selectMainDisplay: vi.fn(),
    selectOverlay: vi.fn(),
    removeTrack: vi.fn()
  });

  vi.mocked(useMediaDevices).mockReturnValue({
    videoDevices,
    audioDevices,
    refreshMediaDevices,
    openDisplayStream,
    openVideoStream,
    openAudioStream
  });

  return {
    setLectureTitle,
    setLecturerEmail,
    startRecording,
    stopRecording,
    refreshMediaDevices,
    openDisplayStream,
    openVideoStream,
    openAudioStream
  };
}

function renderControls() {
  render(
    <Provider theme={defaultTheme}>
      <SessionProvider serverEnv={{}}>
        <RecorderControls/>
      </SessionProvider>
    </Provider>
  );
}

// --- what each recorder state lets the user do -----------------------------

test.each([
  { activeRecording: { state: "idle" }, editable: true, recordButton: "Start Recording", recordEnabled: true },
  // the transitional states take no input: a second press could start or stop twice
  { activeRecording: { state: "preparing" }, editable: false, recordButton: "Stop Recording", recordEnabled: false },
  { activeRecording: { state: "starting", name: "PSU_TIMESTAMP" }, editable: false, recordButton: "Stop Recording", recordEnabled: false },
  { activeRecording: { state: "recording", name: "PSU_TIMESTAMP", stop: () => {} }, editable: false, recordButton: "Stop Recording", recordEnabled: true },
  { activeRecording: { state: "stopping", name: "PSU_TIMESTAMP" }, editable: false, recordButton: "Stop Recording", recordEnabled: false }
] as { activeRecording: ActiveRecording; editable: boolean; recordButton: string; recordEnabled: boolean }[])(
  "RecorderControls while $activeRecording.state",
  async ({ activeRecording, editable, recordButton, recordEnabled }) => {
    setupMockHooks("http://localhost:8000", "PSU", "lecturer@vss.uni-hannover.de", [], [], activeRecording);
    renderControls();

    const textFields = await screen.findAllByRole("textbox") as HTMLInputElement[];
    const buttons = await screen.findAllByRole("button");

    expect(textFields.map(field => field.value)).toStrictEqual([ "PSU", "lecturer@vss.uni-hannover.de" ]);
    expect(buttons.map(button => button.textContent)).toStrictEqual(["Add Screen/Window", "Add Video Source", "Add Audio Source", recordButton]);

    // the title and the tracks belong to the recording once it is under way
    for(const control of [ ...textFields, ...buttons.slice(0, 3) ]) {
      expect(control.matches(":disabled")).toBe(!editable);
    }
    expect(buttons[3].matches(":disabled")).toBe(!recordEnabled);
  }
);

test("RecorderControls hides the e-mail field when apiUrl is undefined", async () => {
  setupMockHooks(undefined, "PSU", "lecturer@vss.uni-hannover.de", [], [], { state: "idle" });
  renderControls();

  const textFields = await screen.findAllByRole("textbox") as HTMLInputElement[];

  expect(textFields.length).toBe(1);
  expect(textFields[0].value).toBe("PSU");
});

// --- what the controls set off -----------------------------------------------
//
// The hooks behind them are mocked; what each action does is the hooks' business, in
// useStartStopRecording.test.tsx, useMediaDevices.test.tsx and store/store.test.tsx.

test("RecorderControls starts a recording", async () => {
  const callbacks = setupMockHooks("http://localhost:8000", "PSU", "lecturer@vss.uni-hannover.de", [], [], { state: "idle" });
  renderControls();

  await userEvent.setup().click(await screen.findByRole("button", { name: /Start Recording/ }));

  expect(callbacks.startRecording).toHaveBeenCalledOnce();
});

test("RecorderControls stops the recording", async () => {
  const callbacks = setupMockHooks(
    "http://localhost:8000", "PSU", "lecturer@vss.uni-hannover.de", [], [],
    { state: "recording", name: "PSU_TIMESTAMP", stop: vi.fn() }
  );
  renderControls();

  await userEvent.setup().click(await screen.findByRole("button", { name: /Stop Recording/ }));

  expect(callbacks.stopRecording).toHaveBeenCalledOnce();
});

test.each([
  {
    button: "Add Video Source",
    devices: { video: [ makeDevice("c1", "1", "videoinput", "Camera 1"), makeDevice("c2", "2", "videoinput", "Camera 2") ], audio: [] },
    pick: 0,
    opens: "openVideoStream",
    with: { groupId: "1", deviceId: "c1" }
  },
  {
    button: "Add Audio Source",
    devices: { video: [], audio: [ makeDevice("m1", "1", "audioinput", "Microphone 1"), makeDevice("m2", "2", "audioinput", "Microphone 2") ] },
    pick: 1,
    opens: "openAudioStream",
    with: { groupId: "2", deviceId: "m2" }
  }
] as const)("RecorderControls lists the devices behind $button and opens the one picked", async ({ button, devices, pick, opens, with: uid }) => {
  const callbacks = setupMockHooks(
    "http://localhost:8000", "PSU", "lecturer@vss.uni-hannover.de", [ ...devices.video ], [ ...devices.audio ], { state: "idle" }
  );
  renderControls();
  const user = userEvent.setup();

  await user.click(screen.getByText(button));
  expect(callbacks.refreshMediaDevices).toHaveBeenCalledOnce();

  const menu = await screen.findAllByRole("menuitem");
  expect(menu.map(item => item.textContent)).toStrictEqual([ ...devices.video, ...devices.audio ].map(dev => dev.label));

  await user.click(menu[pick]);
  expect(callbacks[opens]).toHaveBeenCalledExactlyOnceWith(uid);
});

test("RecorderControls hands typed lecture data to the store", async () => {
  const callbacks = setupMockHooks("http://localhost:8000", "PSU", "lecturer@vss.uni-hannover.de", [], [], { state: "idle" });
  renderControls();
  const user = userEvent.setup();

  // the fields are controlled and the mocked hook does not feed the change back, so each
  // keystroke arrives on top of the original value
  await user.type(screen.getByLabelText("Lecture Title"), "2");
  expect(callbacks.setLectureTitle).toHaveBeenCalledExactlyOnceWith("PSU2");

  await user.type(screen.getByLabelText("e-Mail"), "2");
  expect(callbacks.setLecturerEmail).toHaveBeenCalledExactlyOnceWith("lecturer@vss.uni-hannover.de2");
});

// --- there has to be something to record -----------------------------------

/**
 * recordLecture short-circuits on an empty track bundle without telling anyone, so a
 * press with nothing configured used to look like a dead button. Disabling it makes the
 * precondition visible instead.
 */

const startButton = async () => await screen.findByRole("button", { name: /Start Recording/ });

const renderIdleWith = (tracks: ConfiguredTracks) => {
  setupMockHooks(
    "http://localhost:8000",
    "PSU",
    "lecturer@vss.uni-hannover.de",
    [],
    [],
    { state: "idle" },
    tracks
  );

  renderControls();
};

test("RecorderControls disables start when nothing is configured", async () => {
  renderIdleWith({});

  expect(await startButton()).toBeDisabled();
});

test.each([
  [ "a screen capture", { displayTracks: [ aTrack() ] } ],
  [ "a camera", { videoTracks: [ aTrack() ] } ],
  [ "a microphone alone", { audioTracks: [ aTrack() ] } ]
])("RecorderControls enables start with %s", async (_label, tracks) => {
  // an audio-only recording is a legitimate lecture, so any single track counts
  renderIdleWith(tracks);

  expect(await startButton()).toBeEnabled();
});

// --- the device menus after a permission prompt ----------------------------
//
// Opening a device menu refreshes the device list, and on a first visit that is where the
// browser asks for permission. The user picks devices in that prompt, and the refresh adds
// them straight away -- so the menu behind it has nothing left to offer, and left open it
// would swallow the next click. What refreshMediaDevices reports is its own business, in
// useMediaDevices.test.tsx; these pin what the menu does with it.

const DEVICE_MENUS = [
  { button: "Add Video Source", device: "Camera 1", kind: "videoinput" },
  { button: "Add Audio Source", device: "Microphone 1", kind: "audioinput" }
] as const;

function renderWithDeviceMenus() {
  const device = (label: string, kind: MediaDeviceKind) => makeDevice(label, label, kind, label);

  const callbacks = setupMockHooks(
    "http://localhost:8000",
    "PSU",
    "lecturer@vss.uni-hannover.de",
    [ device("Camera 1", "videoinput") ],
    [ device("Microphone 1", "audioinput") ],
    { state: "idle" }
  );

  // the refresh settles when the test says so, so the menu can be looked at on either side
  let settleRefresh: (effect: RefreshEffect) => void = () => {};
  callbacks.refreshMediaDevices.mockImplementation(() => new Promise<RefreshEffect>(resolve => {
    settleRefresh = resolve;
  }));

  renderControls();

  return {
    callbacks,
    settle: (effect: RefreshEffect) => act(async () => settleRefresh(effect))
  };
}

// Whether a menu is open is read off its trigger: aria-expanded follows the open state at
// once, while the menu itself lingers in the DOM for as long as its closing animation runs --
// long enough that a menu on its way out would still pass for an open one.
const menuTrigger = (button: string) => screen.getByText(button).closest("button") as HTMLElement;

test.each(DEVICE_MENUS)("the menu behind $button closes once the refresh added the devices picked in the prompt", async ({ button, device }) => {
  const { settle } = renderWithDeviceMenus();
  const user = userEvent.setup();

  await user.click(screen.getByText(button));
  expect(await screen.findByRole("menuitem", { name: device })).toBeInTheDocument();

  await settle("added-tracks");

  expect(menuTrigger(button)).toHaveAttribute("aria-expanded", "false");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

test.each(DEVICE_MENUS)("the menu behind $button stays open after a refresh that only listed devices", async ({ button, device }) => {
  // permissions were already there, so the menu is how the user picks a device
  const { settle } = renderWithDeviceMenus();
  const user = userEvent.setup();

  await user.click(screen.getByText(button));
  await settle("just-refreshed");

  expect(menuTrigger(button)).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("menuitem", { name: device })).toBeInTheDocument();
});

test.each(DEVICE_MENUS)("the menu behind $button stays shut if the user closed it before the refresh settled", async ({ button }) => {
  // the refresh may wait on a permission prompt for as long as the user takes; the menu
  // is theirs to close in the meantime, and nothing coming back afterwards reopens it
  const { settle } = renderWithDeviceMenus();
  const user = userEvent.setup();

  await user.click(screen.getByText(button));
  await screen.findByRole("menu");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  await settle("just-refreshed");

  expect(menuTrigger(button)).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("menu")).toBeNull();
});

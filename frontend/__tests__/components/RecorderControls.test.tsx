import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecorderControls } from "@/app/lib/components/RecorderControls";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { useServerEnv } from "@/app/lib/hooks/useServerEnv";
import { useLecture } from "@/app/lib/hooks/useLecture";
import { useActiveRecording, useStartStopRecording } from "@/app/lib/hooks/useActiveRecording";
import { useMediaDevices } from "@/app/lib/hooks/useMediaDevices";
import { ActiveRecording } from "@/app/lib/store/store";

vi.mock("@/app/lib/hooks/useServerEnv");
vi.mock("@/app/lib/hooks/useLecture");
vi.mock("@/app/lib/hooks/useActiveRecording");
vi.mock("@/app/lib/hooks/useMediaDevices");

function setupMockHooks(
  apiUrl: string | undefined,
  lectureTitle: string,
  lecturerEmail: string,
  videoDevices: MediaDeviceInfo[],
  audioDevices: MediaDeviceInfo[],
  activeRecording: ActiveRecording
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

test("RecorderControls renders controls correctly when idle", async () => {
  setupMockHooks(
    "http://localhost:8000",
    "PSU",
    "lecturer@vss.uni-hannover.de",
    [],
    [],
    { state: "idle" }
  );

  render(
    <Provider theme={defaultTheme}>
      <RecorderControls/>
    </Provider>
  );

  const textFields = await screen.findAllByRole("textbox") as HTMLInputElement[];
  const buttons = await screen.findAllByRole("button");

  expect(textFields.length).toBe(2);

  expect(textFields[0].value).toBe("PSU");
  expect(textFields[1].value).toBe("lecturer@vss.uni-hannover.de");

  expect(textFields[0]).not.toBeDisabled();
  expect(textFields[1]).not.toBeDisabled();

  expect(buttons.length).toBe(4);

  expect(buttons[0]).toHaveTextContent("Add Screen/Window");
  expect(buttons[1]).toHaveTextContent("Add Video Source");
  expect(buttons[2]).toHaveTextContent("Add Audio Source");
  expect(buttons[3]).toHaveTextContent("Start Recording");

  expect(buttons[0]).not.toBeDisabled();
  expect(buttons[1]).not.toBeDisabled();
  expect(buttons[2]).not.toBeDisabled();
  expect(buttons[3]).not.toBeDisabled();
});

test("RecorderControls renders controls correctly when recording", async () => {
  setupMockHooks(
    "http://localhost:8000",
    "PSU",
    "lecturer@vss.uni-hannover.de",
    [],
    [],
    { state: "recording", name: "PSU_TIMESTAMP", stop: vi.fn() }
  );

  render(
    <Provider theme={defaultTheme}>
      <RecorderControls/>
    </Provider>
  );

  const textFields = await screen.findAllByRole("textbox") as HTMLInputElement[];
  const buttons = await screen.findAllByRole("button");

  expect(textFields.length).toBe(2);

  expect(textFields[0].value).toBe("PSU");
  expect(textFields[1].value).toBe("lecturer@vss.uni-hannover.de");

  expect(textFields[0]).toBeDisabled();
  expect(textFields[1]).toBeDisabled();

  expect(buttons.length).toBe(4);

  expect(buttons[0]).toHaveTextContent("Add Screen/Window");
  expect(buttons[1]).toHaveTextContent("Add Video Source");
  expect(buttons[2]).toHaveTextContent("Add Audio Source");
  expect(buttons[3]).toHaveTextContent("Stop Recording");

  expect(buttons[0]).toBeDisabled();
  expect(buttons[1]).toBeDisabled();
  expect(buttons[2]).toBeDisabled();
  expect(buttons[3]).not.toBeDisabled();
});

test("RecorderControls renders controls correctly when starting a recording", async () => {
  setupMockHooks(
    "http://localhost:8000",
    "PSU",
    "lecturer@vss.uni-hannover.de",
    [],
    [],
    { state: "starting", name: "PSU_TIMESTAMP" }
  );

  render(
    <Provider theme={defaultTheme}>
      <RecorderControls/>
    </Provider>
  );

  const textFields = await screen.findAllByRole("textbox") as HTMLInputElement[];
  const buttons = await screen.findAllByRole("button");

  expect(textFields.length).toBe(2);

  expect(textFields[0].value).toBe("PSU");
  expect(textFields[1].value).toBe("lecturer@vss.uni-hannover.de");

  expect(textFields[0]).toBeDisabled();
  expect(textFields[1]).toBeDisabled();

  expect(buttons.length).toBe(4);

  expect(buttons[0]).toHaveTextContent("Add Screen/Window");
  expect(buttons[1]).toHaveTextContent("Add Video Source");
  expect(buttons[2]).toHaveTextContent("Add Audio Source");
  expect(buttons[3]).toHaveTextContent("Stop Recording");

  expect(buttons[0]).toBeDisabled();
  expect(buttons[1]).toBeDisabled();
  expect(buttons[2]).toBeDisabled();
  expect(buttons[3]).toBeDisabled();
});

test("RecorderControls renders controls correctly when stopping a recording", async () => {
  setupMockHooks(
    "http://localhost:8000",
    "PSU",
    "lecturer@vss.uni-hannover.de",
    [],
    [],
    { state: "stopping", name: "PSU_TIMESTAMP" }
  );

  render(
    <Provider theme={defaultTheme}>
      <RecorderControls/>
    </Provider>
  );

  const textFields = await screen.findAllByRole("textbox") as HTMLInputElement[];
  const buttons = await screen.findAllByRole("button");

  expect(textFields.length).toBe(2);

  expect(textFields[0].value).toBe("PSU");
  expect(textFields[1].value).toBe("lecturer@vss.uni-hannover.de");

  expect(textFields[0]).toBeDisabled();
  expect(textFields[1]).toBeDisabled();

  expect(buttons.length).toBe(4);

  expect(buttons[0]).toHaveTextContent("Add Screen/Window");
  expect(buttons[1]).toHaveTextContent("Add Video Source");
  expect(buttons[2]).toHaveTextContent("Add Audio Source");
  expect(buttons[3]).toHaveTextContent("Stop Recording");

  expect(buttons[0]).toBeDisabled();
  expect(buttons[1]).toBeDisabled();
  expect(buttons[2]).toBeDisabled();
  expect(buttons[3]).toBeDisabled();
});

test("RecorderControls hides the e-mail field when apiUrl is undefined", async () => {
  setupMockHooks(
    undefined,
    "PSU",
    "lecturer@vss.uni-hannover.de",
    [],
    [],
    { state: "idle" }
  );

  render(
    <Provider theme={defaultTheme}>
      <RecorderControls/>
    </Provider>
  );

  const textFields = await screen.findAllByRole("textbox") as HTMLInputElement[];

  expect(textFields.length).toBe(1);
  expect(textFields[0].value).toBe("PSU");
});

test("RecorderControls handles the start recording button properly", async () => {
  const callbacks = setupMockHooks(
    "http://localhost:8000",
    "PSU",
    "lecturer@vss.uni-hannover.de",
    [],
    [],
    { state: "idle" }
  );

  render(
    <Provider theme={defaultTheme}>
      <RecorderControls/>
    </Provider>
  );

  const user = userEvent.setup();

  const buttons = await screen.findAllByRole("button");
  expect(buttons[3]).toHaveTextContent("Start Recording");
  await user.click(buttons[3]);

  expect(callbacks.startRecording).toHaveBeenCalled();
  expect(callbacks.stopRecording).not.toHaveBeenCalled();

  expect(callbacks.setLectureTitle).not.toHaveBeenCalled();
  expect(callbacks.setLecturerEmail).not.toHaveBeenCalled();
  expect(callbacks.refreshMediaDevices).not.toHaveBeenCalled();
  expect(callbacks.openDisplayStream).not.toHaveBeenCalled();
  expect(callbacks.openVideoStream).not.toHaveBeenCalled();
  expect(callbacks.openAudioStream).not.toHaveBeenCalled();
});

test("RecorderControls handles the stop recording button properly", async () => {
  const callbacks = setupMockHooks(
    "http://localhost:8000",
    "PSU",
    "lecturer@vss.uni-hannover.de",
    [],
    [],
    { state: "recording", name: "PSU_TIMESTAMP", stop: vi.fn() }
  );

  render(
    <Provider theme={defaultTheme}>
      <RecorderControls/>
    </Provider>
  );

  const user = userEvent.setup();

  const buttons = await screen.findAllByRole("button");
  expect(buttons[3]).toHaveTextContent("Stop Recording");
  await user.click(buttons[3]);

  expect(callbacks.stopRecording).toHaveBeenCalled();
  expect(callbacks.startRecording).not.toHaveBeenCalled();

  expect(callbacks.setLectureTitle).not.toHaveBeenCalled();
  expect(callbacks.setLecturerEmail).not.toHaveBeenCalled();
  expect(callbacks.refreshMediaDevices).not.toHaveBeenCalled();
  expect(callbacks.openDisplayStream).not.toHaveBeenCalled();
  expect(callbacks.openVideoStream).not.toHaveBeenCalled();
  expect(callbacks.openAudioStream).not.toHaveBeenCalled();
});

test("RecorderControls show video device menu", async () => {
  const makeDevice = (deviceId: string, groupId: string, kind: MediaDeviceKind, label: string): MediaDeviceInfo => ({
    deviceId, groupId, kind, label,
    toJSON: () => JSON.stringify({ deviceId, groupId, kind, label })
  });

  const videoDevices = [
    makeDevice("c1", "1", "audioinput", "Camera 1"),
    makeDevice("c2", "2", "audioinput", "Camera 2")
  ];

  const callbacks = setupMockHooks(
    "http://localhost:8000",
    "PSU",
    "lecturer@vss.uni-hannover.de",
    videoDevices,
    [],
    { state: "idle" }
  );

  const tree = render(
    <Provider theme={defaultTheme}>
      <RecorderControls/>
    </Provider>
  );

  const user = userEvent.setup();

  await user.click(tree.getByText("Add Video Source"));
  expect(callbacks.refreshMediaDevices).toHaveBeenCalledOnce();

  const videoMenu = await screen.findAllByRole("menuitem");
  expect(videoMenu.length).toBe(2);
  expect(videoMenu[0]).toHaveTextContent("Camera 1");
  expect(videoMenu[1]).toHaveTextContent("Camera 2");

  await user.click(videoMenu[0]);
  expect(callbacks.openVideoStream).toHaveBeenCalledExactlyOnceWith({ groupId: "1", deviceId: "c1" });
  expect(callbacks.openDisplayStream).not.toHaveBeenCalled();
  expect(callbacks.openAudioStream).not.toHaveBeenCalled();

  expect(callbacks.startRecording).not.toHaveBeenCalled();
  expect(callbacks.stopRecording).not.toHaveBeenCalled();
  expect(callbacks.setLectureTitle).not.toHaveBeenCalled();
  expect(callbacks.setLecturerEmail).not.toHaveBeenCalled();
});


test("RecorderControls show audio device menu", async () => {
  const makeDevice = (deviceId: string, groupId: string, kind: MediaDeviceKind, label: string): MediaDeviceInfo => ({
    deviceId, groupId, kind, label,
    toJSON: () => JSON.stringify({ deviceId, groupId, kind, label })
  });

  const audioDevices = [
    makeDevice("m1", "1", "audioinput", "Microphone 1"),
    makeDevice("m2", "2", "audioinput", "Microphone 2"),
    makeDevice("m3", "3", "audioinput", "Microphone 3")
  ];

  const callbacks = setupMockHooks(
    "http://localhost:8000",
    "PSU",
    "lecturer@vss.uni-hannover.de",
    [],
    audioDevices,
    { state: "idle" }
  );

  const tree = render(
    <Provider theme={defaultTheme}>
      <RecorderControls/>
    </Provider>
  );

  const user = userEvent.setup();

  await user.click(tree.getByText("Add Audio Source"));
  expect(callbacks.refreshMediaDevices).toHaveBeenCalledOnce();

  const audioMenu = await screen.findAllByRole("menuitem");
  expect(audioMenu.length).toBe(3);
  expect(audioMenu[0]).toHaveTextContent("Microphone 1");
  expect(audioMenu[1]).toHaveTextContent("Microphone 2");
  expect(audioMenu[2]).toHaveTextContent("Microphone 3");

  await user.click(audioMenu[1]);
  expect(callbacks.openAudioStream).toHaveBeenCalledExactlyOnceWith({ groupId: "2", deviceId: "m2" });
  expect(callbacks.openDisplayStream).not.toHaveBeenCalled();
  expect(callbacks.openVideoStream).not.toHaveBeenCalled();

  expect(callbacks.startRecording).not.toHaveBeenCalled();
  expect(callbacks.stopRecording).not.toHaveBeenCalled();
  expect(callbacks.setLectureTitle).not.toHaveBeenCalled();
  expect(callbacks.setLecturerEmail).not.toHaveBeenCalled();
});

test("RecorderControls handles lecture metadata", async () => {
  const callbacks = setupMockHooks(
    "http://localhost:8000",
    "PSU",
    "lecturer@vss.uni-hannover.de",
    [],
    [],
    { state: "idle" }
  );

  const tree = render(
    <Provider theme={defaultTheme}>
      <RecorderControls/>
    </Provider>
  );

  const user = userEvent.setup();

  // text field value is controlled and doesn't change upon typing, the callback would usually change it.
  // Hard to force rerenders here, though.
  await user.click(tree.getByLabelText("Lecture Title"));
  await user.type(tree.getByLabelText("Lecture Title"), "2");
  expect(callbacks.setLectureTitle).toHaveBeenCalledExactlyOnceWith("PSU2");

  await user.click(tree.getByLabelText("e-Mail"));
  await user.type(tree.getByLabelText("e-Mail"), "2");
  expect(callbacks.setLecturerEmail).toHaveBeenCalledExactlyOnceWith("lecturer@vss.uni-hannover.de2");

  expect(callbacks.refreshMediaDevices).not.toHaveBeenCalled();
  expect(callbacks.openAudioStream).not.toHaveBeenCalled();
  expect(callbacks.openDisplayStream).not.toHaveBeenCalled();
  expect(callbacks.openVideoStream).not.toHaveBeenCalled();
  expect(callbacks.startRecording).not.toHaveBeenCalled();
  expect(callbacks.stopRecording).not.toHaveBeenCalled();
});

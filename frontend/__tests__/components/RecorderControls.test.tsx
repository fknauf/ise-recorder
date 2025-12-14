import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecorderControls } from "@/app/lib/components/RecorderControls";
import { defaultTheme, Provider } from "@adobe/react-spectrum";

test("RecorderControls renders controls correctly when idle", async () => {
  render(
    <Provider theme={defaultTheme}>
      <RecorderControls
        audioDevices={[]}
        videoDevices={[]}
        hasEmailField={true}
        lectureTitle="PSU"
        lecturerEmail="lecturer@vss.uni-hannover.de"
        recorderState="idle"
      />
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
  render(
    <Provider theme={defaultTheme}>
      <RecorderControls
        audioDevices={[]}
        videoDevices={[]}
        hasEmailField={true}
        lectureTitle="PSU"
        lecturerEmail="lecturer@vss.uni-hannover.de"
        recorderState="recording"
      />
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
  render(
    <Provider theme={defaultTheme}>
      <RecorderControls
        audioDevices={[]}
        videoDevices={[]}
        hasEmailField={true}
        lectureTitle="PSU"
        lecturerEmail="lecturer@vss.uni-hannover.de"
        recorderState="starting"
      />
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
  render(
    <Provider theme={defaultTheme}>
      <RecorderControls
        audioDevices={[]}
        videoDevices={[]}
        hasEmailField={true}
        lectureTitle="PSU"
        lecturerEmail="lecturer@vss.uni-hannover.de"
        recorderState="starting"
      />
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

test("RecorderControls hides the e-mail field when specified", async () => {
  render(
    <Provider theme={defaultTheme}>
      <RecorderControls
        audioDevices={[]}
        videoDevices={[]}
        hasEmailField={false}
        lectureTitle="PSU"
        lecturerEmail="lecturer@vss.uni-hannover.de"
        recorderState="idle"
      />
    </Provider>
  );

  const textFields = await screen.findAllByRole("textbox") as HTMLInputElement[];

  expect(textFields.length).toBe(1);
  expect(textFields[0].value).toBe("PSU");
});

test("RecorderControls handles the start recording button properly", async () => {
  const onStartRecording = vi.fn();
  const onDummy = vi.fn();

  render(
    <Provider theme={defaultTheme}>
      <RecorderControls
        audioDevices={[]}
        videoDevices={[]}
        hasEmailField={true}
        lectureTitle="PSU"
        lecturerEmail="lecturer@vss.uni-hannover.de"
        onLectureTitleChanged={onDummy}
        onLecturerEmailChanged={onDummy}
        onOpenDeviceMenu={onDummy}
        onAddDisplayTrack={onDummy}
        onAddVideoTrack={onDummy}
        onAddAudioTrack={onDummy}
        onStartRecording={onStartRecording}
        onStopRecording={onDummy}
        recorderState="idle"
      />
    </Provider>
  );

  const user = userEvent.setup();

  const buttons = await screen.findAllByRole("button");
  expect(buttons[3]).toHaveTextContent("Start Recording");
  await user.click(buttons[3]);

  expect(onStartRecording).toHaveBeenCalled();
  expect(onDummy).not.toHaveBeenCalled();
});

test("RecorderControls handles the stop recording button properly", async () => {
  const onStopRecording = vi.fn();
  const onDummy = vi.fn();

  render(
    <Provider theme={defaultTheme}>
      <RecorderControls
        audioDevices={[]}
        videoDevices={[]}
        hasEmailField={true}
        lectureTitle="PSU"
        lecturerEmail="lecturer@vss.uni-hannover.de"
        onLectureTitleChanged={onDummy}
        onLecturerEmailChanged={onDummy}
        onOpenDeviceMenu={onDummy}
        onAddDisplayTrack={onDummy}
        onAddVideoTrack={onDummy}
        onAddAudioTrack={onDummy}
        onStartRecording={onDummy}
        onStopRecording={onStopRecording}
        recorderState="recording"
      />
    </Provider>
  );

  const user = userEvent.setup();

  const buttons = await screen.findAllByRole("button");
  expect(buttons[3]).toHaveTextContent("Stop Recording");
  await user.click(buttons[3]);

  expect(onStopRecording).toHaveBeenCalled();
  expect(onDummy).not.toHaveBeenCalled();
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

  const onOpenDeviceMenu = vi.fn();
  const onAddVideoTrack = vi.fn();
  const onDummy = vi.fn();

  const tree = render(
    <Provider theme={defaultTheme}>
      <RecorderControls
        audioDevices={[]}
        videoDevices={videoDevices}
        hasEmailField={true}
        lectureTitle="PSU"
        lecturerEmail="lecturer@vss.uni-hannover.de"
        recorderState="idle"
        onOpenDeviceMenu={onOpenDeviceMenu}
        onAddAudioTrack={onDummy}
        onAddDisplayTrack={onDummy}
        onAddVideoTrack={onAddVideoTrack}
        onLectureTitleChanged={onDummy}
        onLecturerEmailChanged={onDummy}
        onStartRecording={onDummy}
        onStopRecording={onDummy}
      />
    </Provider>
  );

  const user = userEvent.setup();

  await user.click(tree.getByText("Add Video Source"));
  expect(onOpenDeviceMenu).toHaveBeenCalledOnce();

  const videoMenu = await screen.findAllByRole("menuitem");
  expect(videoMenu.length).toBe(2);
  expect(videoMenu[0]).toHaveTextContent("Camera 1");
  expect(videoMenu[1]).toHaveTextContent("Camera 2");

  await user.click(videoMenu[0]);
  expect(onAddVideoTrack).toHaveBeenCalledExactlyOnceWith({ groupId: "1", deviceId: "c1" });

  expect(onDummy).not.toHaveBeenCalled();
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

  const onOpenDeviceMenu = vi.fn();
  const onAddAudioTrack = vi.fn();
  const onDummy = vi.fn();

  const tree = render(
    <Provider theme={defaultTheme}>
      <RecorderControls
        audioDevices={audioDevices}
        videoDevices={[]}
        hasEmailField={true}
        lectureTitle="PSU"
        lecturerEmail="lecturer@vss.uni-hannover.de"
        recorderState="idle"
        onOpenDeviceMenu={onOpenDeviceMenu}
        onAddAudioTrack={onAddAudioTrack}
        onAddDisplayTrack={onDummy}
        onAddVideoTrack={onDummy}
        onLectureTitleChanged={onDummy}
        onLecturerEmailChanged={onDummy}
        onStartRecording={onDummy}
        onStopRecording={onDummy}
      />
    </Provider>
  );

  const user = userEvent.setup();

  await user.click(tree.getByText("Add Audio Source"));
  expect(onOpenDeviceMenu).toHaveBeenCalledOnce();

  const audioMenu = await screen.findAllByRole("menuitem");
  expect(audioMenu.length).toBe(3);
  expect(audioMenu[0]).toHaveTextContent("Microphone 1");
  expect(audioMenu[1]).toHaveTextContent("Microphone 2");
  expect(audioMenu[2]).toHaveTextContent("Microphone 3");

  await user.click(audioMenu[1]);
  expect(onAddAudioTrack).toHaveBeenCalledExactlyOnceWith({ groupId: "2", deviceId: "m2" });
});

test("RecorderControls handles lecture metadata", async () => {
  const onLectureTitleChanged = vi.fn();
  const onLecturerEmailChanged = vi.fn();
  const onDummy = vi.fn();

  const tree = render(
    <Provider theme={defaultTheme}>
      <RecorderControls
        audioDevices={[]}
        videoDevices={[]}
        hasEmailField={true}
        lectureTitle="PSU"
        lecturerEmail="lecturer@vss.uni-hannover.de"
        recorderState="idle"
        onOpenDeviceMenu={onDummy}
        onAddAudioTrack={onDummy}
        onAddDisplayTrack={onDummy}
        onAddVideoTrack={onDummy}
        onLectureTitleChanged={onLectureTitleChanged}
        onLecturerEmailChanged={onLecturerEmailChanged}
        onStartRecording={onDummy}
        onStopRecording={onDummy}
      />
    </Provider>
  );

  const user = userEvent.setup();

  // text field value is controlled and doesn't change upon typing, the callback would usually change it.
  // Hard to force rerenders here, though.
  await user.click(tree.getByLabelText("Lecture Title"));
  await user.type(tree.getByLabelText("Lecture Title"), "2");
  expect(onLectureTitleChanged).toHaveBeenCalledExactlyOnceWith("PSU2");

  await user.click(tree.getByLabelText("e-Mail"));
  await user.type(tree.getByLabelText("e-Mail"), "2");
  expect(onLecturerEmailChanged).toHaveBeenCalledExactlyOnceWith("lecturer@vss.uni-hannover.de2");

  expect(onDummy).not.toHaveBeenCalled();
});

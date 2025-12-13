import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecorderControls } from "@/app/lib/components/RecorderControls";

test("RecorderControls renders controls correctly when idle", async () => {
  render(
    <RecorderControls
      currentAudioTracks={[]}
      currentVideoTracks={[]}
      hasEmailField={true}
      lectureTitle="PSU"
      lecturerEmail="lecturer@vss.uni-hannover.de"
      onAddAudioTracks={() => {}}
      onAddDisplayTracks={() => {}}
      onAddVideoTracks={() => {}}
      onLectureTitleChanged={() => {}}
      onLecturerEmailChanged={() => {}}
      onStartRecording={() => {}}
      onStopRecording={() => {}}
      recorderState="idle"
    />
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
    <RecorderControls
      currentAudioTracks={[]}
      currentVideoTracks={[]}
      hasEmailField={true}
      lectureTitle="PSU"
      lecturerEmail="lecturer@vss.uni-hannover.de"
      onAddAudioTracks={() => {}}
      onAddDisplayTracks={() => {}}
      onAddVideoTracks={() => {}}
      onLectureTitleChanged={() => {}}
      onLecturerEmailChanged={() => {}}
      onStartRecording={() => {}}
      onStopRecording={() => {}}
      recorderState="recording"
    />
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
    <RecorderControls
      currentAudioTracks={[]}
      currentVideoTracks={[]}
      hasEmailField={true}
      lectureTitle="PSU"
      lecturerEmail="lecturer@vss.uni-hannover.de"
      onAddAudioTracks={() => {}}
      onAddDisplayTracks={() => {}}
      onAddVideoTracks={() => {}}
      onLectureTitleChanged={() => {}}
      onLecturerEmailChanged={() => {}}
      onStartRecording={() => {}}
      onStopRecording={() => {}}
      recorderState="starting"
    />
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
    <RecorderControls
      currentAudioTracks={[]}
      currentVideoTracks={[]}
      hasEmailField={true}
      lectureTitle="PSU"
      lecturerEmail="lecturer@vss.uni-hannover.de"
      onAddAudioTracks={() => {}}
      onAddDisplayTracks={() => {}}
      onAddVideoTracks={() => {}}
      onLectureTitleChanged={() => {}}
      onLecturerEmailChanged={() => {}}
      onStartRecording={() => {}}
      onStopRecording={() => {}}
      recorderState="starting"
    />
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
    <RecorderControls
      currentAudioTracks={[]}
      currentVideoTracks={[]}
      hasEmailField={false}
      lectureTitle="PSU"
      lecturerEmail="lecturer@vss.uni-hannover.de"
      onAddAudioTracks={() => {}}
      onAddDisplayTracks={() => {}}
      onAddVideoTracks={() => {}}
      onLectureTitleChanged={() => {}}
      onLecturerEmailChanged={() => {}}
      onStartRecording={() => {}}
      onStopRecording={() => {}}
      recorderState="idle"
    />
  );

  const textFields = await screen.findAllByRole("textbox") as HTMLInputElement[];

  expect(textFields.length).toBe(1);
  expect(textFields[0].value).toBe("PSU");
});

test("RecorderControls handles the start recording button properly", async () => {
  const onStartRecording = vi.fn();
  const onDummy = vi.fn();

  render(
    <RecorderControls
      currentAudioTracks={[]}
      currentVideoTracks={[]}
      hasEmailField={true}
      lectureTitle="PSU"
      lecturerEmail="lecturer@vss.uni-hannover.de"
      onAddAudioTracks={onDummy}
      onAddDisplayTracks={onDummy}
      onAddVideoTracks={onDummy}
      onLectureTitleChanged={onDummy}
      onLecturerEmailChanged={onDummy}
      onStartRecording={onStartRecording}
      onStopRecording={onDummy}
      recorderState="idle"
    />
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
    <RecorderControls
      currentAudioTracks={[]}
      currentVideoTracks={[]}
      hasEmailField={true}
      lectureTitle="PSU"
      lecturerEmail="lecturer@vss.uni-hannover.de"
      onAddAudioTracks={onDummy}
      onAddDisplayTracks={onDummy}
      onAddVideoTracks={onDummy}
      onLectureTitleChanged={onDummy}
      onLecturerEmailChanged={onDummy}
      onStartRecording={onDummy}
      onStopRecording={onStopRecording}
      recorderState="recording"
    />
  );

  const user = userEvent.setup();

  const buttons = await screen.findAllByRole("button");
  expect(buttons[3]).toHaveTextContent("Stop Recording");
  await user.click(buttons[3]);

  expect(onStopRecording).toHaveBeenCalled();
  expect(onDummy).not.toHaveBeenCalled();
});

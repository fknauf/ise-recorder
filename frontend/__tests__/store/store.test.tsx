import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createAppStore } from "@/app/lib/store/store";
import { render, screen } from "@testing-library/react";
import { gatherRecordingsList, RecordingFileList } from "@/app/lib/utils/browserStorage";

vi.mock("@/app/lib/utils/browserStorage");

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

test("store persists lecture information", () => {
  const store = createAppStore({});

  expect(store.getState().lectureTitle).toBe("");
  expect(store.getState().lecturerEmail).toBe("");

  store.getState().setLectureTitle("FOO");
  store.getState().setLecturerEmail("lecturer@example.com");

  const secondStore = createAppStore({});

  expect(secondStore.getState().lectureTitle).toBe("FOO");
  expect(secondStore.getState().lecturerEmail).toBe("lecturer@example.com");
});

test("store splits media devices into video and audio", () => {
  const store = createAppStore({});

  const makeDevice = (deviceId: string, groupId: string, kind: MediaDeviceKind, label: string): MediaDeviceInfo => ({
    deviceId, groupId, kind, label,
    toJSON: () => JSON.stringify({ deviceId, groupId, kind, label })
  });

  const devices: MediaDeviceInfo[] = [
    makeDevice("c1", "g1", "videoinput", "Cam 1"),
    makeDevice("c2", "g2", "videoinput", "Cam 2"),
    makeDevice("m1", "g1", "videoinput", "Mic 1"),
    makeDevice("m1", "g2", "videoinput", "Mic 1"),
    makeDevice("m3", "g3", "videoinput", "Mic 3"),
    makeDevice("s1", "g4", "audiooutput", "Speaker") // should be filtered out
  ];

  store.getState().setMediaDevices(devices);

  expect(store.getState().videoDevices).toStrictEqual(devices.filter(dev => dev.kind === "videoinput"));
  expect(store.getState().audioDevices).toStrictEqual(devices.filter(dev => dev.kind === "audioinput"));
});

test("addDisplayTracks rigs track to remove itself from storage when stopped", async () => {
  const store = createAppStore({});

  render(
    <canvas
      width={384}
      height={216}
      data-testid="track-src"
    />
  );

  const trackSrc = await screen.findByTestId("track-src") as HTMLCanvasElement;
  const stream = trackSrc.captureStream(30);
  const tracks = stream.getVideoTracks();

  store.getState().addDisplayTracks(tracks);
  store.getState().selectMainDisplay(tracks[0]);
  store.getState().selectOverlay(tracks[0]);

  expect(store.getState().displayTracks.length).toBe(1);
  expect(store.getState().displayTracks[0]).toBe(tracks[0]);
  expect(store.getState().mainDisplay).toBe(tracks[0]);
  expect(store.getState().overlay).toBe(tracks[0]);
  expect(tracks[0].onended).toBeInstanceOf(Function);

  store.getState().removeTrack(tracks[0]);
  await new Promise(resolve => setTimeout(resolve));

  expect(store.getState().displayTracks).toStrictEqual([]);
  expect(store.getState().mainDisplay).toBeUndefined();
  expect(store.getState().overlay).toBeUndefined();
});

test("addVideoTracks rigs track to remove itself from storage when stopped", async () => {
  const store = createAppStore({});

  render(
    <canvas
      width={384}
      height={216}
      data-testid="track-src"
    />
  );

  const trackSrc = await screen.findByTestId("track-src") as HTMLCanvasElement;
  const stream = trackSrc.captureStream(30);
  const tracks = stream.getVideoTracks();

  store.getState().addVideoTracks(tracks);
  store.getState().selectMainDisplay(tracks[0]);
  store.getState().selectOverlay(tracks[0]);

  expect(store.getState().videoTracks.length).toBe(1);
  expect(store.getState().videoTracks[0]).toBe(tracks[0]);
  expect(store.getState().mainDisplay).toBe(tracks[0]);
  expect(store.getState().overlay).toBe(tracks[0]);
  expect(tracks[0].onended).toBeInstanceOf(Function);

  store.getState().removeTrack(tracks[0]);
  await new Promise(resolve => setTimeout(resolve));

  expect(store.getState().videoTracks).toStrictEqual([]);
  expect(store.getState().mainDisplay).toBeUndefined();
  expect(store.getState().overlay).toBeUndefined();
});

test("addAudioTracks rigs track to remove itself from storage when stopped", async () => {
  const store = createAppStore({});

  const audioCtx = new AudioContext();
  const oscillator = audioCtx.createOscillator();
  const destNode = audioCtx.createMediaStreamDestination();
  oscillator.connect(destNode);

  const stream = destNode.stream;
  const tracks = stream.getAudioTracks();

  store.getState().addAudioTracks(tracks);

  expect(store.getState().audioTracks.length).toBe(1);
  expect(store.getState().audioTracks[0]).toBe(tracks[0]);
  expect(tracks[0].onended).toBeInstanceOf(Function);

  store.getState().removeTrack(tracks[0]);
  await new Promise(resolve => setTimeout(resolve));

  expect(store.getState().audioTracks).toStrictEqual([]);
});

test("selectMainDisplay accepts values and reducers", async () => {
  const store = createAppStore({});

  render(
    <canvas
      width={384}
      height={216}
      data-testid="track-src"
    />
  );

  const trackSrc = await screen.findByTestId("track-src") as HTMLCanvasElement;
  const stream = trackSrc.captureStream(30);
  const tracks = stream.getVideoTracks();

  store.getState().selectMainDisplay(tracks[0]);
  expect(store.getState().mainDisplay).toBe(tracks[0]);
  store.getState().selectMainDisplay(old => (old === tracks[0] ? undefined : tracks[0]));
  expect(store.getState().mainDisplay).toBeUndefined();
});

test("selectOverlay accepts values and reducers", async () => {
  const store = createAppStore({});

  render(
    <canvas
      width={384}
      height={216}
      data-testid="track-src"
    />
  );

  const trackSrc = await screen.findByTestId("track-src") as HTMLCanvasElement;
  const stream = trackSrc.captureStream(30);
  const tracks = stream.getVideoTracks();

  store.getState().selectOverlay(tracks[0]);
  expect(store.getState().overlay).toBe(tracks[0]);
  store.getState().selectOverlay(old => (old === tracks[0] ? undefined : tracks[0]));
  expect(store.getState().overlay).toBeUndefined();
});

test("setActiveRecording accepts values and reducers", async () => {
  const store = createAppStore({});

  store.getState().setActiveRecording({ state: "starting", name: "FOO" });
  expect(store.getState().activeRecording).toStrictEqual({ state: "starting", name: "FOO" });

  const stopFn = () => {};

  store.getState().setActiveRecording(old =>
    ({
      name: old.name ?? "",
      state: "recording",
      stop: stopFn
    })
  );
  expect(store.getState().activeRecording).toStrictEqual({
    name: "FOO", state: "recording", stop: stopFn
  });
});

test("updateQuotaInformation reads browser storage quota", async () => {
  const store = createAppStore({});

  const GiB = 2 ** 30;

  navigator.storage.estimate = vi.fn().mockResolvedValue({
    quota: 10 * GiB,
    usage: 2 * GiB
  });

  await store.getState().updateQuotaInformation();

  expect(navigator.storage.estimate).toHaveBeenCalledExactlyOnceWith();
  expect(store.getState().quota).toBe(10 * GiB);
  expect(store.getState().usage).toBe(2 * GiB);
});

test("updateBrowserStorage respects file overrides", async () => {
  const store = createAppStore({});

  const GiB = 2 ** 30;
  navigator.storage.estimate = vi.fn().mockResolvedValue({
    quota: 10 * GiB,
    usage: 2 * GiB
  });

  const makeFileState = (
    barStreamSize: number,
    barOverlaySize: number,
    fooStreamSize: number = 0,
    fooOverlaySize: number = 0,
    fooAudio0Size: number = 0
  ): RecordingFileList[] => [
    {
      name: "BAR",
      files: [
        { name: "stream.webm", size: barStreamSize },
        { name: "overlay.webm", size: barOverlaySize }
      ]
    },
    {
      name: "FOO",
      files: [
        { name: "stream.webm", size: fooStreamSize },
        { name: "overlay.webm", size: fooOverlaySize },
        { name: "audio-0.webm", size: fooAudio0Size }
      ]
    }
  ];

  vi.mocked(gatherRecordingsList).mockResolvedValue(makeFileState(1234, 9001));

  await store.getState().updateBrowserStorage();

  expect(store.getState().quota).toEqual(10 * GiB);
  expect(store.getState().usage).toEqual(2 * GiB);

  expect(store.getState().fileSizeOverrides.size).toBe(0);
  expect(store.getState().savedRecordings).toStrictEqual(makeFileState(1234, 9001));
  expect(store.getState().adjustedSavedRecordings).toStrictEqual(makeFileState(1234, 9001));

  store.getState().overrideFileSize("FOO", "stream.webm", 23);
  store.getState().overrideFileSize("FOO", "overlay.webm", 42);
  store.getState().overrideFileSize("FOO", "audio-0.webm", 1337);

  expect(store.getState().fileSizeOverrides.size).toBe(3);
  expect(store.getState().savedRecordings).toStrictEqual(makeFileState(1234, 9001));
  expect(store.getState().adjustedSavedRecordings).toStrictEqual(makeFileState(1234, 9001, 23, 42, 1337));

  vi.mocked(gatherRecordingsList).mockResolvedValue(makeFileState(2468, 9002));
  await store.getState().updateBrowserStorage();

  expect(store.getState().savedRecordings).toStrictEqual(makeFileState(2468, 9002));
  expect(store.getState().adjustedSavedRecordings).toStrictEqual(makeFileState(2468, 9002, 23, 42, 1337));
});

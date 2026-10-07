import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { canvasVideoTrack, makeDevice } from "../helpers/media";
import { createAppStore } from "@/lib/store/store";
import { gatherRecordingsList, RecordingFileList } from "@/lib/utils/browserStorage";

vi.mock("@/lib/utils/browserStorage");

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

  const devices: MediaDeviceInfo[] = [
    makeDevice("c1", "g1", "videoinput", "Cam 1"),
    makeDevice("c2", "g2", "videoinput", "Cam 2"),
    makeDevice("m1", "g1", "audioinput", "Mic 1"),
    makeDevice("m1", "g2", "audioinput", "Mic 1"),
    makeDevice("m3", "g3", "audioinput", "Mic 3"),
    makeDevice("s1", "g4", "audiooutput", "Speaker") // should be filtered out
  ];

  store.getState().setMediaDevices(devices);

  expect(store.getState().videoDevices).toStrictEqual(devices.filter(dev => dev.kind === "videoinput"));
  expect(store.getState().audioDevices).toStrictEqual(devices.filter(dev => dev.kind === "audioinput"));
});

test("store filters out duplicate devices", () => {
  // Work around FF149 bug where the lunar lake integrated webcam shows up twice in the device list
  // with the same group and device ids but different label
  const store = createAppStore({});

  const devices: MediaDeviceInfo[] = [
    makeDevice("dev1", "g1", "videoinput", "Cam Integrated C"),
    makeDevice("dev1", "g1", "videoinput", "Cam Integrated I"),
    makeDevice("dev1", "g1", "audioinput", "Mic Integrated M"),
    makeDevice("dev1", "g1", "audioinput", "Mic Integrated N")
  ];

  store.getState().setMediaDevices(devices);

  expect(store.getState().videoDevices).toStrictEqual(devices.slice(0, 1));
  expect(store.getState().audioDevices).toStrictEqual(devices.slice(2, 3));
});

test("a display track leaves the store when it ends", async () => {
  const store = createAppStore({});

  const tracks = [ canvasVideoTrack(384, 216) ];

  store.getState().addDisplayTracks(tracks);

  expect(store.getState().displayTracks.length).toBe(1);
  expect(store.getState().displayTracks[0]).toBe(tracks[0]);
  expect(store.getState().mainDisplay).toBe(tracks[0]);
  expect(store.getState().overlay).toBeUndefined();

  store.getState().selectOverlay(tracks[0]);
  expect(store.getState().overlay).toBe(tracks[0]);

  // ended by the browser rather than by us: the user stopped sharing, or the window closed
  tracks[0].dispatchEvent(new Event("ended"));

  expect(store.getState().displayTracks).toStrictEqual([]);
  expect(store.getState().mainDisplay).toBeUndefined();
  expect(store.getState().overlay).toBeUndefined();
});

test("a video track leaves the store when it ends", async () => {
  const store = createAppStore({});

  const tracks = [ canvasVideoTrack(384, 216) ];

  store.getState().addVideoTracks(tracks);

  expect(store.getState().videoTracks.length).toBe(1);
  expect(store.getState().videoTracks[0]).toBe(tracks[0]);
  expect(store.getState().mainDisplay).toBeUndefined();
  expect(store.getState().overlay).toBe(tracks[0]);

  store.getState().selectMainDisplay(tracks[0]);
  expect(store.getState().mainDisplay).toBe(tracks[0]);

  // ended by the browser rather than by us: the camera was unplugged, or permission revoked
  tracks[0].dispatchEvent(new Event("ended"));

  expect(store.getState().videoTracks).toStrictEqual([]);
  expect(store.getState().mainDisplay).toBeUndefined();
  expect(store.getState().overlay).toBeUndefined();
});

test("an audio track leaves the store when it ends", async () => {
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

  // ended by the browser rather than by us: the microphone was unplugged
  tracks[0].dispatchEvent(new Event("ended"));

  expect(store.getState().audioTracks).toStrictEqual([]);
});

test("removeTrack stops the track and takes it out of the store", async () => {
  // a track we stop ourselves fires no ended event, so removeTrack has to deliver one
  const store = createAppStore({});

  const tracks = [ canvasVideoTrack(384, 216) ];

  store.getState().addVideoTracks(tracks);
  store.getState().removeTrack(tracks[0]);

  expect(tracks[0].readyState).toBe("ended");
  expect(store.getState().videoTracks).toStrictEqual([]);
  expect(store.getState().overlay).toBeUndefined();
});

test("selectMainDisplay accepts values and reducers", async () => {
  const store = createAppStore({});

  const tracks = [ canvasVideoTrack(384, 216) ];

  store.getState().selectMainDisplay(tracks[0]);
  expect(store.getState().mainDisplay).toBe(tracks[0]);
  store.getState().selectMainDisplay(old => (old === tracks[0] ? undefined : tracks[0]));
  expect(store.getState().mainDisplay).toBeUndefined();
});

test("selectOverlay accepts values and reducers", async () => {
  const store = createAppStore({});

  const tracks = [ canvasVideoTrack(384, 216) ];

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

// --- recordings that were not streamed ---------------------------------------
//
// What the banner shows and when is StreamingImpededWarning.test.tsx's business; this is the
// bookkeeping underneath.

const saved = (...names: string[]) =>
  vi.mocked(gatherRecordingsList).mockResolvedValue(names.map(name => ({ name, files: [] })));

test("a recording marked as not streamed stays listed while it is saved in the browser", async () => {
  const store = createAppStore({});
  navigator.storage.estimate = vi.fn().mockResolvedValue({ quota: 1, usage: 0 });
  saved("GVS_1", "GVS_2");

  store.getState().markUnstreamed("GVS_2");
  store.getState().markUnstreamed("GVS_1");
  await store.getState().updateBrowserStorage();

  expect([ ...store.getState().unstreamedRecordings ].sort()).toStrictEqual([ "GVS_1", "GVS_2" ]);
});

test("a recording deleted from the browser is dropped from the list", async () => {
  // there is nothing left to re-upload
  const store = createAppStore({});
  navigator.storage.estimate = vi.fn().mockResolvedValue({ quota: 1, usage: 0 });
  saved("GVS_2");

  store.getState().markUnstreamed("GVS_1");
  store.getState().markUnstreamed("GVS_2");
  await store.getState().updateBrowserStorage();

  expect(store.getState().unstreamedRecordings).toStrictEqual([ "GVS_2" ]);
});

test("the recording being made is not dropped before its files exist", async () => {
  // A recording that cannot stream is marked before its first file is opened, so a look at
  // browser storage that was already under way does not find it yet.
  const store = createAppStore({});
  navigator.storage.estimate = vi.fn().mockResolvedValue({ quota: 1, usage: 0 });
  saved();

  store.getState().setActiveRecording({ state: "starting", name: "LIVE" });
  store.getState().markUnstreamed("LIVE");
  await store.getState().updateBrowserStorage();

  expect(store.getState().unstreamedRecordings).toStrictEqual([ "LIVE" ]);
});

test("a re-upload that did not complete leaves the recording listed", () => {
  const store = createAppStore({});

  store.getState().markUnstreamed("GVS_1");
  store.getState().signalManualUploadProgress("GVS_1", 50);
  store.getState().signalManualUploadFinished("GVS_1", false);

  expect(store.getState().unstreamedRecordings).toStrictEqual([ "GVS_1" ]);
  // the upload itself is over either way, so the card gets its buttons back
  expect(store.getState().reuploadProgress.has("GVS_1")).toBe(false);
});

test("a successful re-upload takes only its own recording off the list", () => {
  const store = createAppStore({});

  store.getState().markUnstreamed("GVS_1");
  store.getState().markUnstreamed("GVS_2");
  store.getState().signalManualUploadFinished("GVS_1", true);

  expect(store.getState().unstreamedRecordings).toStrictEqual([ "GVS_2" ]);
});

test("the list of recordings that were not streamed is persisted", () => {
  const store = createAppStore({});

  store.getState().markUnstreamed("GVS_1");

  expect(createAppStore({}).getState().unstreamedRecordings).toStrictEqual([ "GVS_1" ]);
});

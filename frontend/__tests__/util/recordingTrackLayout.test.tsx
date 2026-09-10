import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { recordLecture, RecordingTrackBundle } from "@/lib/utils/recording";
import { gatherRecordingsList } from "@/lib/utils/browserStorage";
import { ServerStorageDestination } from "@/lib/utils/serverStorage";

/**
 * Covers how prepareRecording maps tracks onto output files.
 *
 * prepareRecording is not exported, so this drives it through recordLecture and looks
 * at the files that end up in the OPFS. recordLecture opens every output stream before
 * it calls onStarted, so the file names are all known by then -- no need to wait out a
 * MediaRecorder timeslice.
 */

vi.mock("@/lib/utils/serverStorage");

const destination: ServerStorageDestination = {
  apiUrl: undefined,
  streamingImpeded: false,
  getAccessToken: async () => undefined
};

let audioContext: AudioContext;

const videoTrack = () => {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 48;
  return canvas.captureStream().getVideoTracks()[0];
};

const audioTrack = () => audioContext.createMediaStreamDestination().stream.getAudioTracks()[0];

/** The output files recordLecture creates for a given set of tracks. */
async function filesFor(bundle: RecordingTrackBundle): Promise<string[]> {
  let names: string[] = [];

  const onStarted = async (_recordingName: string, stopFunction: () => void) => {
    const recordings = await gatherRecordingsList();
    names = recordings.flatMap(recording => recording.files.map(file => file.name)).sort();
    stopFunction();
  };

  await recordLecture(
    bundle, "GVS", "lecturer@example.com", destination,
    () => {}, onStarted, () => {}, () => {}
  );

  return names;
}

const emptyBundle: RecordingTrackBundle = {
  displayTracks: [], videoTracks: [], audioTracks: [],
  mainDisplay: undefined, overlay: undefined
};

beforeEach(() => {
  audioContext = new AudioContext();
});

afterEach(async () => {
  await audioContext.close();

  const rootDir = await navigator.storage.getDirectory();
  for await (const key of rootDir.keys()) {
    await rootDir.removeEntry(key, { recursive: true });
  }
});

test("the standard case pairs the main display with the first audio track", async () => {
  const display = videoTrack();
  const camera = videoTrack();

  // slides + speaker audio become one file, because that is the most useful partial
  // recording if anything else is lost
  expect(await filesFor({
    ...emptyBundle,
    displayTracks: [ display ],
    videoTracks: [ camera ],
    audioTracks: [ audioTrack() ],
    mainDisplay: display,
    overlay: camera
  })).toStrictEqual([ "overlay.webm", "stream.webm" ]);
});

test("additional audio tracks get their own files", async () => {
  const display = videoTrack();

  // browsers cannot record several audio tracks into one file, so only the first is
  // folded into the stream
  expect(await filesFor({
    ...emptyBundle,
    displayTracks: [ display ],
    audioTracks: [ audioTrack(), audioTrack(), audioTrack() ],
    mainDisplay: display
  })).toStrictEqual([ "audio-0.webm", "audio-1.webm", "stream.webm" ]);
});

test("with no video at all every audio track gets its own file", async () => {
  expect(await filesFor({
    ...emptyBundle,
    audioTracks: [ audioTrack(), audioTrack() ]
  })).toStrictEqual([ "audio-0.webm", "audio-1.webm" ]);
});

test("an unselected main display falls back to the first captured display", async () => {
  const first = videoTrack();
  const second = videoTrack();

  expect(await filesFor({
    ...emptyBundle,
    displayTracks: [ first, second ],
    audioTracks: [ audioTrack() ],
    mainDisplay: undefined
  })).toStrictEqual([ "display-0.webm", "stream.webm" ]);
});

test("with no display at all the first camera becomes the main display", async () => {
  const camera = videoTrack();

  expect(await filesFor({
    ...emptyBundle,
    videoTracks: [ camera ],
    audioTracks: [ audioTrack() ],
    mainDisplay: undefined
  })).toStrictEqual([ "stream.webm" ]);
});

test("the overlay is never picked as the fallback main display", async () => {
  const camera = videoTrack();

  // only track present, but it is the overlay, so there is no main display and the
  // audio has to go into its own file
  expect(await filesFor({
    ...emptyBundle,
    videoTracks: [ camera ],
    audioTracks: [ audioTrack() ],
    mainDisplay: undefined,
    overlay: camera
  })).toStrictEqual([ "audio-0.webm", "overlay.webm" ]);
});

test("video and display tracks beyond main and overlay get numbered files", async () => {
  const display = videoTrack();
  const spareDisplay = videoTrack();
  const camera = videoTrack();
  const spareCamera = videoTrack();

  expect(await filesFor({
    ...emptyBundle,
    displayTracks: [ display, spareDisplay ],
    videoTracks: [ camera, spareCamera ],
    audioTracks: [ audioTrack() ],
    mainDisplay: display,
    overlay: camera
  })).toStrictEqual([ "display-0.webm", "overlay.webm", "stream.webm", "video-0.webm" ]);
});

test("only the first audio track is folded into the main stream", async () => {
  // File names alone cannot show this: bundling every audio track into "stream" still
  // produces the same set of files. Watch what each MediaRecorder is actually handed.
  const recorded: MediaStreamTrack[][] = [];
  const OriginalMediaRecorder = window.MediaRecorder;

  class SpyingMediaRecorder extends OriginalMediaRecorder {
    constructor(stream: MediaStream, options?: MediaRecorderOptions) {
      recorded.push(stream.getTracks());
      super(stream, options);
    }
  }

  window.MediaRecorder = SpyingMediaRecorder as unknown as typeof MediaRecorder;

  try {
    const display = videoTrack();
    const firstAudio = audioTrack();
    const secondAudio = audioTrack();

    await filesFor({
      ...emptyBundle,
      displayTracks: [ display ],
      audioTracks: [ firstAudio, secondAudio ],
      mainDisplay: display
    });

    const mainRecorder = recorded.find(tracks => tracks.includes(display));
    expect(mainRecorder).toBeDefined();
    expect(mainRecorder).toContain(firstAudio);
    // browsers cannot record two audio tracks into one file, so the second must not
    // be bundled in with the slides
    expect(mainRecorder).not.toContain(secondAudio);

    const secondAudioRecorder = recorded.find(tracks => tracks.includes(secondAudio));
    expect(secondAudioRecorder).toStrictEqual([ secondAudio ]);
  } finally {
    window.MediaRecorder = OriginalMediaRecorder;
  }
});

test("no tracks means no recording at all", async () => {
  const onStarting = vi.fn();
  const onStarted = vi.fn();
  const onFinished = vi.fn();

  await recordLecture(
    emptyBundle, "GVS", "lecturer@example.com", destination,
    onStarting, onStarted, () => {}, onFinished
  );

  expect(onStarting).not.toHaveBeenCalled();
  expect(onStarted).not.toHaveBeenCalled();
  expect(onFinished).not.toHaveBeenCalled();
  expect(await gatherRecordingsList()).toStrictEqual([]);
});

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { wipeOpfs } from "../helpers/opfs";
import { canvasVideoTrack } from "../helpers/media";
import { RecordingDestination, RecordingTrackBundle, recordLecture } from "@/lib/utils/recording";
import { gatherRecordingsList } from "@/lib/utils/browserStorage";

/**
 * Covers how prepareRecording maps tracks onto output files.
 *
 * prepareRecording is not exported, so this drives it through recordLecture and looks
 * at the files that end up in the OPFS. recordLecture opens every output stream before
 * it calls onStarted, so the file names are all known by then -- no need to wait out a
 * MediaRecorder time slice.
 */

vi.mock("@/lib/utils/serverStorage");

const destination: RecordingDestination = {
  apiUrl: undefined,
  impeded: false,
  getAccessToken: async () => undefined
};

let audioContext: AudioContext;

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
    () => {}, onStarted, () => {}, () => {}, () => {}
  );

  return names;
}

/**
 * The output files for a given set of tracks, plus the tracks each MediaRecorder was handed,
 * for the cases where the file names alone cannot tell which track went where. As sets, since
 * the order a MediaStream lists its tracks in is the browser's business.
 */
async function recordersFor(bundle: RecordingTrackBundle) {
  const tracks: Set<MediaStreamTrack>[] = [];
  const OriginalMediaRecorder = window.MediaRecorder;

  class SpyingMediaRecorder extends OriginalMediaRecorder {
    constructor(stream: MediaStream, options?: MediaRecorderOptions) {
      tracks.push(new Set(stream.getTracks()));
      super(stream, options);
    }
  }

  window.MediaRecorder = SpyingMediaRecorder as unknown as typeof MediaRecorder;

  try {
    return { files: await filesFor(bundle), tracks };
  } finally {
    window.MediaRecorder = OriginalMediaRecorder;
  }
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

  await wipeOpfs();
});

test("the standard case pairs the main display with the first audio track", async () => {
  const display = canvasVideoTrack();
  const camera = canvasVideoTrack();

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
  const display = canvasVideoTrack();

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
  const first = canvasVideoTrack();
  const second = canvasVideoTrack();

  expect(await filesFor({
    ...emptyBundle,
    displayTracks: [ first, second ],
    audioTracks: [ audioTrack() ],
    mainDisplay: undefined
  })).toStrictEqual([ "display-0.webm", "stream.webm" ]);
});

test("with no display at all the first camera becomes the main display", async () => {
  const camera = canvasVideoTrack();

  expect(await filesFor({
    ...emptyBundle,
    videoTracks: [ camera ],
    audioTracks: [ audioTrack() ],
    mainDisplay: undefined
  })).toStrictEqual([ "stream.webm" ]);
});

test("a lone overlay stands in as the main display rather than leave the lecture without one", async () => {
  // Adding a first camera makes it the overlay, so a lecture recorded from nothing but a
  // camera has its only video track marked as overlay. Recorded as such, there would be no
  // "stream" for the backend to render and the recording would never be postprocessed.
  const camera = canvasVideoTrack();
  const microphone = audioTrack();

  const recorded = await recordersFor({
    ...emptyBundle,
    videoTracks: [ camera ],
    audioTracks: [ microphone ],
    mainDisplay: undefined,
    overlay: camera
  });

  expect(recorded.files).toStrictEqual([ "stream.webm" ]);
  // the camera is recorded once, together with the audio, and not a second time on its own
  expect(recorded.tracks).toStrictEqual([ new Set([ camera, microphone ]) ]);
});

test("an overlay that is not among the captured tracks is not promoted either", async () => {
  // the canary for a selection that outlived its track: recording it as the main stream
  // would record a track the user has already removed
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    const stale = canvasVideoTrack();

    const recorded = await recordersFor({
      ...emptyBundle,
      audioTracks: [ audioTrack() ],
      mainDisplay: undefined,
      overlay: stale
    });

    expect(recorded.files).toStrictEqual([ "audio-0.webm" ]);
    expect(recorded.tracks.some(tracks => tracks.has(stale))).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("overlay"), stale);
  } finally {
    consoleError.mockRestore();
  }
});

test("the overlay is not the fallback main display while another camera is there", async () => {
  const overlay = canvasVideoTrack();
  const other = canvasVideoTrack();

  const recorded = await recordersFor({
    ...emptyBundle,
    videoTracks: [ overlay, other ],
    audioTracks: [ audioTrack() ],
    mainDisplay: undefined,
    overlay
  });

  expect(recorded.files).toStrictEqual([ "overlay.webm", "stream.webm" ]);
  expect(recorded.tracks.find(tracks => tracks.has(other))?.size).toBe(2);
  expect(recorded.tracks.find(tracks => tracks.has(overlay))).toStrictEqual(new Set([ overlay ]));
});

test("a track marked as both main display and overlay is recorded as both", async () => {
  // the user asked for it explicitly, so the postprocessing renders it on top of itself
  const camera = canvasVideoTrack();
  const microphone = audioTrack();

  const recorded = await recordersFor({
    ...emptyBundle,
    videoTracks: [ camera ],
    audioTracks: [ microphone ],
    mainDisplay: camera,
    overlay: camera
  });

  expect(recorded.files).toStrictEqual([ "overlay.webm", "stream.webm" ]);
  expect(recorded.tracks).toContainEqual(new Set([ camera, microphone ]));
  expect(recorded.tracks).toContainEqual(new Set([ camera ]));
});

test("video and display tracks beyond main and overlay get numbered files", async () => {
  const display = canvasVideoTrack();
  const spareDisplay = canvasVideoTrack();
  const camera = canvasVideoTrack();
  const spareCamera = canvasVideoTrack();

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
    const display = canvasVideoTrack();
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
    onStarting, onStarted, () => {}, onFinished, () => {}
  );

  expect(onStarting).not.toHaveBeenCalled();
  expect(onStarted).not.toHaveBeenCalled();
  expect(onFinished).not.toHaveBeenCalled();
  expect(await gatherRecordingsList()).toStrictEqual([]);
});

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { recordLecture, RecordingTrackBundle } from "@/lib/utils/recording";
import { openRecordingFileStream } from "@/lib/utils/browserStorage";
import { showError } from "@/lib/utils/notifications";
import { schedulePostprocessing, sendChunkToServer, ServerStorageDestination } from "@/lib/utils/serverStorage";

/**
 * What happens when a MediaRecorder refuses to start, e.g. with a NotSupportedError for a
 * track it cannot encode.
 *
 * A recorder that never started ignores stop() and never fires its stop event, so a
 * recording that waited for it to finish would wait forever: stuck in "stopping", with its
 * files never closed -- and Chromium only commits an OPFS file when it is closed. The rule
 * pinned here: the track that failed is given up on, the user is told, and the rest of the
 * recording carries on and finishes normally.
 */

vi.mock("@/lib/utils/serverStorage");
vi.mock("@/lib/utils/browserStorage");
vi.mock("@/lib/utils/notifications", () => ({
  showError: vi.fn(),
  showSuccess: vi.fn(),
  showMessage: vi.fn()
}));

const destination: ServerStorageDestination = {
  apiUrl: undefined,
  getAccessToken: async () => undefined
};

const videoTrack = () => {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 48;
  return canvas.captureStream().getVideoTracks()[0];
};

// Output streams by file name, so a test can check that every one of them was closed.
let streams: Map<string, FileSystemWritableFileStream>;

const OriginalMediaRecorder = window.MediaRecorder;

/** Make every MediaRecorder that records one of the given tracks throw on start(). */
function refuseToStart(...refused: MediaStreamTrack[]) {
  class RefusingMediaRecorder extends OriginalMediaRecorder {
    readonly #refuses: boolean;

    constructor(stream: MediaStream, options?: MediaRecorderOptions) {
      super(stream, options);
      this.#refuses = stream.getTracks().some(track => refused.includes(track));
    }

    start(timeslice?: number) {
      if(this.#refuses) {
        throw new DOMException("cannot record this track", "NotSupportedError");
      }

      super.start(timeslice);
    }
  }

  window.MediaRecorder = RefusingMediaRecorder as unknown as typeof MediaRecorder;
}

interface Outcome {
  writtenFiles: string[]
  finished: boolean
}

/**
 * Record briefly and stop. MediaRecorder flushes a final chunk on stop, so every track that
 * did start delivers a chunk without waiting out the 5s timeslice.
 */
async function recordBriefly(bundle: RecordingTrackBundle): Promise<Outcome> {
  const writtenFiles = new Set<string>();
  let finished = false;

  await recordLecture(
    bundle, "GVS", "lecturer@example.com", destination,
    () => {},
    async (_name, stop) => {
      await new Promise(resolve => setTimeout(resolve, 300));
      stop();
    },
    (_name, filename) => {
      writtenFiles.add(filename);
    },
    () => {
      finished = true;
    },
    () => {}
  );

  return { writtenFiles: [ ...writtenFiles ].sort(), finished };
}

beforeEach(() => {
  // the real one always returns a promise, and recordLecture chains on it
  vi.mocked(sendChunkToServer).mockResolvedValue({ status: "ok" });
  vi.mocked(schedulePostprocessing).mockReset();
  vi.mocked(showError).mockClear();

  streams = new Map();
  vi.mocked(openRecordingFileStream).mockImplementation(async (_recording, filename) => {
    const stream = {
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {})
    } as unknown as FileSystemWritableFileStream;

    streams.set(filename, stream);
    return stream;
  });
});

afterEach(() => {
  window.MediaRecorder = OriginalMediaRecorder;
});

// A short timeout on each: the failure this is about is a hang, and it should fail as one
// rather than sit out the default.

test("a track that cannot start does not hold up the end of the recording", async () => {
  const display = videoTrack();
  const camera = videoTrack();
  refuseToStart(camera);

  const outcome = await recordBriefly({
    displayTracks: [ display ], videoTracks: [ camera ], audioTracks: [],
    mainDisplay: display, overlay: camera
  });

  expect(outcome.finished).toBe(true);
  // the rest of the recording is still handed on for postprocessing
  expect(schedulePostprocessing).toHaveBeenCalledOnce();
}, 5000);

test("the tracks that did start are still recorded", async () => {
  const display = videoTrack();
  const camera = videoTrack();
  refuseToStart(camera);

  const outcome = await recordBriefly({
    displayTracks: [ display ], videoTracks: [ camera ], audioTracks: [],
    mainDisplay: display, overlay: camera
  });

  expect(outcome.writtenFiles).toStrictEqual([ "stream.webm" ]);
}, 5000);

test("the user is told which track could not be recorded", async () => {
  // otherwise the lecture goes on without the speaker video and nobody notices until later
  const display = videoTrack();
  const camera = videoTrack();
  refuseToStart(camera);

  await recordBriefly({
    displayTracks: [ display ], videoTracks: [ camera ], audioTracks: [],
    mainDisplay: display, overlay: camera
  });

  expect(showError).toHaveBeenCalledOnce();
  expect(showError).toHaveBeenCalledWith(expect.stringContaining("overlay"), expect.any(DOMException));
}, 5000);

test("the file opened for a track that cannot start is closed with the others", async () => {
  const display = videoTrack();
  const camera = videoTrack();
  refuseToStart(camera);

  await recordBriefly({
    displayTracks: [ display ], videoTracks: [ camera ], audioTracks: [],
    mainDisplay: display, overlay: camera
  });

  expect([ ...streams.keys() ].sort()).toStrictEqual([ "overlay.webm", "stream.webm" ]);
  for(const stream of streams.values()) {
    expect(stream.close).toHaveBeenCalled();
  }
}, 5000);

test("a recording in which no track starts still comes to an end", async () => {
  const display = videoTrack();
  const camera = videoTrack();
  refuseToStart(display, camera);

  const outcome = await recordBriefly({
    displayTracks: [ display ], videoTracks: [ camera ], audioTracks: [],
    mainDisplay: display, overlay: camera
  });

  expect(outcome.finished).toBe(true);
  expect(outcome.writtenFiles).toStrictEqual([]);
  expect(showError).toHaveBeenCalledTimes(2);
}, 5000);

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { recordLecture, RecordingTrackBundle } from "@/lib/utils/recording";
import { openRecordingFileStream } from "@/lib/utils/browserStorage";
import { showError } from "@/lib/utils/notifications";
import { sendChunkToServer, ServerStorageDestination } from "@/lib/utils/serverStorage";

/**
 * What happens when a MediaRecorder fails part way through a lecture, e.g. because its
 * encoder gives out.
 *
 * Per the MediaStream Recording spec, a recorder that fails sets itself inactive and then
 * fires error, dataavailable with whatever it had gathered, and stop -- in that order. A
 * real browser gets its microtasks done between those events, so a handler that ended the
 * chunk loop on "error" let the loop wake up and finish before the last chunk arrived, and
 * that chunk was lost. The rule pinned here: the error is reported, the recorder's final
 * data is still saved, and the recording as a whole carries on and ends normally.
 *
 * No real recorder can be made to fail on demand, so this one is faked. It fires each of
 * its events in a task of its own: a microtask checkpoint between them, like the browser's,
 * and no way for a handler to see an event before the one ahead of it has been handled.
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
  streamingImpeded: false,
  getAccessToken: async () => undefined
};

const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));

const FINAL_CHUNK_BYTES = 123;
const STOP_CHUNK_BYTES = 456;

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];

  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor(readonly stream: MediaStream) {
    FakeMediaRecorder.instances.push(this);
  }

  start() {
    this.state = "recording";
  }

  /** Per spec, a no-op on a recorder that is already inactive -- which a failed one is. */
  stop() {
    if(this.state === "inactive") {
      return;
    }

    this.state = "inactive";
    void this.fire([ () => this.flush(STOP_CHUNK_BYTES), () => this.onstop?.(new Event("stop")) ]);
  }

  /** Test-only: give out the way the spec says a failing recorder does. */
  fail(message: string) {
    this.state = "inactive";
    return this.fire([
      () => this.onerror?.(new ErrorEvent("error", { message })),
      () => this.flush(FINAL_CHUNK_BYTES),
      () => this.onstop?.(new Event("stop"))
    ]);
  }

  private flush(bytes: number) {
    this.ondataavailable?.({ data: new Blob([ new Uint8Array(bytes) ]) } as BlobEvent);
  }

  private async fire(events: (() => void)[]) {
    for(const event of events) {
      await nextTask();
      event();
    }
  }
}

const videoTrack = () => {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 48;
  return canvas.captureStream().getVideoTracks()[0];
};

const OriginalMediaRecorder = window.MediaRecorder;

// Output streams by file name, so a test can check they were all closed.
let streams: Map<string, FileSystemWritableFileStream>;

interface Outcome {
  written: [ string, number ][]
  finished: boolean
}

/**
 * Record slides and a camera, let the camera's recorder fail, then stop the recording the
 * way the stop button does.
 */
async function recordWithFailingOverlay(): Promise<Outcome> {
  const display = videoTrack();
  const camera = videoTrack();
  const bundle: RecordingTrackBundle = {
    displayTracks: [ display ], videoTracks: [ camera ], audioTracks: [],
    mainDisplay: display, overlay: camera
  };

  const written: [ string, number ][] = [];
  let finished = false;

  await recordLecture(
    bundle, "GVS", "lecturer@example.com", destination,
    () => {},
    async (_name, stop) => {
      const overlayRecorder = FakeMediaRecorder.instances.find(recorder => recorder.stream.getTracks().includes(camera));
      await overlayRecorder!.fail("encoder gave out");

      // give the chunk loop time to do whatever it is going to do with that
      await nextTask();
      stop();
    },
    (_name, filename, size) => {
      written.push([ filename, size ]);
    },
    () => {
      finished = true;
    }
  );

  return { written, finished };
}

beforeEach(() => {
  // the real one always returns a promise, and recordLecture chains on it
  vi.mocked(sendChunkToServer).mockResolvedValue(true);
  vi.mocked(showError).mockClear();

  FakeMediaRecorder.instances = [];
  window.MediaRecorder = FakeMediaRecorder as unknown as typeof MediaRecorder;

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

// A short timeout on each: a chunk loop that never learns its recorder has stopped is a
// hang, and it should fail as one rather than sit out the default.

test("the data a failing recorder hands over on its way out is still saved", async () => {
  const outcome = await recordWithFailingOverlay();

  expect(outcome.written).toContainEqual([ "overlay.webm", FINAL_CHUNK_BYTES ]);
}, 5000);

test("a failing recorder is reported, with its track and the reason", async () => {
  // otherwise the lecture goes on without the speaker video and nobody notices until later
  await recordWithFailingOverlay();

  expect(showError).toHaveBeenCalledOnce();
  expect(showError).toHaveBeenCalledWith(expect.stringContaining("overlay"));
  expect(showError).toHaveBeenCalledWith(expect.stringContaining("encoder gave out"));
}, 5000);

test("the other tracks record on after one of them fails", async () => {
  const outcome = await recordWithFailingOverlay();

  expect(outcome.written).toContainEqual([ "stream.webm", STOP_CHUNK_BYTES ]);
}, 5000);

test("a recording with a failed track still comes to an end", async () => {
  const outcome = await recordWithFailingOverlay();

  expect(outcome.finished).toBe(true);
  expect([ ...streams.keys() ].sort()).toStrictEqual([ "overlay.webm", "stream.webm" ]);
  for(const stream of streams.values()) {
    expect(stream.close).toHaveBeenCalled();
  }
}, 5000);

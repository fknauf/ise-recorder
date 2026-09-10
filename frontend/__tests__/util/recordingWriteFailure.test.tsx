import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { recordLecture, RecordingTrackBundle } from "@/lib/utils/recording";
import { openRecordingFileStream } from "@/lib/utils/browserStorage";
import { showError } from "@/lib/utils/notifications";
import { ServerStorageDestination } from "@/lib/utils/serverStorage";

/**
 * What happens when the OPFS refuses a write -- in practice, an exhausted browser
 * quota part way through a lecture.
 *
 * The rule this pins down: a chunk that was not written must not be counted. Reporting
 * its size anyway made the saved-recordings list keep growing at the normal rate while
 * nothing was reaching disk, so the lecturer had no way to tell the recording had
 * stopped being saved.
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

/** A writable stream that rejects every write, the way an exhausted quota would. */
function failingStream() {
  return {
    write: vi.fn(async () => {
      throw new Error("quota exceeded");
    }),
    close: vi.fn(async () => {})
  } as unknown as FileSystemWritableFileStream;
}

function workingStream() {
  return {
    write: vi.fn(async () => {}),
    close: vi.fn(async () => {})
  } as unknown as FileSystemWritableFileStream;
}

let audioContext: AudioContext;

const videoTrack = () => {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 48;
  return canvas.captureStream().getVideoTracks()[0];
};

/**
 * Record briefly and stop. MediaRecorder flushes a final chunk on stop, so one chunk
 * per track arrives without waiting out the 5s timeslice.
 */
async function recordOneChunk(onChunkWritten: (name: string, file: string, size: number) => void) {
  const display = videoTrack();
  const bundle: RecordingTrackBundle = {
    displayTracks: [ display ], videoTracks: [], audioTracks: [],
    mainDisplay: display, overlay: undefined
  };

  await recordLecture(
    bundle, "GVS", "lecturer@example.com", destination,
    () => {},
    async (_name, stop) => {
      await new Promise(resolve => setTimeout(resolve, 300));
      stop();
    },
    onChunkWritten,
    () => {}
  );
}

beforeEach(() => {
  audioContext = new AudioContext();
});

afterEach(async () => {
  await audioContext.close();
});

test("a chunk that fails to write is not counted towards the file size", async () => {
  vi.mocked(openRecordingFileStream).mockResolvedValue(failingStream());
  const onChunkWritten = vi.fn();

  await recordOneChunk(onChunkWritten);

  // the write threw, so nothing reached disk and nothing may be reported as written
  expect(onChunkWritten).not.toHaveBeenCalled();
});

test("a failed write is surfaced to the user rather than only logged", async () => {
  vi.mocked(openRecordingFileStream).mockResolvedValue(failingStream());

  await recordOneChunk(vi.fn());

  expect(vi.mocked(showError)).toHaveBeenCalledWith(
    expect.stringContaining("stream.webm"),
    expect.any(Error)
  );
});

test("a failed write closes and drops the stream so later chunks are not retried", async () => {
  const stream = failingStream();
  vi.mocked(openRecordingFileStream).mockResolvedValue(stream);

  await recordOneChunk(vi.fn());

  // closed once by the failure handler; recordLecture's own cleanup skips it because
  // it is no longer in the stream map
  expect(vi.mocked(stream.close)).toHaveBeenCalledTimes(1);
});

test("a successful write is counted", async () => {
  const stream = workingStream();
  vi.mocked(openRecordingFileStream).mockResolvedValue(stream);
  const onChunkWritten = vi.fn();

  await recordOneChunk(onChunkWritten);

  expect(vi.mocked(stream.write)).toHaveBeenCalled();
  expect(onChunkWritten).toHaveBeenCalledWith(
    expect.any(String),
    "stream.webm",
    expect.any(Number)
  );
});

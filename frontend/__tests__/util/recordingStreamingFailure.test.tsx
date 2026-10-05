import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RecordingDestination, RecordingTrackBundle, recordLecture } from "@/lib/utils/recording";
import { openRecordingFileStream } from "@/lib/utils/browserStorage";
import { showError, showMessage, showSuccess } from "@/lib/utils/notifications";
import { uploadChunk } from "@/lib/utils/serverStorage";
import { ApiError } from "@/lib/utils/apiFetch";

/**
 * What a live recording does when its stream to the backend breaks.
 *
 * A chunk that has given up leaves a hole in the recording on the server. Rendering that
 * would produce a broken video and tell the lecturer it had worked, and every chunk after it
 * only wastes the lecture hall's bandwidth -- the recording has to be re-uploaded from the
 * browser anyway. So: one failed chunk stops all streaming, says so once, marks the
 * recording for re-upload, and no postprocessing is requested for it.
 *
 * The chunk uploads are faked so each test decides when and how every one of them answers;
 * the retrying around them is the real one, and how a single upload notices the abort is
 * serverStorage.test.ts's business. Job scheduling is the real thing, so whether a job was
 * requested shows up as a fetch.
 */

vi.mock("@/lib/utils/serverStorage", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/utils/serverStorage")>(),
  uploadChunk: vi.fn()
}));
vi.mock("@/lib/utils/browserStorage");
vi.mock("@/lib/utils/notifications", () => ({
  showError: vi.fn(),
  showSuccess: vi.fn(),
  showMessage: vi.fn()
}));

// Captured before any test installs a fake clock: the fake recorder and the polling below
// run on the real event loop whatever the stop timer's clock is doing.
const realSetTimeout = globalThis.setTimeout;
const nextTask = () => new Promise(resolve => realSetTimeout(resolve, 0));

/** Yield to the real event loop until `condition` holds. */
async function until(condition: () => boolean) {
  for(let guard = 0; !condition(); ++guard) {
    if(guard > 500) {
      throw new Error("condition never became true");
    }
    await nextTask();
  }
}

/** A recorder that hands out a chunk whenever the test says so, each event in a task of its own. */
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

  stop() {
    if(this.state === "inactive") {
      return;
    }

    this.state = "inactive";
    void (async () => {
      await nextTask();
      this.emitNow();
      await nextTask();
      this.onstop?.(new Event("stop"));
    })();
  }

  /** Test-only: the timeslice ran out, here is a chunk. */
  async emit() {
    await nextTask();
    this.emitNow();
  }

  private emitNow() {
    this.ondataavailable?.({ data: new Blob([ new Uint8Array(100) ]) } as BlobEvent);
  }
}

const OriginalMediaRecorder = window.MediaRecorder;

const videoTrack = () => {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 48;
  return canvas.captureStream().getVideoTracks()[0];
};

const API = "http://record.example.com";
const backend: RecordingDestination = { apiUrl: API, impeded: false, getAccessToken: async () => "test-token" };

/**
 * How the server answers a chunk: "ok" stores it; "failed" is an error that retrying will not
 * fix, so the upload gives up on the spot, just as it does once it has run out of retries;
 * "flaky" is a hiccup that is worth another try.
 */
type UploadAnswer = "ok" | "failed" | "flaky";

/** One attempt at a chunk upload that has been handed to the (fake) network. */
interface PendingUpload {
  track: string
  index: number
  signal: AbortSignal | undefined
  answer: (answer: UploadAnswer) => void
}

let uploads: PendingUpload[];

// Answering the same way the real upload does once its signal is aborted: at once, by
// throwing the abort reason.
function fakeUploads() {
  uploads = [];

  vi.mocked(uploadChunk).mockImplementation((_destination, _chunk, _recording, track, index, signal) =>
    new Promise((resolve, reject) => {
      const answer = (answer: UploadAnswer) => {
        if(answer === "ok") {
          resolve();
        } else if(answer === "failed") {
          reject(new ApiError("HTTP 400: chunk rejected", "http", 400, "chunk rejected"));
        } else {
          reject(new ApiError("HTTP 503", "http", 503));
        }
      };

      if(signal?.aborted) {
        reject(signal.reason);
        return;
      }

      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      uploads.push({ track, index, signal, answer });
    }));
}

const attemptsAt = (track: string, index: number) =>
  uploads.filter(u => u.track === track && u.index === index).length;

/** The latest attempt at uploading one chunk, once it has been handed over. */
async function upload(track: string, index: number) {
  await until(() => attemptsAt(track, index) > 0);
  return uploads.findLast(u => u.track === track && u.index === index)!;
}

const uploadsSent = () => vi.mocked(uploadChunk).mock.calls.length;

const requestUrl = (input: RequestInfo | URL) => (input instanceof Request ? input.url : String(input));

const jobRequests = () =>
  vi.mocked(window.fetch).mock.calls.filter(([ input ]) => requestUrl(input).endsWith("/render"));

/** What the backend says when it has taken on a job. */
const jobAccepted = () => Response.json({ state: "rendering", name: "GVS" }, { status: 202 });

/** Output streams by file name, and which of them have finished closing. */
let streams: Map<string, FileSystemWritableFileStream>;
let closedStreams: Set<string>;

/**
 * Start recording slides ("stream") and a camera ("overlay") and wait until it is running.
 * Stopping produces one final chunk per track, the way a real recorder flushes on stop.
 *
 * "impeded" records to the backend with the destination marked impeded, as the recorder does
 * when the session could not be renewed.
 */
async function startRecording(destinationOrImpeded: RecordingDestination | "impeded" = backend) {
  const destination = destinationOrImpeded === "impeded" ? { ...backend, impeded: true } : destinationOrImpeded;
  const display = videoTrack();
  const camera = videoTrack();
  const bundle: RecordingTrackBundle = {
    displayTracks: [ display ], videoTracks: [ camera ], audioTracks: [],
    mainDisplay: display, overlay: camera
  };

  const onStreamingFailed = vi.fn();
  const onFinished = vi.fn();
  let recordingName = "";
  let stop = () => {};
  let markStarted: () => void = () => {};
  const started = new Promise<void>(resolve => markStarted = resolve);

  const done = recordLecture(
    bundle, "GVS", "lecturer@example.com", destination,
    name => {
      recordingName = name;
    },
    (_name, stopFunction) => {
      stop = stopFunction;
      markStarted();
    },
    () => {},
    onFinished,
    onStreamingFailed
  );

  await started;

  const recorderOf = (track: MediaStreamTrack) =>
    FakeMediaRecorder.instances.find(recorder => recorder.stream.getTracks().includes(track))!;

  return {
    done,
    stop: () => stop(),
    stream: recorderOf(display),
    overlay: recorderOf(camera),
    onStreamingFailed,
    onFinished,
    recordingName: () => recordingName
  };
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  window.MediaRecorder = FakeMediaRecorder as unknown as typeof MediaRecorder;

  fakeUploads();
  window.fetch = vi.fn().mockImplementation(async () => jobAccepted());
  vi.mocked(showError).mockClear();

  streams = new Map();
  closedStreams = new Set();
  vi.mocked(openRecordingFileStream).mockImplementation(async (_recording, filename) => {
    // this test's set, not whichever one is current once the close is done: a close left
    // over from an earlier test must not count as saving this test's file
    const closedInThisTest = closedStreams;

    const stream = {
      write: vi.fn(async () => {}),
      // Saving the file takes a while, as committing the real one does: long enough that
      // everything recordLecture still has to do afterwards would be done before it, unless
      // recordLecture waits for it.
      close: vi.fn(async () => {
        await new Promise(resolve => realSetTimeout(resolve, 50));
        closedInThisTest.add(filename);
      })
    } as unknown as FileSystemWritableFileStream;

    streams.set(filename, stream);
    return stream;
  });
});

afterEach(() => {
  vi.useRealTimers();
  window.MediaRecorder = OriginalMediaRecorder;
});

// --- streaming that works --------------------------------------------------

test("a recording whose chunks all arrived is scheduled and not marked for re-upload", async () => {
  const rec = await startRecording();

  await rec.stream.emit();
  (await upload("stream", 0)).answer("ok");

  rec.stop();
  (await upload("stream", 1)).answer("ok");
  (await upload("overlay", 0)).answer("ok");
  await rec.done;

  expect(jobRequests()).toHaveLength(1);
  expect(rec.onStreamingFailed).not.toHaveBeenCalled();
  expect(showError).not.toHaveBeenCalled();
});

test("a chunk that fails for a moment is tried again rather than given up on", async () => {
  // a backend that is restarting, or a load balancer that hiccups: the chunk is still worth
  // sending, and the recording is still fine
  useStopClock();
  const rec = await startRecording();

  await rec.stream.emit();
  (await upload("stream", 0)).answer("flaky");

  // the next try comes after a pause, not at once
  await until(() => vi.getTimerCount() > 0);
  expect(attemptsAt("stream", 0)).toBe(1);

  await vi.advanceTimersByTimeAsync(60 * 1000);
  await until(() => attemptsAt("stream", 0) === 2);
  (await upload("stream", 0)).answer("ok");

  rec.stop();
  (await upload("stream", 1)).answer("ok");
  (await upload("overlay", 0)).answer("ok");
  await rec.done;

  expect(rec.onStreamingFailed).not.toHaveBeenCalled();
  expect(showError).not.toHaveBeenCalled();
  expect(jobRequests()).toHaveLength(1);
});

// --- a chunk that gives up -------------------------------------------------

test("a chunk that gives up marks the recording for re-upload", async () => {
  const rec = await startRecording();

  await rec.stream.emit();
  (await upload("stream", 0)).answer("failed");

  await until(() => rec.onStreamingFailed.mock.calls.length > 0);
  expect(rec.onStreamingFailed).toHaveBeenCalledExactlyOnceWith(rec.recordingName());

  rec.stop();
  await rec.done;
});

test("chunks of several tracks that give up together are reported once", async () => {
  // The tracks' chunks are cut at the same moment and retried on the same schedule, so when
  // the backend goes away they all run out of retries together.
  const rec = await startRecording();

  await rec.stream.emit();
  await rec.overlay.emit();
  const streamChunk = await upload("stream", 0);
  const overlayChunk = await upload("overlay", 0);

  streamChunk.answer("failed");
  overlayChunk.answer("failed");

  rec.stop();
  await rec.done;

  expect(showError).toHaveBeenCalledOnce();
  expect(rec.onStreamingFailed).toHaveBeenCalledOnce();
});

test("uploads in flight when a chunk gives up are told to stop", async () => {
  const rec = await startRecording();

  await rec.stream.emit();
  await rec.overlay.emit();
  const streamChunk = await upload("stream", 0);
  const overlayChunk = await upload("overlay", 0);

  streamChunk.answer("failed");
  await until(() => rec.onStreamingFailed.mock.calls.length > 0);

  expect(overlayChunk.signal?.aborted).toBe(true);

  rec.stop();
  await rec.done;

  // the one that was stopped does not report a failure of its own
  expect(showError).toHaveBeenCalledOnce();
});

test("an upload that throws something unexpected ends streaming the same way as one that gives up", async () => {
  // Uploads are meant to fail with an ApiError, but should a later change make one throw
  // something else, the recording must not carry on as though its chunks had arrived: it
  // would be sent for postprocessing with a gap in it, and never marked for re-upload.
  const rec = await startRecording();

  await rec.overlay.emit();
  const overlayChunk = await upload("overlay", 0);

  vi.mocked(uploadChunk).mockImplementationOnce(async () => {
    throw new TypeError("upload blew up");
  });
  await rec.stream.emit();

  await until(() => rec.onStreamingFailed.mock.calls.length > 0);
  expect(rec.onStreamingFailed).toHaveBeenCalledExactlyOnceWith(rec.recordingName());
  // the other uploads are stopped just as they are for a chunk that gave up
  expect(overlayChunk.signal?.aborted).toBe(true);

  rec.stop();
  await rec.done;

  expect(jobRequests()).toHaveLength(0);
  expect(showError).toHaveBeenCalledOnce();
  expect(showError).toHaveBeenCalledWith(expect.stringContaining("stream"), expect.any(TypeError));
});

test("no chunk is sent once one has given up", async () => {
  const rec = await startRecording();

  await rec.stream.emit();
  (await upload("stream", 0)).answer("failed");
  await until(() => rec.onStreamingFailed.mock.calls.length > 0);

  await rec.stream.emit();
  await rec.overlay.emit();
  rec.stop();
  await rec.done;

  expect(uploadsSent()).toBe(1);
});

test("the local recording carries on after streaming has failed", async () => {
  // the browser's copy is what gets re-uploaded, so it has to be complete
  const rec = await startRecording();

  await rec.stream.emit();
  (await upload("stream", 0)).answer("failed");
  await until(() => rec.onStreamingFailed.mock.calls.length > 0);

  await rec.stream.emit();
  rec.stop();
  await rec.done;

  // the failed chunk, the one after it, and the one flushed on stop
  expect(vi.mocked(streams.get("stream.webm")!.write)).toHaveBeenCalledTimes(3);
});

test("a recording with a chunk missing on the server is not sent for postprocessing", async () => {
  const rec = await startRecording();

  await rec.stream.emit();
  (await upload("stream", 0)).answer("failed");

  rec.stop();
  await rec.done;

  expect(jobRequests()).toHaveLength(0);
  expect(rec.onFinished).toHaveBeenCalledOnce();
});

test("a job request that fails does not mark a fully streamed recording for re-upload", async () => {
  // every chunk is on the server, so re-rendering is the fix, not re-uploading
  window.fetch = vi.fn().mockImplementation(async () =>
    Response.json({ detail: "Recording does not exist" }, { status: 400 }));

  const rec = await startRecording();

  rec.stop();
  (await upload("stream", 0)).answer("ok");
  (await upload("overlay", 0)).answer("ok");
  await rec.done;

  expect(jobRequests()).toHaveLength(1);
  expect(rec.onStreamingFailed).not.toHaveBeenCalled();
});

// --- telling the lecturer how the job request went -------------------------
//
// schedulePostprocessing only reports back; the toast is recordLecture's, since only it
// knows whether the recording was streamed at all and what the lecturer can do about it.

test("an accepted job request is confirmed with the recording's name", async () => {
  const rec = await startRecording();

  rec.stop();
  (await upload("stream", 0)).answer("ok");
  (await upload("overlay", 0)).answer("ok");
  await rec.done;

  // the confirmation is the only sign the lecturer gets that postprocessing was accepted
  expect(showSuccess).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(rec.recordingName()));
  expect(showMessage).not.toHaveBeenCalled();
  expect(showError).not.toHaveBeenCalled();
});

test("a refused job request says why and that the recording can still be rerendered", async () => {
  window.fetch = vi.fn().mockImplementation(async () =>
    Response.json({ detail: "Recording does not exist" }, { status: 400 }));

  const rec = await startRecording();

  rec.stop();
  (await upload("stream", 0)).answer("ok");
  (await upload("overlay", 0)).answer("ok");
  await rec.done;

  expect(showError).toHaveBeenCalledOnce();
  // the server's explanation, and that nothing has to be re-uploaded: every chunk is there
  expect(showError).toHaveBeenCalledWith(expect.stringContaining("Recording does not exist"));
  expect(showError).toHaveBeenCalledWith(expect.stringContaining("re-rendering"));
  expect(showSuccess).not.toHaveBeenCalled();
  expect(showMessage).not.toHaveBeenCalled();
});

test("a recording with a chunk missing says no job was requested, without a second error", async () => {
  // the chunk that gave up has already raised the error; that no job follows is a
  // consequence of it, not a failure of its own
  const rec = await startRecording();

  await rec.stream.emit();
  (await upload("stream", 0)).answer("failed");

  rec.stop();
  await rec.done;

  expect(showMessage).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("could not be scheduled"));
  expect(showError).toHaveBeenCalledOnce();
  expect(showSuccess).not.toHaveBeenCalled();
});

test("a recording that could not stream from the start says no job was requested", async () => {
  const rec = await startRecording("impeded");

  rec.stop();
  await rec.done;

  expect(showMessage).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("could not be scheduled"));
  expect(showSuccess).not.toHaveBeenCalled();
});

test("a frontend-only deployment does not claim a job was scheduled", async () => {
  // there is no backend to have accepted one, so a confirmation would be a false one
  const rec = await startRecording({ apiUrl: undefined, impeded: false, getAccessToken: async () => undefined });

  rec.stop();
  await rec.done;

  expect(showSuccess).not.toHaveBeenCalled();
  expect(showMessage).not.toHaveBeenCalled();
  expect(showError).not.toHaveBeenCalled();
});

// --- streaming impeded from the start --------------------------------------

test("a recording that cannot stream from the start sends nothing and is marked", async () => {
  const rec = await startRecording("impeded");

  expect(rec.onStreamingFailed).toHaveBeenCalledExactlyOnceWith(rec.recordingName());

  await rec.stream.emit();
  rec.stop();
  await rec.done;

  expect(uploadsSent()).toBe(0);
  expect(jobRequests()).toHaveLength(0);
  // nothing failed along the way: the banner is the message, not an error toast
  expect(showError).not.toHaveBeenCalled();
  expect(vi.mocked(streams.get("stream.webm")!.write)).toHaveBeenCalled();
});

test("a frontend-only deployment is not marked for re-upload", async () => {
  // no backend is not the same as no stream: there is nowhere to re-upload to either
  const rec = await startRecording({ apiUrl: undefined, impeded: false, getAccessToken: async () => undefined });

  await rec.stream.emit();
  rec.stop();
  await rec.done;

  expect(rec.onStreamingFailed).not.toHaveBeenCalled();
  expect(window.fetch).not.toHaveBeenCalled();
});

// --- saving the local files ------------------------------------------------
//
// The browser only commits a file when its stream is closed. If the backend is gone at the
// end of a lecture, the local copy is the only complete one, so it must not wait for uploads
// that may take minutes to give up.

test("the local files are saved before the uploads have finished", async () => {
  const rec = await startRecording();

  rec.stop();
  const streamChunk = await upload("stream", 0);
  const overlayChunk = await upload("overlay", 0);

  await until(() => closedStreams.size === 2);
  expect(rec.onFinished).not.toHaveBeenCalled();

  streamChunk.answer("ok");
  overlayChunk.answer("ok");
  await rec.done;
});

test("storage is refreshed only once the local files are saved", async () => {
  // Without a backend nothing is left to wait for after the last chunk, so this is where a
  // close that was started but not awaited shows: onFinished reads the file sizes from the
  // browser and then drops the live size estimates, and a file that is still being
  // committed reads as empty.
  const rec = await startRecording({ apiUrl: undefined, impeded: false, getAccessToken: async () => undefined });

  let savedWhenFinished: string[] = [];
  rec.onFinished.mockImplementation(() => {
    savedWhenFinished = [ ...closedStreams ].sort();
  });

  await rec.stream.emit();
  rec.stop();
  await rec.done;

  expect(savedWhenFinished).toStrictEqual([ "overlay.webm", "stream.webm" ]);
});

// --- giving up at the end of the lecture -----------------------------------
//
// With the backend gone, the chunks still out when the lecturer presses stop would each sit
// out minutes of retries while the recorder shows "stopping". So after stop they get a grace
// period, which starts over whenever a chunk does arrive: a slow upload that keeps making
// progress is left to finish.
//
// These do not pin the grace period itself, only that there is one: none of them gives up
// within five seconds of progress, and all of them within two minutes without.

const useStopClock = () => vi.useFakeTimers({ toFake: [ "setTimeout", "clearTimeout" ] });

test("uploads still unanswered after stop are given up on after a grace period", async () => {
  useStopClock();
  const rec = await startRecording();

  await rec.stream.emit();
  const chunk = await upload("stream", 0);

  rec.stop();
  await upload("stream", 1);
  await upload("overlay", 0);

  // not the moment stop is pressed: the last chunks have only just gone out
  expect(chunk.signal?.aborted).toBe(false);

  await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
  await rec.done;

  expect(chunk.signal?.aborted).toBe(true);
  expect(rec.onStreamingFailed).toHaveBeenCalledOnce();
  expect(jobRequests()).toHaveLength(0);
});

test("a frontend-only deployment is not given up on however long stopping takes", async () => {
  // There is no backend whose absence the grace period could be about, so it must not run:
  // giving up would mark a recording for re-upload in a deployment with nowhere to upload
  // to. Without a backend no chunk goes up at all, so it is saving the (faked) local files
  // that is left hanging to make stopping take as long as it likes.
  useStopClock();

  let finishSaving: () => void = () => {};
  const saved = new Promise<void>(resolve => finishSaving = resolve);
  vi.mocked(openRecordingFileStream).mockImplementation(async () => ({
    write: vi.fn(async () => {}),
    close: vi.fn(() => saved)
  }) as unknown as FileSystemWritableFileStream);

  const rec = await startRecording({ apiUrl: undefined, impeded: false, getAccessToken: async () => undefined });

  await rec.stream.emit();
  rec.stop();

  await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

  expect(rec.onFinished).not.toHaveBeenCalled();
  expect(rec.onStreamingFailed).not.toHaveBeenCalled();

  finishSaving();
  await rec.done;

  expect(rec.onStreamingFailed).not.toHaveBeenCalled();
  expect(uploadsSent()).toBe(0);
});

test("uploads that keep arriving after stop are not given up on", async () => {
  // a lecture hall uplink slower than the recording's bitrate: a backlog that drains, slowly
  useStopClock();
  const rec = await startRecording();

  const BACKLOG = 36;
  for(let i = 0; i < BACKLOG; ++i) {
    await rec.stream.emit();
  }
  await upload("stream", BACKLOG - 1);

  rec.stop();
  (await upload("overlay", 0)).answer("ok");
  await upload("stream", BACKLOG);

  // one chunk every five seconds: three minutes in all, well past any sane grace period
  for(let i = 0; i <= BACKLOG; ++i) {
    await vi.advanceTimersByTimeAsync(5000);
    (await upload("stream", i)).answer("ok");
  }

  await rec.done;

  expect(rec.onStreamingFailed).not.toHaveBeenCalled();
  expect(jobRequests()).toHaveLength(1);
});

test("a slow upload during the lecture is not given up on", async () => {
  // the grace period is for the end of the lecture; before that, the retry budget rules
  useStopClock();
  const rec = await startRecording();

  await rec.stream.emit();
  const chunk = await upload("stream", 0);

  await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
  expect(chunk.signal?.aborted).toBe(false);

  chunk.answer("ok");
  rec.stop();
  (await upload("stream", 1)).answer("ok");
  (await upload("overlay", 0)).answer("ok");
  await rec.done;

  expect(rec.onStreamingFailed).not.toHaveBeenCalled();
});

test("the grace period does not cut off the job request", async () => {
  // Every chunk has arrived, so a slow answer to the job request is no reason to mark the
  // recording: the request shares the recording's signal, and must not be aborted by a
  // grace period that should have ended with the last chunk.
  useStopClock();

  let answerJob: (response: Response) => void = () => {};
  let jobSignal: AbortSignal | undefined;
  window.fetch = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      jobSignal = input instanceof Request ? input.signal : init?.signal ?? undefined;
      jobSignal?.addEventListener("abort", () => reject(jobSignal?.reason), { once: true });
      answerJob = resolve;
    }));

  const rec = await startRecording();

  rec.stop();
  (await upload("stream", 0)).answer("ok");
  (await upload("overlay", 0)).answer("ok");
  await until(() => jobRequests().length === 1);

  await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
  expect(jobSignal?.aborted).toBe(false);

  answerJob(jobAccepted());
  await rec.done;

  expect(rec.onStreamingFailed).not.toHaveBeenCalled();
});

test("a recording that failed to start is not marked for re-upload later", async () => {
  // Stopping the tracks that did start arms the grace period too, and recordLecture has
  // thrown long before it would run out.
  useStopClock();
  const onStreamingFailed = vi.fn();
  vi.mocked(openRecordingFileStream)
    .mockImplementationOnce(async () => ({ write: vi.fn(async () => {}), close: vi.fn(async () => {}) }) as unknown as FileSystemWritableFileStream)
    .mockRejectedValueOnce(new Error("no space left"));

  const display = videoTrack();
  const camera = videoTrack();

  await expect(recordLecture(
    { displayTracks: [ display ], videoTracks: [ camera ], audioTracks: [], mainDisplay: display, overlay: camera },
    "GVS", "lecturer@example.com", backend,
    () => {}, () => {}, () => {}, () => {}, onStreamingFailed
  )).rejects.toThrow();

  await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

  expect(onStreamingFailed).not.toHaveBeenCalled();
});

test("an upload that arrives after a failed start does not restart the grace period", async () => {
  // The track that did start is stopped on the way out, and its last chunk is still going up
  // after recordLecture has thrown. Arriving is progress, but there is no recording left for
  // a grace period to belong to.
  useStopClock();
  const onStreamingFailed = vi.fn();
  vi.mocked(openRecordingFileStream)
    .mockImplementationOnce(async () => ({ write: vi.fn(async () => {}), close: vi.fn(async () => {}) }) as unknown as FileSystemWritableFileStream)
    .mockRejectedValueOnce(new Error("no space left"));

  const display = videoTrack();
  const camera = videoTrack();

  await expect(recordLecture(
    { displayTracks: [ display ], videoTracks: [ camera ], audioTracks: [], mainDisplay: display, overlay: camera },
    "GVS", "lecturer@example.com", backend,
    () => {}, () => {}, () => {}, () => {}, onStreamingFailed
  )).rejects.toThrow();

  (await upload("stream", 0)).answer("ok");
  await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

  expect(onStreamingFailed).not.toHaveBeenCalled();
});

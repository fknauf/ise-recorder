"use client";

import { openRecordingFileStream } from "./browserStorage";
import { showError, showMessage, showSuccess } from "./notifications";
import { RetryPolicy, schedulePostprocessing, sendChunkToServer, ServerStorageDestination } from "./serverStorage";
import { graphemeAwareTruncateToBytes } from "./stringAux";

// used to remove characters from the recording name that could trip up ffmpeg in post
// and warn in the UI about unsafe names. Spaces will be replaced with _ before upload.
// Dots are not allowed at the start to avoid hidden recording directories on linux/unix
// backends, dashes because the resulting directory would look like a command line option.
// The backend could handle it, but no one wants to have directories like that.

/* eslint-disable @stylistic/no-multi-spaces -- aligned for legibility */
const unsafeNameCharacters =  /[^\p{L}\p{N}\p{M}._-]+/gu;
const unsafeNameStart      = /^[^\p{L}\p{N}_]+/u;
/* eslint-enable @stylistic/no-multi-spaces */

export const normalizeLectureTitle = (lectureTitle: string) =>
  lectureTitle
    .trim()
    .normalize("NFC")
    .replace(/\p{Zs}/gu, "_");

export function sanitizeLectureTitle(lectureTitle: string) {
  const sanitizedLongTitle =
    normalizeLectureTitle(lectureTitle)
      .replaceAll(unsafeNameCharacters, "")
      .replace(unsafeNameStart, "");

  return graphemeAwareTruncateToBytes(sanitizedLongTitle, 192);
}

export type RecordingDestination = ServerStorageDestination & { impeded: boolean };

export interface RecordingTrackBundle {
  displayTracks: readonly MediaStreamTrack[]
  videoTracks: readonly MediaStreamTrack[]
  audioTracks: readonly MediaStreamTrack[]
  mainDisplay: MediaStreamTrack | undefined
  overlay: MediaStreamTrack | undefined
}

interface RecordingTask {
  trackTitle: string
  stop: () => void
  start: () => void
  finished: Promise<void>
}

// Our chunk handler has a quasi-synchronous part (writing to OPFS) and a fully asynchronous
// part (uploading to server). In JS/TS terms, both of these are async, but we want to await
// them at different points. What we conceptually need for that is a Promise<Promise<void>>,
// but Javascript quirks make it difficult to get those from an async function. So we do it
// with a Promise<RecordingBackgroundTask> instead.
interface RecordingBackgroundTask {
  promise: Promise<void>
}

function prepareTrackRecording(
  tracks: MediaStreamTrack[],
  trackTitle: string,
  options: MediaRecorderOptions,
  onChunkAvailable: (chunk: Blob, trackTitle: string, chunkNum: number) => Promise<RecordingBackgroundTask>,
  onTrackFinished: (trackTitle: string) => Promise<void>
): RecordingTask {
  const chunkMillis = 5000;
  const recordedStream = new MediaStream(tracks);
  const newRecorder = new MediaRecorder(recordedStream, options);

  // This is a little bit involved so that we're guaranteed to not drop any chunks and also
  // not process them out of order.
  //
  // This is a problem we have to solve because the OPFS api is extremely asynchronous, so in
  // a naive implementation that starts an appendToRecordingFile job in the ondataavailable
  // handler we could end up with multiple such jobs in flight at the same time, which leads
  // to data loss.
  //
  // To get around this, we instead queue incoming chunks and spawn a background task that
  // appends them to the file sequentially. The event handler signals to the background task
  // through a promise object that is exchanged after every delivered chunk. Promise objects
  // may be dropped without being awaited, but the chunks will be in the queue and handled
  // anyway. The exchange makes clever/ugly use of typescript capturing semantics, but this
  // is the least involved way I came up with.
  const chunkQueue: Blob[] = [];
  let chunkSignalResolve: (finished: boolean) => void;
  let chunkSignalPromise = new Promise<boolean>(resolve => chunkSignalResolve = resolve);

  newRecorder.ondataavailable = event => {
    chunkQueue.push(event.data);
    chunkSignalResolve(false);
    chunkSignalPromise = new Promise<boolean>(resolve => chunkSignalResolve = resolve);
  };
  newRecorder.onstop = () => chunkSignalResolve(true);
  newRecorder.onerror = event => showError(`Recording of track ${trackTitle} failed unexpectedly: ${event.message}`);

  const processChunks = async () => {
    let finished = false;
    let chunkNum = 0;
    const chunkPromises: RecordingBackgroundTask[] = [];

    while(!finished) {
      finished = await chunkSignalPromise;

      while(chunkQueue.length > 0) {
        const chunk = chunkQueue.shift();
        if(chunk) {
          // Wait for the quasi-synchronous part to conclude before processing the
          // next chunk, to avoid concurrent writes on the OPFS
          chunkPromises.push(await onChunkAvailable(chunk, trackTitle, chunkNum));
          ++chunkNum;
        }
      }
    }

    await onTrackFinished(trackTitle);

    // Wait for the fully asynchronous parts (the uploads to the server) to finish
    // before scheduling the postprocessing job.
    await Promise.allSettled(chunkPromises.map(job => job.promise));
  };

  const finishedPromise = processChunks();

  return {
    trackTitle,
    start: () => {
      try {
        newRecorder.start(chunkMillis);
      } catch(e) {
        chunkSignalResolve(true);
        showError(`Failed to start recording track ${trackTitle}`, e);
      }
    },
    stop: () => newRecorder.stop(),
    finished: finishedPromise
  };
}

/**
 * Prepare the recording jobs for a lecture recording with the given tracks.
 *
 * The main display and first audio track are combined into one recording stream called "stream",
 * the overlay track (if any) is recorded into the "overlay" stream, and any remaining video or audio
 * tracks are recorded into their own streams named "video-N" or "audio-N".
 *
 * Storage behavior is handled through the onChunkAvailable callback to separate recording logic from
 * storage logic.
 */
function prepareRecording(
  { displayTracks, videoTracks, audioTracks, mainDisplay, overlay }: RecordingTrackBundle,
  videoOptions: MediaRecorderOptions,
  audioOptions: MediaRecorderOptions,
  onChunkAvailable: (chunk: Blob, trackTitle: string, chunkIndex: number) => Promise<RecordingBackgroundTask>,
  onTrackFinished: (trackTitle: string) => Promise<void>
) {
  const jobs: RecordingTask[] = [];

  if(displayTracks.length > 0 || videoTracks.length > 0 || audioTracks.length > 0) {
    const prepareVideo = (tracks: MediaStreamTrack[], trackTitle: string) => prepareTrackRecording(tracks, trackTitle, videoOptions, onChunkAvailable, onTrackFinished);
    const prepareAudio = (tracks: MediaStreamTrack[], trackTitle: string) => prepareTrackRecording(tracks, trackTitle, audioOptions, onChunkAvailable, onTrackFinished);

    // If there's no bug in the rest of the program, this check should not be necessary, but I've janked the
    // mainDisplay/overlay resetting mechanic on stream removal before. So this is a useful canary.
    const isSaneVideoStream = (track: MediaStreamTrack, label: string) => {
      if(displayTracks.includes(track) || videoTracks.includes(track)) {
        return true;
      }

      console.error(`insane ${label} track`, track);
      return false;
    };

    // if no main display is selected, guess a sensible default: first captured display if there
    // are display streams, first video input otherwise, but don't use the overlay track unless it
    // really is the only one available.
    const mainDisplayCandidates = [
      mainDisplay !== undefined && isSaneVideoStream(mainDisplay, "main") ? mainDisplay : undefined,
      displayTracks.find(t => t !== overlay),
      videoTracks.find(t => t !== overlay),
      overlay !== undefined && isSaneVideoStream(overlay, "overlay") ? overlay : undefined
    ];
    const effectiveMainDisplay = mainDisplayCandidates.find(candidate => candidate !== undefined);

    if(effectiveMainDisplay !== undefined) {
      // attach first audio stream to main display if available, record the rest into individual files.
      // This is because at time of writing MediaRecorder on FF and Chrome does not support multiple
      // audio tracks (nor multiple video tracks, for that matter).
      jobs.push(prepareVideo([ effectiveMainDisplay, ...audioTracks.slice(0, 1) ], "stream"));
      jobs.push(...audioTracks.slice(1).map((track, index) => prepareAudio([track], `audio-${index}`)));
    } else {
      // if no video streams are available, record each audio track into its own file
      jobs.push(...audioTracks.map((track, index) => prepareAudio([track], `audio-${index}`)));
    }

    // If there's an overlay and it wasn't promoted to main display because there was no main display,
    // add it here. If overlay is explicitly marked both main and overlay, render the overlay on top
    // of itself.
    if(
      overlay !== undefined &&
      isSaneVideoStream(overlay, "overlay") &&
      (effectiveMainDisplay !== overlay || mainDisplay === overlay)
    ) {
      jobs.push(prepareVideo([ overlay ], "overlay"));
    }

    // If there are more video tracks than main and overlay, record each into its own file for manual postprocessing.
    const notYetHandled = (track: MediaStreamTrack) => track !== effectiveMainDisplay && track !== overlay;
    jobs.push(...videoTracks.filter(notYetHandled).map((track, i) => prepareVideo([track], `video-${i}`)));
    jobs.push(...displayTracks.filter(notYetHandled).map((track, i) => prepareVideo([track], `display-${i}`)));
  }

  return jobs;
}

/**
 * Record a lecture from the given display, video and audio tracks. mainDisplay and overlay must be an element
 * of either displayTracks or videoTracks. Tracks are combined as described above prepareRecording(...), the
 * output is webm using the browser's default codecs.
 *
 * The onStarting, onStarted, onChunkWritten and onFinished callbacks are meant to provide UI hooks, e.g.
 * disabling the recording button when a recording is started or updating the list of saved recordings after
 * a chunk was written.
 */
export async function recordLecture(
  trackBundle: RecordingTrackBundle,
  lectureTitle: string,
  lecturerEmail: string,
  destination: RecordingDestination,
  onStarting: (recordingName: string) => Promise<void> | void,
  onStarted: (recordingName: string, stopFunction: () => void) => Promise<void> | void,
  onChunkWritten: (recordingName: string, filename: string, chunkSize: number) => Promise<void> | void,
  onFinished: (recordingName: string) => Promise<void> | void,
  onStreamingFailed: (recordingName: string) => void
) {
  const sanitizedTitle = sanitizeLectureTitle(lectureTitle);
  const lecturePrefix = sanitizedTitle !== "" ? `${sanitizedTitle}_` : "";
  const now = new Date();
  const timestamp = now.toISOString().replaceAll(":", ".");
  const recordingName = `${lecturePrefix}${timestamp}`;

  const videoOptions: MediaRecorderOptions = { mimeType: "video/webm" };
  const audioOptions: MediaRecorderOptions = { mimeType: "audio/webm" };
  const formatFilename = (trackTitle: string) => `${trackTitle}.webm`;

  // Map of filename to output stream and associated information. This map is captured
  // and shared by the callback function we pass to the recording jobs below.
  const streams = new Map<string, FileSystemWritableFileStream>();
  const streamingAbort = new AbortController();

  streamingAbort.signal.addEventListener("abort", () => onStreamingFailed(recordingName), { once: true });

  if(destination.impeded) {
    streamingAbort.abort("impeded");
  }

  const chunkRetryPolicy: RetryPolicy = {
    retries: 6,
    initialWaitMillis: 2000,
    abortSignal: streamingAbort.signal
  };

  const postRetryPolicy: RetryPolicy = {
    retries: 3,
    initialWaitMillis: 1000,
    abortSignal: streamingAbort.signal
  };

  let stopTimer: ReturnType<typeof setTimeout> | undefined;

  // If backend is unavailable when the user clicks "stop recording", don't wait until all the queued
  // chunks have timed out. Give them a few seconds, then abort.
  const rearmStopTimer = () => {
    clearTimeout(stopTimer);

    if(!streamingAbort.signal.aborted) {
      stopTimer = setTimeout(() => streamingAbort.abort("stop"), 10000);
    }
  };

  const onChunkAvailable = async (chunk: Blob, trackTitle: string, chunkIndex: number): Promise<RecordingBackgroundTask> => {
    const uploadChunk = async () => {
      if(streamingAbort.signal.aborted) {
        return;
      }

      const result = await sendChunkToServer(destination, chunk, recordingName, trackTitle, chunkIndex, chunkRetryPolicy);

      if(stopTimer !== undefined && result.status === "ok") {
        // User has already clicked "stop recording", and uploads are slow and succeeding. So reset
        // the stop timer whenever a chunk succeeds because that means we're not timing out. It's
        // just going at a relaxed pace.
        rearmStopTimer();
      }

      if(result.status === "failed" && !streamingAbort.signal.aborted) {
        streamingAbort.abort("chunk");
        showError(`Streaming aborted: failed to upload chunk ${chunkIndex} of track ${trackTitle}: ${result.message ?? "unknown error"}`);
      }
    };

    // No need to await: we support sending chunks to server out of order and/or concurrently.
    const backgroundPromise = uploadChunk().catch(e => {
      // purely defensive: uploadChunk should not be able to throw. Guard against signal.aborted because in that
      // case a toast has already been shown. It's a .catch instead of a try-catch in uploadChunk because reactCompiler
      // bails with "&&/|| in try-except" otherwise. That'll probably become unnecessary at some point.
      if(!streamingAbort.signal.aborted) {
        streamingAbort.abort("chunk");
        showError(`Streaming aborted: unexpected error when uploading chunk ${chunkIndex} of track ${trackTitle}`, e);
      }
    });

    // For local file storage on the other hand, it's important that chunks to the same file
    // are not written concurrently and that filesystem state updates are correctly ordered.
    const filename = formatFilename(trackTitle);
    const stream = streams.get(filename);

    if(stream !== undefined) {
      try {
        await stream.write(chunk);
        await onChunkWritten(recordingName, filename, chunk.size);
      } catch(e) {
        // If this happens, it's probably because the browser quota is exhausted.
        showError(`Could not write to ${filename}`, e);
        streams.delete(filename);
        await stream.close().catch(() => null);
      }
    }

    return { promise: backgroundPromise };
  };

  const onTrackFinished = async (trackTitle: string) => {
    const filename = formatFilename(trackTitle);
    const stream = streams.get(filename);

    if(stream !== undefined) {
      streams.delete(filename);
      await stream.close().catch(() => null);
    }
  };

  const jobs = prepareRecording(trackBundle, videoOptions, audioOptions, onChunkAvailable, onTrackFinished);

  const stopJobs = () => {
    for(const job of jobs) {
      try {
        job.stop();
      } catch(e) {
        console.warn("Failed to stop recording job", e);
      }
    }

    if(destination.apiUrl !== undefined) {
      rearmStopTimer();
    }
  };

  if(jobs.length > 0) {
    await onStarting(recordingName);
    try {
      for(const job of jobs) {
        const filename = formatFilename(job.trackTitle);
        const outputStream = await openRecordingFileStream(recordingName, filename);
        streams.set(filename, outputStream);

        job.start();
      }

      await onStarted(recordingName, stopJobs);

      await Promise.allSettled(jobs.map(job => job.finished));
      clearTimeout(stopTimer);

      if(destination.apiUrl !== undefined) {
        const postResult = await schedulePostprocessing(destination, recordingName, lecturerEmail, postRetryPolicy);

        if(postResult.status === "ok") {
          showSuccess(`Scheduled postprocessing for recording "${recordingName}"`);
        } else if(postResult.status === "aborted") {
          showMessage("Post-processing could not be scheduled because streaming was impeded.");
        } else {
          showError(`Failed to schedule postprocessing: ${postResult.message}. The recording was streamed to backend and will be available for re-rendering within five minutes.`);
        }
      }
    } catch(e) {
      stopJobs();
      throw e;
    } finally {
      clearTimeout(stopTimer);
      stopTimer = undefined;
      // streams should normally be empty here because onTrackFinished closed, but just in case
      // something slipped through, close all remaining open streams.
      await Promise.allSettled(streams.values().map(stream => stream.close()));
      await onFinished(recordingName);
    }
  }
}

import { openRecordingFileStream, RecordingFileStream } from "./browserStorage";
import { schedulePostprocessing, sendChunkToServer } from "./serverStorage";

// used to remove characters from the recording name that would trip up ffmpeg in post.
export const unsafeTitleCharacters = /[^A-Za-z0-9_.-]/g;

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
  onChunkAvailable: (chunk: Blob, trackTitle: string, chunkNum: number) => Promise<RecordingBackgroundTask>
): RecordingTask {
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
  newRecorder.onerror = () => chunkSignalResolve(true);

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

    // Wait for the fully asynchronous parts (the uploads to the server) to finish
    // before scheduling the postprocessing job.
    await Promise.all(chunkPromises.map(job => job.promise));
  };

  const finishedPromise = processChunks();

  return {
    trackTitle,
    start: () => newRecorder.start(5000),
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
  displayTracks: MediaStreamTrack[],
  videoTracks: MediaStreamTrack[],
  audioTracks: MediaStreamTrack[],
  mainDisplay: MediaStreamTrack | null,
  overlay: MediaStreamTrack | null,
  videoOptions: MediaRecorderOptions,
  audioOptions: MediaRecorderOptions,
  onChunkAvailable: (chunk: Blob, trackTitle: string, chunkIndex: number) => Promise<RecordingBackgroundTask>
) {
  const jobs: RecordingTask[] = [];

  if(displayTracks.length > 0 || videoTracks.length > 0 || audioTracks.length > 0) {
    const prepareVideo = (tracks: MediaStreamTrack[], trackTitle: string) => prepareTrackRecording(tracks, trackTitle, videoOptions, onChunkAvailable);
    const prepareAudio = (tracks: MediaStreamTrack[], trackTitle: string) => prepareTrackRecording(tracks, trackTitle, audioOptions, onChunkAvailable);

    // if no main display is selected, guess a sensible default: first captured display if there
    // are display streams, first video input otherwise, but don't use the overlay track.
    const effectiveMainDisplay = mainDisplay ?? displayTracks.filter(t => t !== overlay).at(0) ?? videoTracks.filter(t => t !== overlay).at(0);

    if(effectiveMainDisplay) {
      // attach first audio stream to main display if available, record the rest into individual files.
      // This is because at time of writing MediaRecorder on FF and Chrome does not support multiple
      // audio tracks (nor multiple video tracks, for that matter).
      jobs.push(prepareVideo([ effectiveMainDisplay, ...audioTracks.slice(0, 1) ], "stream"));
      jobs.push(...audioTracks.slice(1).map((track, index) => prepareAudio([track], `audio-${index}`)));
    } else {
      // if no video streams are available, record each audio track into its own file
      jobs.push(...audioTracks.map((track, index) => prepareAudio([track], `audio-${index}`)));
    }

    if(overlay != null) {
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
  displayTracks: MediaStreamTrack[],
  videoTracks: MediaStreamTrack[],
  audioTracks: MediaStreamTrack[],
  mainDisplay: MediaStreamTrack | null,
  overlay: MediaStreamTrack | null,
  lectureTitle: string,
  lecturerEmail: string,
  apiUrl: string | undefined,
  onStarting: (recordingName: string) => Promise<void> | void,
  onStarted: (recordingName: string, stopFunction: () => void) => Promise<void> | void,
  onFinished: (recordingName: string) => Promise<void> | void
) {
  const timestamp = new Date();
  const lecturePrefix = lectureTitle ? `${lectureTitle}_` : "";
  const recordingName = `${lecturePrefix}${timestamp.toISOString()}`.replaceAll(unsafeTitleCharacters, "");

  const videoOptions: MediaRecorderOptions = { mimeType: "video/webm" };
  const audioOptions: MediaRecorderOptions = { mimeType: "audio/webm" };
  const formatFilename = (trackTitle: string) => `${trackTitle}.webm`;

  // Map of filename to output stream and associated information. This map is captured
  // and shared by the callback function we pass to the recording jobs below.
  const streams = new Map<string, RecordingFileStream>();

  const onChunkAvailable = async (chunk: Blob, trackTitle: string, chunkIndex: number): Promise<RecordingBackgroundTask> => {
    // No need to await: we support sending chunks to server out of order and/or concurrently.
    const backgroundPromise = sendChunkToServer(apiUrl, chunk, recordingName, trackTitle, chunkIndex);

    // For local file storage on the other hand, it's important that chunks to the same file
    // are not written concurrently and that filesystem state updates are correctly ordered.
    const filename = formatFilename(trackTitle);
    const stream = streams.get(filename);

    if(stream !== undefined) {
      try {
        await stream.write(chunk);
      } catch(e) {
        // If this happens, it's probably because the browser quota is exhausted.
        console.warn(`Could not write to ${filename}`, e);
        await stream.close();
        streams.delete(filename);
      }
    }

    return { promise: backgroundPromise };
  };

  const jobs = prepareRecording(displayTracks, videoTracks, audioTracks, mainDisplay, overlay, videoOptions, audioOptions, onChunkAvailable);

  if(jobs.length > 0) {
    await onStarting(recordingName);

    for(const job of jobs) {
      const filename = formatFilename(job.trackTitle);
      const outputStream = await openRecordingFileStream(recordingName, filename);
      streams.set(filename, outputStream);
      job.start();
    }

    await onStarted(recordingName, () => jobs.forEach(job => job.stop()));
    await Promise.all(jobs.map(job => job.finished));
    await Promise.all([
      ...streams.values().map(stream => stream.close()),
      schedulePostprocessing(apiUrl, recordingName, lecturerEmail)
    ]);
    await onFinished(recordingName);
  }
}

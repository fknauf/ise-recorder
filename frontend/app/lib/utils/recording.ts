// used to remove characters from the recording name that would trip up ffmpeg in post.
export const unsafeTitleCharacters = /[^A-Za-z0-9_.-]/g;

export interface RecordingTask {
  trackTitle: string,
  stop: () => void
}

interface PreparedRecordingTask extends RecordingTask {
  start: () => void
  finished: Promise<void>
}

// Our chunk handler has a quasi-synchronous part (writing to OPFS) and a fully asynchronous
// part (uploading to server). In JS/TS terms, both of these are async, but we want to await
// them at different points. What we conceptually need for that is a Promise<Promise<void>>,
// but Javascript quirks make it difficult to get those from an async function. So we do it
// with a Promise<RecordingBackgroundTask> instead.
export interface RecordingBackgroundTask {
  promise: Promise<void>
}

const prepareRecordingTask = (
  trackTitle: string,
  tracks: MediaStreamTrack[],
  options: MediaRecorderOptions,
  onChunkAvailable: (trackTitle: string, chunk: Blob, chunkNum: number) => Promise<RecordingBackgroundTask>
): PreparedRecordingTask => {
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
  let chunkSignalResolve: (finished: boolean) => void
  let chunkSignalPromise = new Promise<boolean>(resolve => chunkSignalResolve = resolve);

  newRecorder.ondataavailable = event => {
    chunkQueue.push(event.data);
    chunkSignalResolve(false);
    chunkSignalPromise = new Promise<boolean>(resolve => chunkSignalResolve = resolve);
  }
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
          chunkPromises.push(await onChunkAvailable(trackTitle, chunk, chunkNum));
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
};

/**
 * Record a lecture with the given tracks.
 *
 * The main display and first audio track are combined into one recording stream called "stream",
 * the overlay track (if any) is recorded into the "overlay" stream, and any remaining video or audio
 * tracks are recorded into their own streams named "video-N" or "audio-N".
 *
 * The recording name is generated from the lecture title (if any) and the current timestamp.
 *
 * Storage behavior is handled through the onChunkAvailable callback to separate recording logic from
 * storage logic. The onStarted and onFinished callbacks are called at the start and end of the overall
 * recording to enable UI updates and postprocessing.
 */
export const recordLecture = async (
  displayTracks: MediaStreamTrack[],
  videoTracks: MediaStreamTrack[],
  audioTracks: MediaStreamTrack[],
  mainDisplay: MediaStreamTrack | null,
  overlay: MediaStreamTrack | null,
  lectureTitle: string,
  videoOptions: MediaRecorderOptions,
  audioOptions: MediaRecorderOptions,
  onChunkAvailable: (chunk: Blob, recordingName: string, trackTitle: string, chunkIndex: number) => Promise<RecordingBackgroundTask>,
  onStarting: (recordingName: string, tasks: RecordingTask[]) => Promise<void> | void,
  onFinished: (recordingName: string) => void
) => {
  if(displayTracks.length === 0 && videoTracks.length === 0 && audioTracks.length === 0) {
    return;
  }

  const timestamp = new Date();
  const lecturePrefix = lectureTitle ? `${lectureTitle}_` : '';
  const recordingName = `${lecturePrefix}${timestamp.toISOString()}`.replaceAll(unsafeTitleCharacters, '');

  const onChunkFn = (trackTitle: string, chunk: Blob, chunkIndex: number) => onChunkAvailable(chunk, recordingName, trackTitle, chunkIndex);

  const recordVideo = (tracks: MediaStreamTrack[], trackTitle: string) => prepareRecordingTask(trackTitle, tracks, videoOptions, onChunkFn);
  const recordAudio = (tracks: MediaStreamTrack[], trackTitle: string) => prepareRecordingTask(trackTitle, tracks, audioOptions, onChunkFn);

  const jobs: PreparedRecordingTask[] = [];

  // if no main display is selected, guess a sensible default: first captured display if there
  // are display streams, first video input otherwise, but don't use the overlay track.
  const effectiveMainDisplay = mainDisplay ?? displayTracks.filter(t => t !== overlay).at(0) ?? videoTracks.filter(t => t !== overlay).at(0)

  if(effectiveMainDisplay) {
    // attach first audio stream to main display if available, record the rest into individual files.
    // This is because at time of writing MediaRecorder on FF and Chrome does not support multiple
    // audio tracks (nor multiple video tracks, for that matter).
    jobs.push(recordVideo([ effectiveMainDisplay, ...audioTracks.slice(0, 1) ], 'stream'));
    jobs.push(...audioTracks.slice(1).map((track, index) => recordAudio([track], `audio-${index}`)));
  } else {
    // if no video streams are available, record each audio track into its own file
    jobs.push(...audioTracks.map((track, index) => recordAudio([track], `audio-${index}`)));
  }

  if(overlay != null) {
    jobs.push(recordVideo([ overlay ], 'overlay'));
  }

  // If there are more video tracks than main and overlay, record each into its own file for manual postprocessing.
  const notYetHandled = (track: MediaStreamTrack) => track !== effectiveMainDisplay && track !== overlay;
  jobs.push(...videoTracks.filter(notYetHandled).map((track, i) => recordVideo([track], `video-${i}`)));
  jobs.push(...displayTracks.filter(notYetHandled).map((track, i) => recordVideo([track], `display-${i}`)));

  await onStarting(recordingName, jobs);

  for(const task of jobs) {
    task.start();
  }

  await Promise.all(jobs.map(task => task.finished));

  onFinished(recordingName);
};

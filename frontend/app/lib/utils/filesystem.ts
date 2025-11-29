/**
 * Helper functions to organize access to the recordings stored in the OPFS.
 *
 * All recordings are stored in the "recordings" directory in the OPFS root. Each recording
 * gets its own subdirectory named after the recording. Each file in the recording is stored
 * as a separate file in that directory.
 *
 * The functions here will always access files by recording name and filename, so the
 * application code doesn't have to know the details of the directory structure.
 */

export interface RecordingFileInfo {
  filename: string
  size?: number
}

export interface RecordingFileList {
  name: string,
  fileinfos: RecordingFileInfo[]
}

export interface RecordingsState {
  quota?: number
  usage?: number
  recordings: RecordingFileList[]
}

async function getRecordingsDirectory() {
  const rootDir = await navigator.storage.getDirectory();
  return await rootDir.getDirectoryHandle("recordings", { create: true });
}

async function getRecordingDirectory(name: string, options?: FileSystemGetDirectoryOptions) {
  const recordingDir = await getRecordingsDirectory();
  return await recordingDir.getDirectoryHandle(name, options);
}

async function getRecordingFile(recordingName: string, filename: string, options?: FileSystemGetFileOptions) {
  const recordingDir = await getRecordingDirectory(recordingName, { create: options?.create });
  return await recordingDir.getFileHandle(filename, options);
}

/**
 * Get the list of recordings, including file names and sizes.
 */
async function getRecordingsList() {
  const recordingsDir = await getRecordingsDirectory();
  const recordingNames = await Array.fromAsync(recordingsDir.keys())

  const result: RecordingFileList[] = [];

  for(const rname of recordingNames.sort()) {
    const dir = await recordingsDir.getDirectoryHandle(rname);
    const fnames = (await Array.fromAsync(dir.keys())).sort();

    const getFileInfo = async (filename: string) => {
      let size: number | undefined

      // Try to obtain file size, but don't fail if we can't. It's just to
      // show the file size on the download buttons, not critical information.
      try {
        const fileHandle = await dir.getFileHandle(filename);
        const file = await fileHandle.getFile();
        size = file.size
      } catch(e) {
        console.warn('Unable to get file size for', filename, e);
      }

      return <RecordingFileInfo>{
        filename: filename,
        size: size
      }
    }

    result.push({
      name: rname,
      fileinfos: await Promise.all(fnames.map(getFileInfo))
    })
  }

  return result;
}

/**
 * Get the full metadata state of the recordings storage, i.e. the list of recordings, quota, and used space.
 */
export async function getRecordingsState(): Promise<RecordingsState> {
  const recordings = await getRecordingsList();
  const fs = await navigator.storage.estimate();

  return {
    quota: fs.quota,
    usage: fs.usage,
    recordings
  }
}

export async function appendToRecordingFile(recordingName: string, filename: string, data: Blob) {
  try {
    const file = await getRecordingFile(recordingName, filename, { create: true });
    const fd = await file.getFile()
    const stream = await file.createWritable({ keepExistingData: true });

    await stream.write({
      type: "write",
      data: data,
      position: fd.size
    });

    await stream.close();
  } catch(e) {
    // If writing to the OPFS fails, it's probably because the quota is exceeded. In that case we
    // still have the server-side chunks, so don't fail and just log the error.
    console.warn('Unable to append to', filename, e);
  }
}

export async function readRecordingFile(recordingName: string, filename: string) {
  const file = await getRecordingFile(recordingName, filename);
  return await file.getFile();
}

export async function deleteRecording(recordingName: string) {
  const recordingsDir = await getRecordingsDirectory();
  await recordingsDir.removeEntry(recordingName, { recursive: true });
}

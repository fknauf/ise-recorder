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

export async function openRecordingFileStream(recordingName: string, filename: string) {
  const file = await getRecordingFile(recordingName, filename, { create: true });
  return file.createWritable();
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
    const allFilenames = await Array.fromAsync(dir.keys());
    // Chrome sets up filename.crswap when you open a file for writing. They're a browser
    // implementation detail that we don't want to show in our listing, so filter it here.
    const filenames = allFilenames.filter(name => !name.endsWith('.crswap')).sort();

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
      fileinfos: await Promise.all(filenames.map(getFileInfo))
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

export async function deleteRecording(recordingName: string) {
  const recordingsDir = await getRecordingsDirectory();
  await recordingsDir.removeEntry(recordingName, { recursive: true });
}

export async function downloadFile(recordingName: string, filename: string) {
  // This is a bit hacky, but I haven't been able to come up with a cleaner
  // way. Read file, create an object url for it, temporarly append a link
  // to the document, click it programmatically and remove it again.
  //
  // It might be prudent to switch this to the File System Access API once
  // that is widely available.

  const fileHandle = await getRecordingFile(recordingName, filename);
  const fileContents = await fileHandle.getFile();
  const url = URL.createObjectURL(fileContents);

  try {
    const link = document.createElement('a');

    link.href = url;
    link.download = filename;
    link.rel = "noopener"
    link.hidden = true;

    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

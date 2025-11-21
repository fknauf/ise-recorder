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

async function getRecordingsList() {
  const recordingsDir = await getRecordingsDirectory();
  const recordingNames = await Array.fromAsync(recordingsDir.keys())

  const result: RecordingFileList[] = [];

  for(const rname of recordingNames.sort()) {
    const dir = await recordingsDir.getDirectoryHandle(rname);
    const fnames = (await Array.fromAsync(dir.keys())).sort();

    const getFileInfo = async (filename: string) => {
      let size: number | undefined

      try {
        const fileHandle = await dir.getFileHandle(filename);
        const file = await fileHandle.getFile();
        size = file.size
      } catch(e) {
        console.log(e);
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

export async function getRecordingsState(): Promise<RecordingsState> {
  const recordings = await getRecordingsList();
  const fs = await navigator.storage.estimate();

  return {
    quota: fs.quota,
    usage: fs.usage,
    recordings
  }
}

export async function getRecordingFile(recordingName: string, filename: string, options?: FileSystemGetFileOptions) {
  const recordingDir = await getRecordingDirectory(recordingName, { create: options?.create });
  return await recordingDir.getFileHandle(filename, options);
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
    console.log(e);
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

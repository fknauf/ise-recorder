export interface RecordingFileList {
    name: string,
    files: string[]
}

export async function getRecordingsDirectory() {
    const rootDir = await navigator.storage.getDirectory();
    return await rootDir.getDirectoryHandle("recordings", { create: true });
}

export async function getRecordingDirectory(name: string, options?: FileSystemGetDirectoryOptions) {
    const recordingDir = await getRecordingsDirectory();
    return await recordingDir.getDirectoryHandle(name, options);
}

export async function getRecordingsList() {
    const recordingsDir = await getRecordingsDirectory();
    const recordingNames = await Array.fromAsync(recordingsDir.keys())

    const result: RecordingFileList[] = [];

    for(const rname of recordingNames.sort()) {
        const dir = await recordingsDir.getDirectoryHandle(rname);
        const fnames = await Array.fromAsync(dir.keys());

        result.push({
            name: rname,
            files: fnames
        })
    }

    return result;
}

export async function getRecordingFile(recordingName: string, filename: string, options?: FileSystemGetFileOptions) {
    const recordingDir = await getRecordingDirectory(recordingName, { create: options?.create });
    return await recordingDir.getFileHandle(filename, options);
}

export async function appendToRecordingFile(recordingName: string, filename: string, data: Blob) {
    const file = await getRecordingFile(recordingName, filename, { create: true });
    const fd = await file.getFile()
    const stream = await file.createWritable({ keepExistingData: true });

    await stream.write({
        type: "write",
        data: data,
        position: fd.size
    });
    await stream.close();
}

export async function readRecordingFile(recordingName: string, filename: string) {
    const file = await getRecordingFile(recordingName, filename);
    return await file.getFile();
}

export async function deleteRecording(recordingName: string) {
    const recordingsDir = await getRecordingsDirectory();
    await recordingsDir.removeEntry(recordingName, { recursive: true });
}

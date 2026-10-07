
import { deleteRecording, downloadFile, gatherRecordingsList, getAllRecordingTracks, openRecordingFileStream } from "@/lib/utils/browserStorage";
import { expect, test, afterEach, vi } from "vitest";
import { wipeOpfs } from "../helpers/opfs";
import { commands } from "vitest/browser";

afterEach(async () => {
  await wipeOpfs();
});

test("creating a recording track works", async () => {
  const stream = await openRecordingFileStream("FOO_1234", "stream.webm");
  await stream.write("abcd");
  await stream.close();

  const rootDir = await navigator.storage.getDirectory();
  const recDir = await rootDir.getDirectoryHandle("recordings");
  const fooDir = await recDir.getDirectoryHandle("FOO_1234");
  const files = await Array.fromAsync(fooDir.keys());

  expect(files).toStrictEqual([ "stream.webm" ]);
});

test("gathering the recordings list works", async () => {
  const fooStream = await openRecordingFileStream("FOO", "stream.webm");
  const fooOverlay = await openRecordingFileStream("FOO", "overlay.webm");
  const barStream = await openRecordingFileStream("BAR", "stream.webm");

  await fooStream.write("1234");
  await fooOverlay.write("123");
  await barStream.write("12");

  await fooStream.close();
  await fooOverlay.close();
  await barStream.close();

  const list = await gatherRecordingsList();

  expect(list).toStrictEqual([
    {
      name: "BAR",
      files: [
        {
          name: "stream.webm",
          size: 2
        }
      ]
    },
    {
      name: "FOO",
      files: [
        {
          name: "overlay.webm",
          size: 3
        },
        {
          name: "stream.webm",
          size: 4
        }
      ]
    }
  ]);
});

test("deleting a recording works", async () => {
  const fooStream = await openRecordingFileStream("FOO", "stream.webm");
  const fooOverlay = await openRecordingFileStream("FOO", "overlay.webm");

  await fooStream.write("1234");
  await fooOverlay.write("123");

  await fooStream.close();
  await fooOverlay.close();

  await deleteRecording("FOO");

  const list = await gatherRecordingsList();

  expect(list).toStrictEqual([]);
});

test("file download works", async () => {
  const fooStream = await openRecordingFileStream("FOO", "stream.webm");
  await fooStream.write("1234");
  await fooStream.close();

  const [ download ] = await Promise.all([
    commands.listenForFileDownload(),
    downloadFile("FOO", "stream.webm")
  ]);

  expect(download.suggestedFilename).toBe("stream.webm");
  expect(download.content).toBe("1234");
});

/** A file in a recording's directory, written the way recordLecture writes its tracks. */
async function writeFile(recording: string, filename: string, content: string) {
  const stream = await openRecordingFileStream(recording, filename);
  await stream.write(content);
  await stream.close();
}

/** The directory the browser keeps a recording in, to put things there recordLecture would not. */
async function recordingDirectory(recording: string) {
  const rootDir = await navigator.storage.getDirectory();
  const recordings = await rootDir.getDirectoryHandle("recordings");
  return await recordings.getDirectoryHandle(recording);
}

test("a recording's tracks are its webm files, named after them", async () => {
  // what a re-upload sends: each track under the name the backend expects it by
  await writeFile("FOO", "stream.webm", "main");
  await writeFile("FOO", "audio-0.webm", "second microphone");
  await writeFile("FOO", "overlay.webm", "camera");
  await (await recordingDirectory("FOO")).getFileHandle("notes.txt", { create: true });

  const tracks = await getAllRecordingTracks("FOO");

  expect(tracks.map(track => track.trackName)).toStrictEqual([ "audio-0", "overlay", "stream" ]);
  expect(await Promise.all(tracks.map(track => track.file.text()))).toStrictEqual([ "second microphone", "camera", "main" ]);
});

test("Chromium's swap files are left out of the recordings list", async () => {
  // Chromium writes through a .crswap next to the file while a stream is open; it is not a
  // file of the recording, and the user has nothing to do with it
  await writeFile("FOO", "stream.webm", "1234");
  await (await recordingDirectory("FOO")).getFileHandle("stream.webm.crswap", { create: true });

  const recordings = await gatherRecordingsList();

  expect(recordings).toStrictEqual([ { name: "FOO", files: [ { name: "stream.webm", size: 4 } ] } ]);
});

test("an entry whose size cannot be read is listed without one rather than failing the list", async () => {
  // the size is only shown on the download button; the rest of the list matters more
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await writeFile("FOO", "stream.webm", "1234");
  await (await recordingDirectory("FOO")).getDirectoryHandle("not-a-file", { create: true });

  const recordings = await gatherRecordingsList();

  expect(recordings).toStrictEqual([
    {
      name: "FOO",
      files: [ { name: "not-a-file", size: undefined }, { name: "stream.webm", size: 4 } ]
    }
  ]);
});

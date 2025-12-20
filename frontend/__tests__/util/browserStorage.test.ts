
import { deleteRecording, gatherRecordingsList, openRecordingFileStream } from "@/app/lib/utils/browserStorage";
import { expect, test, afterEach } from "vitest";

afterEach(async () => {
  const rootDir = await navigator.storage.getDirectory();
  for await (const key of rootDir.keys()) {
    await rootDir.removeEntry(key, { recursive: true });
  }
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

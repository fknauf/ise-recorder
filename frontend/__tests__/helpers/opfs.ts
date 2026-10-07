/**
 * Delete everything in the origin private file system, so that no recording a test made is
 * still there for the next one to find.
 */
export async function wipeOpfs() {
  const rootDir = await navigator.storage.getDirectory();
  for await (const key of rootDir.keys()) {
    await rootDir.removeEntry(key, { recursive: true });
  }
}

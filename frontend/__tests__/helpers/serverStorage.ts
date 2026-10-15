import type { DownloadableRecording, UnfinishedRecording } from "@/lib/utils/serverStorage";

/**
 * Recordings the way the backend lists them, and the way it answers an accepted render.
 */

/** The directory the backend keeps a user's recordings in, which every download path names. */
export const USER_DIGEST = "8f14e45fceea167a";

/**
 * Where the backend says the rendered video can be downloaded: a path relative to its API, with
 * the recording name percent-encoded into it and a TOTP in the query, since a link cannot carry
 * an Authorization header.
 */
export const downloadPath = (name: string, totp = "012345") =>
  `downloads/${USER_DIGEST}/${encodeURIComponent(name)}?totp=${totp}`;

/** Where the backend says the raw tracks can be downloaded, as a zip: next to the video, under the same TOTP. */
export const rawDownloadPath = (name: string, totp = "012345") =>
  `downloads/${USER_DIGEST}/${encodeURIComponent(name)}/raw?totp=${totp}`;

/** A rendered recording, with both of its download links. */
export const completed = (name: string, size: number, overrides: Partial<DownloadableRecording> = {}): DownloadableRecording => ({
  state: "completed",
  name,
  size,
  downloadUrl: downloadPath(name),
  rawDownloadUrl: rawDownloadPath(name),
  ...overrides
});

// The raw data link is null where the backend runs without authentication: there is no user
// directory to put in the path then. Present either way -- a listing without it is refused.

/** A recording the backend is rendering. */
export const rendering = (name: string, rawDownloadUrl: string | null = rawDownloadPath(name)): UnfinishedRecording =>
  ({ state: "rendering", name, rawDownloadUrl });

/** A recording whose postprocessing failed, and which can be rendered again. */
export const unprocessed = (name: string, rawDownloadUrl: string | null = rawDownloadPath(name)): UnfinishedRecording =>
  ({ state: "unprocessed", name, rawDownloadUrl });

/** A recording the backend cannot render at all -- one without a main display -- so only its raw data is of use. */
export const notRenderable = (name: string, rawDownloadUrl: string | null = rawDownloadPath(name)): UnfinishedRecording =>
  ({ state: "not-renderable", name, rawDownloadUrl });

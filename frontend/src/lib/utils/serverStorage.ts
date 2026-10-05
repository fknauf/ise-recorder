"use client";

import { ApiDestination, apiFetchData, apiFetchVoid, RetryPolicy, withRetries } from "./apiFetch";
import * as z from "zod";

const RenderingRecordingSchema = z.object({
  state: z.literal(["rendering"]),
  name: z.string()
});

const UnprocessedRecordingSchema = z.object({
  state: z.literal(["unprocessed"]),
  name: z.string()
});

const DownloadableRecordingSchema = z.object({
  state: z.literal("completed"),
  name: z.string(),
  size: z.number(),
  downloadUrl: z.string()
});

const ServerStorageRecordingSchema = z.discriminatedUnion(
  "state",
  [
    RenderingRecordingSchema,
    UnprocessedRecordingSchema,
    DownloadableRecordingSchema
  ]);

const ServerStorageRecordingListSchema = z.array(ServerStorageRecordingSchema);

type UnprocessedRecording = z.infer<typeof UnprocessedRecordingSchema>;
type RenderingRecording = z.infer<typeof RenderingRecordingSchema>;

export type UnfinishedRecording = UnprocessedRecording | RenderingRecording;
export type DownloadableRecording = z.infer<typeof DownloadableRecordingSchema>;
export type ServerStorageRecording = UnfinishedRecording | DownloadableRecording;

export async function uploadChunk(
  destination: ApiDestination,
  chunk: Blob,
  recording: string,
  track: string,
  index: number,
  abortSignal: AbortSignal | undefined
): Promise<void> {
  abortSignal?.throwIfAborted();

  const urlPath = `api/recordings/${encodeURIComponent(recording)}/tracks/${encodeURIComponent(track)}/chunks/${index}`;

  const request: RequestInit = {
    method: "PUT",
    body: chunk,
    signal: abortSignal
  };

  await apiFetchVoid(destination, urlPath, request);
}

export async function schedulePostprocessing(
  destination: ApiDestination,
  recording: string,
  recipient: string | undefined,
  abortSignal: AbortSignal | undefined
): Promise<UnfinishedRecording> {
  abortSignal?.throwIfAborted();

  const urlPath = `api/recordings/${encodeURIComponent(recording)}/render`;

  const data = {
    recipient
  };

  const request: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(data),
    signal: abortSignal
  };

  return await apiFetchData(destination, urlPath, request, RenderingRecordingSchema);
}

export async function fetchProcessedRecordings(
  destination: ApiDestination
): Promise<ServerStorageRecording[]> {
  const request: RequestInit = {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  };

  const urlPath = "api/recordings";

  return await apiFetchData(destination, urlPath, request, ServerStorageRecordingListSchema);
}

export async function purgeRecording(
  destination: ApiDestination,
  recordingName: string
): Promise<void> {
  const urlPath = `api/recordings/${encodeURIComponent(recordingName)}`;

  const request: RequestInit = {
    method: "DELETE"
  };

  return await apiFetchVoid(destination, urlPath, request);
}

export async function uploadFile(
  destination: ApiDestination,
  file: Blob,
  recording: string,
  track: string,
  retryPolicy: RetryPolicy,
  signalProgress: (bytesSent: number) => void = () => {}
): Promise<void> {
  const CHUNK_SIZE = 4 * 2 ** 20;

  for(let index = 0, offset = 0; offset < file.size; ++index, offset += CHUNK_SIZE) {
    const chunk = file.slice(offset, offset + CHUNK_SIZE);
    await withRetries(
      () => uploadChunk(
        destination,
        chunk,
        recording,
        track,
        index,
        retryPolicy.abortSignal
      ),
      retryPolicy
    );
    signalProgress(chunk.size);
  }
}

export const downloadHref = (apiUrl: string, recording: DownloadableRecording) =>
  new URL(recording.downloadUrl, new URL("api/", apiUrl)).href;

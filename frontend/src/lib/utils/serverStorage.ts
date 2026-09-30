"use client";

import { showError, showMessage, showSuccess } from "./notifications";
import * as z from "zod";

type AttemptStatus = "ok" | "temp-fail" | "permanent-fail" | "aborted";
export type UploadStatus = "ok" | "failed" | "aborted";

interface AttemptResult {
  status: AttemptStatus
  message?: string
}

export interface UploadResult {
  status: UploadStatus
  message?: string
}

export interface RetryPolicy {
  retries: number
  initialWaitMillis: number
  maxWaitMillis?: number
  backoffFactor?: number
  abortSignal?: AbortSignal
}

const DEFAULT_BACKOFF_FACTOR = 2;
const DEFAULT_MAX_WAIT_MILLIS = 60000;

export interface ServerStorageDestination {
  apiUrl: string | undefined
  getAccessToken: () => Promise<string | undefined>
}

export interface DownloadableRecording {
  name: string
  size: number
  totp: string
}

export interface RenderingRecording {
  name: string
}

export interface UnprocessedRecording {
  name: string
}

export interface ProcessedRecordings {
  user: string
  completed: DownloadableRecording[]
  rendering: RenderingRecording[]
  unprocessed: UnprocessedRecording[]
}

const ProcessedRecordingsSchema = z.object({
  user: z.string(),
  completed: z.array(z.object({
    name: z.string(),
    size: z.number(),
    totp: z.string()
  })),
  rendering: z.array(z.object({
    name: z.string()
  })),
  unprocessed: z.array(z.object({
    name: z.string()
  }))
});

const finalizeResult = (attemptResult: AttemptResult): UploadResult => ({
  status: attemptResult.status === "temp-fail" || attemptResult.status === "permanent-fail" ? "failed" : attemptResult.status,
  message: attemptResult.message
});

const abortableTimeout = (timeoutMillis: number, abortSignal?: AbortSignal) =>
  new Promise<AttemptStatus>(resolve => {
    if(abortSignal?.aborted) {
      resolve("aborted");
      return;
    }

    const abortHandler = () => {
      clearTimeout(timer);
      resolve("aborted");
    };

    const timeoutHandler = () => {
      abortSignal?.removeEventListener("abort", abortHandler);
      resolve("ok");
    };

    const timer = setTimeout(timeoutHandler, timeoutMillis);
    abortSignal?.addEventListener("abort", abortHandler, { once: true });
  });

async function callWithRetries(
  fn: () => Promise<AttemptResult> | AttemptResult,
  {
    retries,
    initialWaitMillis,
    maxWaitMillis,
    backoffFactor,
    abortSignal
  }: RetryPolicy
): Promise<AttemptResult> {
  if(abortSignal?.aborted) {
    return { status: "aborted" };
  }

  let result = await fn();

  let waitMillis = initialWaitMillis;
  for(let attempt = 0; result.status === "temp-fail" && attempt < retries; ++attempt) {
    if(await abortableTimeout(waitMillis, abortSignal) === "aborted") {
      return { status: "aborted" };
    }

    result = await fn();
    waitMillis = Math.min(waitMillis * (backoffFactor ?? DEFAULT_BACKOFF_FACTOR), maxWaitMillis ?? DEFAULT_MAX_WAIT_MILLIS);
  }

  return result;
}

async function sendRequest(
  url: string | URL | Request,
  request: RequestInit,
  abortSignal: AbortSignal | undefined,
  getAccessToken: () => Promise<string | undefined>
): Promise<AttemptResult> {
  try {
    const token = await getAccessToken();

    const authorizedRequest: RequestInit | undefined = token !== undefined
      ? {
          ...request,
          headers: {
            ...request.headers,
            Authorization: `Bearer ${token}`
          }
        }
      : request;

    const response = await fetch(url, { ...authorizedRequest, signal: abortSignal });

    if(abortSignal?.aborted) {
      return { status: "aborted" };
    }

    if(response.ok) {
      return { status: "ok" };
    }

    // 409 in here for now because it only occurs when a re-upload is started while it's already rendering, and in
    // that case it's best to show an immediate error message rather than wait. In principle 409 is transient, though,
    // so I might reconsider this at some point.
    const permanentFailureCodes = [ 400, 404, 409, 422 ];
    const status: AttemptStatus = permanentFailureCodes.includes(response.status) ? "permanent-fail" : "temp-fail";

    return { status, message: `server responded ${response.status}, ${await response.text()}` };
  } catch(e) {
    if(abortSignal?.aborted) {
      return { status: "aborted" };
    }

    console.warn("Error occurred when fetching", url, e);

    const errorMessage = e instanceof Error ? e.message : "unknown error";
    return { status: "temp-fail", message: errorMessage };
  }
}

export async function sendChunkToServer(
  destination: ServerStorageDestination,
  chunk: Blob,
  recording: string,
  track: string,
  index: number,
  retryPolicy: RetryPolicy
): Promise<UploadResult> {
  if(retryPolicy.abortSignal?.aborted) {
    return { status: "aborted" };
  }

  if(!destination.apiUrl) {
    return { status: "ok" };
  }

  const chunkUrl = `${destination.apiUrl}/api/chunks`;

  const data = new FormData();
  data.append("recording", recording);
  data.append("track", track);
  data.append("index", index.toFixed(0));
  data.append("chunk", chunk);

  const request: RequestInit = {
    method: "POST",
    body: data
  };

  const result = await callWithRetries(() => sendRequest(chunkUrl, request, retryPolicy.abortSignal, destination.getAccessToken), retryPolicy);
  return finalizeResult(result);
}

export async function schedulePostprocessing(
  destination: ServerStorageDestination,
  recording: string,
  recipient: string | undefined,
  retryPolicy: RetryPolicy
): Promise<UploadResult> {
  if(retryPolicy.abortSignal?.aborted) {
    showMessage("Post-processing could not be scheduled because streaming was impeded.");
    return { status: "failed" };
  }

  if(!destination.apiUrl) {
    return { status: "ok" };
  }

  const jobUrl = `${destination.apiUrl}/api/jobs`;

  const data = {
    recording,
    recipient
  };

  const request: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(data)
  };

  const result = await callWithRetries(() => sendRequest(jobUrl, request, retryPolicy.abortSignal, destination.getAccessToken), retryPolicy);

  if(result.status === "ok") {
    showSuccess(`Scheduled postprocessing for recording "${recording}"`);
  } else {
    showError(`Failed to schedule postprocessing: ${result.message}. The recording was streamed to backend and will be available for re-rendering within five minutes.`);
  }

  return finalizeResult(result);
}

export const downloadUrl = (
  apiUrl: string,
  user: string,
  recordingName: string,
  totp: string
) =>
  `${apiUrl}/api/recordings/${user}/${encodeURIComponent(recordingName)}?totp=${totp}`;

export async function fetchProcessedRecordings(
  apiUrl: string | undefined,
  getAccessToken: () => Promise<string | undefined>
): Promise<ProcessedRecordings | undefined> {
  if(apiUrl === undefined) {
    return undefined;
  }

  const token = await getAccessToken();

  if(token === undefined) {
    throw new Error("Unable to fetch list of processed recordings: not authenticated");
  }

  const request: RequestInit = {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    }
  };

  const response = await fetch(`${apiUrl}/api/recordings`, request);

  if(!response.ok) {
    // parse detail from fastapi response if possible, omit detail otherwise.
    const body = await response.json().catch(() => null);
    const detail = typeof body?.detail === "string" ? ` ${body.detail}` : "";
    throw new Error(`Unable to fetch list of processed recordings, server responded ${response.status}${detail}`);
  }

  return ProcessedRecordingsSchema.parse(await response.json());
}

export async function purgeRecording(
  apiUrl: string,
  recordingName: string,
  getAccessToken: () => Promise<string | undefined>
): Promise<UploadResult> {
  const token = await getAccessToken();

  if(token === undefined) {
    return {
      status: "failed",
      message: `Failed to purge ${recordingName}: Not authenticated`
    };
  }

  const endpoint = `${apiUrl}/api/recordings/${encodeURIComponent(recordingName)}`;

  const request: RequestInit = {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`
    }
  };

  try {
    const response = await fetch(endpoint, request);

    if(!response.ok) {
      const body = await response.json().catch(() => null);
      const detail = typeof body?.detail === "string" ? body.detail : "Unknown error";

      return {
        status: "failed",
        message: `Failed to purge ${recordingName}: ${detail}`
      };
    }

    return {
      status: "ok",
      message: `Purged ${recordingName}`
    };
  } catch(e) {
    console.error(`Failed to purge ${recordingName}`, e);
    const errMsg = e instanceof Error ? e.message : "Unknown error";

    return {
      status: "failed",
      message: `Failed to purge ${recordingName}: ${errMsg}`
    };
  }
}

export async function uploadFile(
  destination: ServerStorageDestination,
  file: Blob,
  recording: string,
  track: string,
  retryPolicy: RetryPolicy,
  signalProgress: (bytesSent: number) => void = () => {}
): Promise<UploadResult> {
  const CHUNK_SIZE = 4 * 2 ** 20;

  for(let index = 0, offset = 0; offset < file.size; ++index, offset += CHUNK_SIZE) {
    const chunk = file.slice(offset, offset + CHUNK_SIZE);

    const chunkResult = await sendChunkToServer(destination, chunk, recording, track, index, retryPolicy);

    if(chunkResult.status !== "ok") {
      return chunkResult;
    }

    signalProgress(chunk.size);
  }

  return { status: "ok" };
}

"use client";

import { showError, showMessage, showSuccess } from "./notifications";

type CallStatus = "ok" | "temp-fail" | "permanent-fail";

interface CallResult {
  status: CallStatus
  errorMessage?: string
}

interface RetryPolicy {
  retries: number
  intervalMillis: number
}

export interface ServerStorageDestination {
  apiUrl: string | undefined
  streamingImpeded: boolean
  getAccessToken: () => Promise<string | undefined>
}

async function callWithRetries(
  fn: () => Promise<CallResult> | CallResult,
  { retries, intervalMillis }: RetryPolicy
): Promise<CallResult> {
  let result = await fn();

  for(let attempt = 0; result.status === "temp-fail" && attempt < retries; ++attempt) {
    await new Promise(resolve => setTimeout(resolve, intervalMillis));
    result = await fn();
  }

  return result;
}

async function sendRequest(
  url: string | URL | Request,
  request: RequestInit,
  getAccessToken: () => Promise<string | undefined>
): Promise<CallResult> {
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

    const response = await fetch(url, authorizedRequest);

    if(response.ok) {
      return { status: "ok" };
    }

    const permanentFailureCodes = [ 400, 404, 422 ];
    const status: CallStatus = permanentFailureCodes.includes(response.status) ? "permanent-fail" : "temp-fail";

    return { status, errorMessage: `server responded ${response.status}, ${await response.text()}` };
  } catch(e) {
    console.warn("Error occurred when fetching", url, e);
    return { status: "temp-fail", errorMessage: e instanceof Error ? e.message : "unknown error" };
  }
}

export async function sendChunkToServer(
  destination: ServerStorageDestination,
  chunk: Blob,
  recording: string,
  track: string,
  index: number,
  retryPolicy: RetryPolicy = { retries: 10, intervalMillis: 2000 }
) {
  if(!destination.apiUrl || destination.streamingImpeded) {
    return false;
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

  const result = await callWithRetries(() => sendRequest(chunkUrl, request, destination.getAccessToken), retryPolicy);

  if(result.status !== "ok") {
    showError(`Failed to upload ${track} chunk ${index}: ${result.errorMessage}`);
    return false;
  }

  return true;
}

export async function schedulePostprocessing(
  destination: ServerStorageDestination,
  recording: string,
  recipient: string | undefined,
  retryPolicy: RetryPolicy = { retries: 5, intervalMillis: 1000 }
) {
  if(!destination.apiUrl) {
    return;
  } else if(destination.streamingImpeded) {
    showMessage("Post-processing could not be scheduled because streaming was impeded. Please download the recording files for manual postprocessing.");
    return;
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

  const result = await callWithRetries(() => sendRequest(jobUrl, request, destination.getAccessToken), retryPolicy);

  if(result.status === "ok") {
    showSuccess(`Recording "${recording}" finished; postprocessing scheduled.`);
    return true;
  } else {
    showError(`Failed to schedule postprocessing: ${result.errorMessage}`);
    return false;
  }
}

export const downloadUrl = (
  apiUrl: string,
  user: string,
  recordingName: string,
  totp: string
) =>
  `${apiUrl}/api/recordings/${user}/${encodeURIComponent(recordingName)}?totp=${totp}`;

export async function purgeRecording(
  apiUrl: string,
  recordingName: string,
  getAccessToken: () => Promise<string | undefined>,
  refreshList: () => void) {
  const token = await getAccessToken();

  if(token === undefined) {
    showError(`Failed to purge ${recordingName}: Not authenticated`);
    return;
  }

  const endpoint = `${apiUrl}/api/recordings/${encodeURIComponent(recordingName)}`;

  const request: RequestInit = {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    }
  };

  try {
    const response = await fetch(endpoint, request);
    refreshList();

    if(response.ok) {
      showSuccess(`Purged ${recordingName}`);
    } else {
      const body = await response.json().catch(() => null);
      const detail = typeof body?.detail === "string" ? body.detail : "Unknown error";
      showError(`Failed to purge ${recordingName}: ${detail}`);
    }
  } catch(e) {
    console.error(`Failed to purge ${recordingName}`, e);
    const errMsg = e instanceof Error ? e.message : "Unknown error";
    showError(`Failed to purge ${recordingName}: ${errMsg}`);
  }
}

export async function uploadFile(
  destination: ServerStorageDestination,
  file: Blob,
  recording: string,
  track: string,
  retryPolicy?: RetryPolicy
): Promise<boolean> {
  const CHUNK_SIZE = 4 * 2 ** 20;

  for(let index = 0, offset = 0; offset < file.size; ++index, offset += CHUNK_SIZE) {
    const chunk = file.slice(offset, offset + CHUNK_SIZE);

    if(!await sendChunkToServer(destination, chunk, recording, track, index, retryPolicy)) {
      return false;
    }
  }

  return true;
}

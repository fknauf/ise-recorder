"use client";

import { showError, showMessage, showSuccess } from "./notifications";

interface CallResult {
  ok: boolean
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

  for(let attempt = 0; !result.ok && attempt < retries; ++attempt) {
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
      return { ok: true };
    }

    return { ok: false, errorMessage: `server responded ${response.status}, ${await response.text()}` };
  } catch(e) {
    console.warn("Error occurred when fetching", url, e);
    return { ok: false, errorMessage: e instanceof Error ? e.message : "unknown error" };
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
    return;
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

  if(!result.ok) {
    showError(`Failed to upload ${track} chunk ${index}: ${result.errorMessage}`);
  }
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

  if(result.ok) {
    showSuccess(`Recording "${recording}" finished; postprocessing scheduled.`);
  } else {
    showError(`Failed to schedule postprocessing: ${result.errorMessage}`);
  }
}

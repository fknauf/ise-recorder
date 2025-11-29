import { showError, showSuccess } from "./notifications";

interface CallResult {
  ok: boolean
  errorMessage?: string
}

async function callWithRetries(
  fn: () => Promise<CallResult> | CallResult,
  retries: number,
  intervalMillis: number
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
  request?: RequestInit
): Promise<CallResult> {
  try {
    const response = await fetch(url, request);

    if(response.ok) {
      return { ok: true }
    }

    return { ok: false, errorMessage: `server responded ${response.status}, ${await response.text()}` };
  } catch(e) {
    console.warn('Error occurred when fetching', url, e);
    return { ok: false, errorMessage: e instanceof Error ? e.message : 'unknown error' };
  }
}

export async function sendChunkToServer(
  apiUrl: string | undefined,
  chunk: Blob,
  recording: string,
  track: string,
  index: number
) {
  if(!apiUrl) {
    return;
  }

  const chunkUrl = `${apiUrl}/api/chunks`;
  const retries = 10;
  const intervalMillis = 2000;

  const data = new FormData();
  data.append('recording', recording);
  data.append('track', track);
  data.append('index', index.toFixed(0));
  data.append('chunk', chunk);

  const request: RequestInit = {
    method: "POST",
    body: data
  }

  const result = await callWithRetries(() => sendRequest(chunkUrl, request), retries, intervalMillis);

  if(!result.ok) {
    showError(`Failed to upload ${track} chunk ${index}: ${result.errorMessage}`)
  }
}

export async function schedulePostprocessing(
  apiUrl: string | undefined,
  recording: string,
  recipient?: string
) {
  if(!apiUrl) {
    return;
  }

  const jobUrl = `${apiUrl}/api/jobs`;
  const retries = 5;
  const intervalMillis = 1000;

  const data = {
    recording,
    recipient
  };

  const request: RequestInit = {
    method: "POST",
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data)
  };

  const result = await callWithRetries(() => sendRequest(jobUrl, request), retries, intervalMillis);

  if(result.ok) {
    showSuccess(`Recording "${recording}" finished; postprocessing scheduled.`);
  } else {
    showError(`Failed to schedule postprocessing: ${result.errorMessage}`);
  }
}

import { showError } from "./notifications";

async function fetchWithRetries(
  url: string | URL | Request,
  request: RequestInit | undefined,
  retries: number,
  intervalMillis: number,
  errorPrefix: string
) {
  for(let attempt = 0; attempt <= retries; ++attempt) {
    let errMsg: string;

    try {
      const response = await fetch(url, request);

      if(response.ok) {
        break;
      }

      errMsg = `server responded ${response.status}, ${await response.text()}`;
    } catch(e) {
      console.log(e);
      errMsg = e instanceof Error ? e.message : 'unknown error';
    }

    if(attempt == retries) {
      showError(`${errorPrefix}: ${errMsg}`);
      break;
    }

    await new Promise(resolve => setTimeout(resolve, intervalMillis));
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

  await fetchWithRetries(chunkUrl, request, retries, intervalMillis, `Failed to upload ${track} chunk ${index}`);
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

  await fetchWithRetries(jobUrl, request, retries, intervalMillis, 'Failed to schedule postprocessing');
}

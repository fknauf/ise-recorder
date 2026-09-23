import useSWR, { useSWRConfig } from "swr";
import { useAppSession } from "../components/SessionProvider";
import * as z from "zod";
import { useServerEnv } from "./useServerEnv";

const RECORDINGS_KEY = "/api/recordings";

export interface DownloadableRecording {
  name: string
  size: number
  totp: string
}

export interface RenderingRecording {
  name: string
}

export interface DownloadableRecordings {
  user: string
  completed: DownloadableRecording[]
  rendering: RenderingRecording[]
}

const DownloadableRecordingsSchema = z.object({
  user: z.string(),
  completed: z.array(z.object({
    name: z.string(),
    size: z.number(),
    totp: z.string()
  })),
  rendering: z.array(z.object({
    name: z.string()
  }))
});

export function useProcessedRecordings() {
  const { apiUrl } = useServerEnv();
  const { getAccessToken } = useAppSession();

  const fetcher = async (key: string): Promise<DownloadableRecordings | null> => {
    const token = await getAccessToken();

    if(token === undefined) {
      return null;
    }

    const request: RequestInit = {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      }
    };

    const response = await fetch(`${apiUrl}${key}`, request);

    if(!response.ok) {
      // parse detail from fastapi response if possible, omit detail otherwise.
      const body = await response.json().catch(() => null);
      const detail = typeof body?.detail === "string" ? ` ${body.detail}` : "";
      throw new Error(`Unable to fetch list of processed recordings, server responded ${response.status}${detail}`);
    }

    return DownloadableRecordingsSchema.parse(await response.json());
  };

  return useSWR(
    apiUrl !== undefined ? RECORDINGS_KEY : null,
    fetcher,
    {
      fallbackData: null,
      refreshInterval: 60000,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      shouldRetryOnError: true,
      errorRetryInterval: 5000
    }
  );
}

export function useRefreshProcessedRecordings() {
  const { mutate } = useSWRConfig();
  return () => mutate(RECORDINGS_KEY);
}

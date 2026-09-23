import useSWR from "swr";
import { useAppSession } from "../components/SessionProvider";
import * as z from "zod";
import { useServerEnv } from "./useServerEnv";

export interface DownloadableRecording {
  name: string
  size: number
  totp: string
}

export interface DownloadableRecordings {
  user: string
  recordings: DownloadableRecording[]
}

const DownloadableRecordingsSchema = z.object({
  user: z.string(),
  recordings: z.array(z.object({
    name: z.string(),
    size: z.number(),
    totp: z.string()
  }))
});

export function usePreprocessedRecordings() {
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
    apiUrl !== undefined ? "/api/completed" : null,
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

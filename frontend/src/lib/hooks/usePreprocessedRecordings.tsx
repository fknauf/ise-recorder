import useSWR from "swr";
import { useAccessTokenSource } from "../hooks/useAccessTokenSource";
import { useCallback } from "react";
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
  const { getAccessToken } = useAccessTokenSource();

  const fetcher = useCallback(async (key: string): Promise<DownloadableRecordings | null> => {
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
      console.error(`Unable to fetch list of processed recordings, server responded ${response.status}, ${await response.text()}`);
      return null;
    }

    try {
      return DownloadableRecordingsSchema.parse(await response.json());
    } catch(e) {
      console.error("Unable to fetch list of processed recordings: server sent malformed response", e);
      return null;
    }
  }, [ apiUrl, getAccessToken ]);

  return useSWR(
    apiUrl !== undefined ? "/api/completed" : null,
    fetcher,
    {
      fallbackData: null,
      refreshInterval: 60000,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      shouldRetryOnError: true,
      errorRetryInterval: 60000
    }
  );
}

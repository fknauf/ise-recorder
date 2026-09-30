import useSWR, { useSWRConfig } from "swr";
import { useAppSession } from "../components/SessionProvider";
import { useServerEnv } from "./useServerEnv";
import { fetchProcessedRecordings } from "../utils/serverStorage";

const RECORDINGS_KEY = "/api/recordings";

export function useProcessedRecordings() {
  const { apiUrl } = useServerEnv();
  const {
    isAuthenticated,
    getAccessToken
  } = useAppSession();

  const canFetch = apiUrl !== undefined && isAuthenticated;

  return useSWR(
    canFetch ? RECORDINGS_KEY : null,
    () => fetchProcessedRecordings(apiUrl, getAccessToken),
    {
      fallbackData: undefined,
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

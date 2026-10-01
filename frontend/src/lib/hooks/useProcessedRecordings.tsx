import useSWR, { useSWRConfig } from "swr";
import { useAppSession } from "../components/SessionProvider";
import { useServerEnv } from "./useServerEnv";
import { fetchProcessedRecordings, ProcessedRecordings, purgeRecording, schedulePostprocessing } from "../utils/serverStorage";
import { useLecture } from "./useLecture";

const RECORDINGS_KEY = "/api/recordings";

export function useProcessedRecordings() {
  const { apiUrl } = useServerEnv();
  const { lecturerEmail } = useLecture();
  const { isAuthenticated, getAccessToken } = useAppSession();

  const canFetch = apiUrl !== undefined && isAuthenticated;

  const { data, mutate, error, isLoading, isValidating } = useSWR(
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

  const refresh = () => mutate();

  const purge = async (recordingName: string) => {
    if(apiUrl === undefined) {
      return undefined;
    }

    const optimisticPurgeUpdate = (committed: ProcessedRecordings | undefined, displayed?: ProcessedRecordings) => {
      const current = displayed ?? committed;

      if(current === undefined) {
        return undefined;
      }

      return {
        ...current,
        completed: current.completed.filter(rec => rec.name !== recordingName),
        unprocessed: current.unprocessed.filter(rec => rec.name !== recordingName),
        rendering: current.rendering.filter(rec => rec.name !== recordingName)
      };
    };

    return await mutate(
      () => purgeRecording(apiUrl, recordingName, getAccessToken),
      {
        optimisticData: optimisticPurgeUpdate,
        rollbackOnError: true,
        revalidate: false
      }
    );
  };

  const rerender = (recordingName: string) => {
    const optimisticRerenderUpdate = (committed: ProcessedRecordings | undefined, displayed?: ProcessedRecordings) => {
      const current = displayed ?? committed;

      if(current === undefined) {
        return undefined;
      }

      return {
        ...current,
        completed: current.completed.filter(rec => rec.name !== recordingName),
        unprocessed: current.unprocessed.filter(rec => rec.name !== recordingName),
        rendering: [ ...current.rendering, { name: recordingName } ].toSorted((a, b) => a.name.localeCompare(b.name))
      };
    };

    return mutate(async () => {
      const result = await schedulePostprocessing(
        { apiUrl, getAccessToken },
        recordingName,
        lecturerEmail,
        { retries: 0, initialWaitMillis: 5000 }
      );

      if(result.status !== "ok") {
        throw new Error(result.message);
      }
    }, {
      optimisticData: optimisticRerenderUpdate,
      rollbackOnError: true,
      revalidate: true,
      populateCache: false
    });
  };

  return { data, error, isLoading, isValidating, refresh, rerender, purge };
}

export function useRefreshProcessedRecordings() {
  const { mutate } = useSWRConfig();
  return () => mutate(RECORDINGS_KEY);
}

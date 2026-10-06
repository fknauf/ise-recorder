import useSWR, { useSWRConfig } from "swr";
import { useAppSession } from "../components/SessionProvider";
import { useServerEnv } from "./useServerEnv";
import { fetchRecordings, purgeRecording, schedulePostprocessing, ServerStorageRecording, UnfinishedRecording } from "../utils/serverStorage";
import { useLecture } from "./useLecture";

const RECORDINGS_KEY = "/api/recordings";

export function useServerStorage() {
  const { apiUrl } = useServerEnv();
  const { lecturerEmail } = useLecture();
  const { isAuthenticated, getAccessToken } = useAppSession();

  const canFetch = apiUrl !== undefined && isAuthenticated;

  const { data, mutate, error, isLoading, isValidating } = useSWR(
    canFetch ? RECORDINGS_KEY : null,
    () => (apiUrl !== undefined ? fetchRecordings({ apiUrl, getAccessToken }) : []),
    {
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

    const optimisticPurgeUpdate = (committed: ServerStorageRecording[] | undefined, displayed?: ServerStorageRecording[]) => {
      const current = displayed ?? committed ?? [];
      return current.filter(value => value.name !== recordingName);
    };

    return await mutate(
      async () => {
        await purgeRecording({ apiUrl, getAccessToken }, recordingName);
      },
      {
        optimisticData: optimisticPurgeUpdate,
        populateCache: false,
        revalidate: true,
        rollbackOnError: true
      }
    );
  };

  const rerender = (recordingName: string) => {
    if(apiUrl === undefined) {
      return undefined;
    }

    const optimisticRerenderUpdate = (committed: ServerStorageRecording[] | undefined, displayed?: ServerStorageRecording[]) => {
      const current = displayed ?? committed ?? [];
      const replacement: UnfinishedRecording = {
        state: "rendering",
        name: recordingName
      };
      return current.map(value => (value.name === recordingName ? replacement : value));
    };

    return mutate(async () => {
      await schedulePostprocessing({ apiUrl, getAccessToken }, recordingName, lecturerEmail, undefined);
    },
    {
      optimisticData: optimisticRerenderUpdate,
      populateCache: false,
      rollbackOnError: true,
      revalidate: true
    });
  };

  return { data, error, isLoading, isValidating, refresh, rerender, purge };
}

export function useRefreshServerStorage() {
  const { mutate } = useSWRConfig();
  return () => mutate(RECORDINGS_KEY);
}

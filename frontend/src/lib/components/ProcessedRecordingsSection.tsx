"use client";

import useSWR from "swr";
import { useAccessTokenSource } from "../hooks/useAccessTokenSource";
import { useServerEnv } from "../hooks/useServerEnv";
import { useCallback } from "react";
import * as z from "zod";
import { ActionButton, Link, Text } from "@adobe/react-spectrum";
import Download from "@spectrum-icons/workflow/Download";
import { RecordingCard, RecordingCardSection } from "./RecordingCardSection";

const mibFormatter = new Intl.NumberFormat(
  "en-us",
  {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false
  }
);

interface DownloadableRecording {
  name: string
  size: number
  totp: string
}

interface DownloadableRecordings {
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

function usePreprocessedRecordings(apiUrl: string): DownloadableRecordings | null {
  const { getAccessToken } = useAccessTokenSource();

  const fetcher = useCallback(async (key: string) => {
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

  const { data: recordings } = useSWR(
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

  return recordings;
}

function ProcessedRecordingCard({ apiUrl, user, recording }: Readonly<{ apiUrl: string; user: string; recording: DownloadableRecording }>) {
  return (
    <RecordingCard title={recording.name} testid="prec-card">
      <Link
        variant="primary"
        key={recording.name}
        href={`${apiUrl}/api/completed/${user}/${recording.name}?totp=${recording.totp}`}
        download={true}
      >
        <ActionButton>
          <Download/>
          <Text>Download ({mibFormatter.format(recording.size / (2 ** 20))} MiB)</Text>
        </ActionButton>
      </Link>
    </RecordingCard>
  );
}

function PreprocessedRecordingsSectionImpl({ apiUrl }: Readonly<{ apiUrl: string }>) {
  const response = usePreprocessedRecordings(apiUrl);

  if(!response) {
    return null;
  }

  return (
    <RecordingCardSection title="Server-Side Processed Recordings">
      {
        response.recordings.map(rec =>
          <ProcessedRecordingCard
            key={rec.name}
            apiUrl={apiUrl}
            user={response.user}
            recording={rec}
          />
        )
      }
    </RecordingCardSection>
  );
}

export function PreprocessedRecordingsSection() {
  const { authRequired } = useAccessTokenSource();
  const { apiUrl } = useServerEnv();

  if(apiUrl === undefined || !authRequired) {
    return null;
  }

  return <PreprocessedRecordingsSectionImpl apiUrl={apiUrl}/>;
}

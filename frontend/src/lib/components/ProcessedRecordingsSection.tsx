"use client";

import { useAppSession } from "./SessionProvider";
import { useServerEnv } from "../hooks/useServerEnv";
import { ActionButton, Link, Text } from "@adobe/react-spectrum";
import Download from "@spectrum-icons/workflow/Download";
import { RecordingCard, RecordingCardSection } from "./RecordingCardSection";
import { DownloadableRecording, usePreprocessedRecordings } from "../hooks/usePreprocessedRecordings";

const mibFormatter = new Intl.NumberFormat(
  "en-us",
  {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false
  }
);

function ProcessedRecordingCard(
  { apiUrl, user, recording }: Readonly<{ apiUrl: string; user: string; recording: DownloadableRecording }>
) {
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
  const { data: response } = usePreprocessedRecordings();

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
  const { isAuthenticated, isExpired } = useAppSession();
  const { apiUrl } = useServerEnv();

  if(apiUrl === undefined || !isAuthenticated || isExpired) {
    return null;
  }

  return <PreprocessedRecordingsSectionImpl apiUrl={apiUrl}/>;
}

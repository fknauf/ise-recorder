"use client";

import { useAppSession } from "./SessionProvider";
import { useServerEnv } from "../hooks/useServerEnv";
import { ActionButton, Content, Heading, InlineAlert, Link, Text } from "@adobe/react-spectrum";
import Download from "@spectrum-icons/workflow/Download";
import { RecordingCard, RecordingCardSection } from "./RecordingCardSection";
import { DownloadableRecording, usePreprocessedRecordings } from "../hooks/usePreprocessedRecordings";
import * as z from "zod";

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

function prettifyError(error: unknown) {
  if(error instanceof z.ZodError) {
    return z.prettifyError(error);
  }

  if(error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}

function PreprocessedRecordingsSectionImpl({ apiUrl }: Readonly<{ apiUrl: string }>) {
  const { data, error } = usePreprocessedRecordings();
  const sectionTitle = "Server-Side Processed Recordings";

  if(error !== undefined) {
    return (
      <RecordingCardSection title={sectionTitle}>
        <InlineAlert variant="negative">
          <Heading>
            Error fetching list of processed recordings
          </Heading>
          <Content>
            {prettifyError(error)}
          </Content>
        </InlineAlert>
      </RecordingCardSection>
    );
  }

  if(!data) {
    return null;
  }

  return (
    <RecordingCardSection title={sectionTitle}>
      {
        data.recordings.map(rec =>
          <ProcessedRecordingCard
            key={rec.name}
            apiUrl={apiUrl}
            user={data.user}
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

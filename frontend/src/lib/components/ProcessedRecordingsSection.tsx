"use client";

import { useAppSession } from "./SessionProvider";
import { useServerEnv } from "../hooks/useServerEnv";
import { ActionButton, Button, ButtonGroup, Content, Dialog, DialogTrigger, Divider, Flex, Heading, InlineAlert, Link, ProgressCircle, Text } from "@adobe/react-spectrum";
import Download from "@spectrum-icons/workflow/Download";
import Refresh from "@spectrum-icons/workflow/Refresh";
import Delete from "@spectrum-icons/workflow/Delete";
import { RecordingCard, RecordingCardSection } from "./RecordingCardSection";
import { DownloadableRecording, RenderingRecording, UnprocessedRecording, useProcessedRecordings, useRefreshProcessedRecordings } from "../hooks/useProcessedRecordings";
import * as z from "zod";
import { downloadUrl, purgeRecording, schedulePostprocessing } from "../utils/serverStorage";
import { useLecture } from "../hooks/useLecture";
import { useState } from "react";

const mibFormatter = new Intl.NumberFormat(
  "en-us",
  {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false
  }
);

const useRerender = (recordingName: string) => {
  const { apiUrl } = useServerEnv();
  const { getAccessToken } = useAppSession();
  const { lecturerEmail } = useLecture();
  const refreshProcessedRecordings = useRefreshProcessedRecordings();

  const [ busy, setBusy ] = useState(false);

  const rerender = async () => {
    setBusy(true);

    try {
      const scheduled = await schedulePostprocessing(
        { apiUrl, streamingImpeded: false, getAccessToken },
        recordingName,
        lecturerEmail,
        { retries: 0, intervalMillis: 5000 }
      );

      if(scheduled) {
        await refreshProcessedRecordings();
      }
    } catch(e) {
      console.warn(`Failed to schedule re-render for ${recordingName}`, e);
    }

    setBusy(false);
  };

  return [ busy, rerender ] as const;
};

function PurgeButton({ recordingName }: Readonly<{ recordingName: string }>) {
  const { apiUrl } = useServerEnv();
  const { getAccessToken } = useAppSession();
  const refreshProcessedRecordings = useRefreshProcessedRecordings();
  const [ busy, setBusy ] = useState(false);

  if(apiUrl === undefined) {
    return null;
  }

  return (
    <DialogTrigger>
      <ActionButton width="100%">
        <Delete/>
        <Text>Purge</Text>
      </ActionButton>
      {
        close =>
          <Dialog>
            <Heading>
              Confirm purge of {recordingName}
            </Heading>
            <Divider/>
            <Content>
              <Text>You are about to permanently delete the recording {recordingName} from the server. This can not be undone. Are you sure?</Text>
            </Content>
            <ButtonGroup>
              <Button isDisabled={busy} variant="secondary" onPress={close} autoFocus>Cancel</Button>
              <Button
                isDisabled={busy} variant="negative" onPress={async () => {
                  setBusy(true);
                  await purgeRecording(apiUrl, recordingName, getAccessToken, refreshProcessedRecordings);
                  setBusy(false);
                  close();
                }}
              >Purge
              </Button>
            </ButtonGroup>
          </Dialog>

      }
    </DialogTrigger>
  );
}

function ProcessedRecordingCard(
  { user, recording }: Readonly<{ user: string; recording: DownloadableRecording }>
) {
  const { apiUrl } = useServerEnv();
  const [ busy, rerender ] = useRerender(recording.name);

  if(apiUrl === undefined) {
    return null;
  }

  const url = downloadUrl(apiUrl, user, recording.name, recording.totp);

  return (
    <RecordingCard title={recording.name} testid="prec-card">
      <Link
        variant="primary"
        key={recording.name}
        href={url}
        download={true}
        width="100%"
      >
        <ActionButton width="100%">
          <Download/>
          <Text>Download ({mibFormatter.format(recording.size / (2 ** 20))} MiB)</Text>
        </ActionButton>
      </Link>

      <ActionButton
        width="100%"
        onPress={rerender}
        isDisabled={busy}
      >
        <Refresh/>
        <Text>Rerender</Text>
      </ActionButton>

      <PurgeButton recordingName={recording.name}/>
    </RecordingCard>
  );
}

const RenderingRecordingCard = (
  { recording }: Readonly<{ recording: RenderingRecording }>
) =>
  <RecordingCard title={recording.name} testid="rendering-card">
    <Flex direction="row" gap="size-100" alignItems="center" justifyContent="center" marginTop="size-100">
      <ProgressCircle size="S" aria-label="Rendering" isIndeterminate/>
      <Text>Rendering...</Text>
    </Flex>
  </RecordingCard>;

function UnprocessedRecordingCard(
  { recording }: Readonly<{ recording: UnprocessedRecording }>
) {
  const [ busy, rerender ] = useRerender(recording.name);

  return (
    <RecordingCard title={recording.name} testid="unprocessed-card">
      <Text>Postprocessing failed.</Text>
      <ActionButton
        width="100%"
        onPress={rerender}
        isDisabled={busy}
      >
        <Refresh/>
        <Text>Rerender</Text>
      </ActionButton>
      <PurgeButton recordingName={recording.name}/>
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

function PreprocessedRecordingsSectionImpl() {
  const { data, error } = useProcessedRecordings();
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
        data.completed.map(rec =>
          <ProcessedRecordingCard
            key={rec.name}
            user={data.user}
            recording={rec}
          />
        )
      }
      {
        data.rendering.map(rec =>
          <RenderingRecordingCard key={rec.name} recording={rec}/>
        )
      }
      {
        data.unprocessed.map(rec =>
          <UnprocessedRecordingCard key={rec.name} recording={rec}/>
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

  return <PreprocessedRecordingsSectionImpl/>;
}

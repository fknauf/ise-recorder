"use client";

import { useAppSession } from "./SessionProvider";
import { useServerEnv } from "../hooks/useServerEnv";
import { ActionButton, Button, ButtonGroup, Content, Dialog, DialogContainer, Divider, Flex, Heading, InlineAlert, Link, ProgressCircle, Text, useDialogContainer } from "@adobe/react-spectrum";
import Download from "@spectrum-icons/workflow/Download";
import Refresh from "@spectrum-icons/workflow/Refresh";
import Delete from "@spectrum-icons/workflow/Delete";
import { RecordingCard, RecordingCardSection } from "./RecordingCardSection";
import { useProcessedRecordings } from "../hooks/useProcessedRecordings";
import * as z from "zod";
import { DownloadableRecording, assembleDownloadUrl, RenderingRecording, UnprocessedRecording } from "../utils/serverStorage";
import { useState } from "react";
import { showError, showSuccess } from "../utils/notifications";

const mibFormatter = new Intl.NumberFormat(
  "en-us",
  {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false
  }
);

const onRerenderHandler = (
  recordingName: string,
  rerender: (recordingName: string) => Promise<unknown>,
  setBusy: (busy: boolean) => void
) => async () => {
  setBusy(true);
  try {
    await rerender(recordingName);
    showSuccess(`Re-rendering scheduled for ${recordingName}`);
  } catch(e) {
    showError(`Unable to schedule re-rendering for ${recordingName}`, e);
  }
  setBusy(false);
};

function PurgeDialog({ recordingName }: Readonly<{ recordingName: string }>) {
  const { apiUrl } = useServerEnv();
  const { purge } = useProcessedRecordings();

  const { dismiss } = useDialogContainer();

  if(apiUrl === undefined) {
    return null;
  }

  const initiatePurge = async () => {
    dismiss();
    try {
      await purge(recordingName);
      showSuccess(`Purged ${recordingName}`);
    } catch(e) {
      showError(`Failed to purge ${recordingName}`, e);
    }
  };

  return (
    <Dialog size="L">
      <Heading>
        Confirm Purge
      </Heading>
      <Divider/>
      <Content>
        <Text>You are about to permanently delete the recording <strong>{recordingName}</strong> from the server. This cannot be undone. Are you sure?</Text>
      </Content>
      <ButtonGroup>
        <Button variant="secondary" onPress={dismiss} autoFocus data-testid="pd-btn-cancel">Cancel</Button>
        <Button
          variant="negative"
          onPress={initiatePurge}
          data-testid="pd-btn-purge"
        >
          Purge
        </Button>
      </ButtonGroup>
    </Dialog>
  );
}

function ProcessedRecordingCard(
  { user, recording, onPurge }: Readonly<{ user: string; recording: DownloadableRecording; onPurge: () => void }>
) {
  const { apiUrl } = useServerEnv();
  const { rerender } = useProcessedRecordings();
  const [ busy, setBusy ] = useState(false);

  if(apiUrl === undefined) {
    return null;
  }

  const url = assembleDownloadUrl(apiUrl, user, recording.name, recording.totp);

  return (
    <RecordingCard title={recording.name} testid="prec-card">
      <Link
        variant="primary"
        key={recording.name}
        href={url}
        download={true}
        width="100%"
        target="_blank"
      >
        <ActionButton width="100%">
          <Download/>
          <Text>Download ({mibFormatter.format(recording.size / (2 ** 20))} MiB)</Text>
        </ActionButton>
      </Link>

      <ActionButton
        width="100%"
        onPress={onRerenderHandler(recording.name, rerender, setBusy)}
        isDisabled={busy}
        data-testid="prec-btn-rerender"
      >
        <Refresh/>
        <Text>Rerender</Text>
      </ActionButton>

      <ActionButton
        width="100%"
        onPress={() => onPurge()}
        isDisabled={busy}
        data-testid="prec-btn-purge"
      >
        <Delete/>
        <Text>Purge</Text>
      </ActionButton>
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
  { recording, onPurge }: Readonly<{ recording: UnprocessedRecording; onPurge: () => void }>
) {
  const { rerender } = useProcessedRecordings();
  const [ busy, setBusy ] = useState(false);

  return (
    <RecordingCard title={recording.name} testid="unprocessed-card">
      <Text>Postprocessing failed.</Text>
      <ActionButton
        width="100%"
        onPress={onRerenderHandler(recording.name, rerender, setBusy)}
        isDisabled={busy}
        data-testid="prec-btn-rerender"
      >
        <Refresh/>
        <Text>Rerender</Text>
      </ActionButton>
      <ActionButton
        width="100%"
        onPress={onPurge}
        isDisabled={busy}
        data-testid="prec-btn-purge"
      >
        <Delete/>
        <Text>Purge</Text>
      </ActionButton>
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

function ProcessedRecordingsSectionImpl({ id }: Readonly<{ id: string }>) {
  const { data, error } = useProcessedRecordings();
  const sectionTitle = "Server-Side Processed Recordings";
  const [ purgeCandidate, setPurgeCandidate ] = useState<string | null>(null);

  if(error !== undefined) {
    return (
      <RecordingCardSection id={id} title={sectionTitle}>
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

  if(data === undefined || data.completed.length + data.rendering.length + data.unprocessed.length === 0) {
    return null;
  }

  return (
    <RecordingCardSection id={id} title={sectionTitle}>
      <DialogContainer onDismiss={() => setPurgeCandidate(null)}>
        { purgeCandidate !== null && <PurgeDialog recordingName={purgeCandidate}/> }
      </DialogContainer>
      {
        data.completed.map(rec =>
          <ProcessedRecordingCard
            key={rec.name}
            user={data.user}
            recording={rec}
            onPurge={() => setPurgeCandidate(rec.name)}
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
          <UnprocessedRecordingCard
            key={rec.name}
            recording={rec}
            onPurge={() => setPurgeCandidate(rec.name)}
          />
        )
      }
    </RecordingCardSection>
  );
}

export function ProcessedRecordingsSection({ id }: Readonly<{ id: string }>) {
  const { isAuthenticated, isExpired } = useAppSession();
  const { apiUrl } = useServerEnv();

  if(apiUrl === undefined || !isAuthenticated || isExpired) {
    return null;
  }

  return <ProcessedRecordingsSectionImpl id={id}/>;
}

"use client";

import { useAppSession } from "./SessionProvider";
import { useServerEnv } from "../hooks/useServerEnv";
import { ActionButton, ActionGroup, Button, ButtonGroup, Content, Dialog, DialogContainer, Divider, Flex, Heading, InlineAlert, Item, Link, ProgressCircle, Text, useDialogContainer } from "@adobe/react-spectrum";
import Download from "@spectrum-icons/workflow/Download";
import Refresh from "@spectrum-icons/workflow/Refresh";
import Delete from "@spectrum-icons/workflow/Delete";
import { RecordingCard, RecordingCardSection } from "./RecordingCardSection";
import { useServerStorage } from "../hooks/useServerStorage";
import * as z from "zod";
import { DownloadableRecording, downloadHref, ServerStorageRecording, UnfinishedRecording } from "../utils/serverStorage";
import { ReactNode, useState } from "react";
import { showError, showSuccess } from "../utils/notifications";
import { ApiError } from "../utils/apiFetch";

const mibFormatter = new Intl.NumberFormat(
  "en-us",
  {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false
  }
);

function prettifyError(error: unknown) {
  if(error instanceof ApiError && error.cause instanceof z.ZodError) {
    return z.prettifyError(error.cause);
  }

  if(error instanceof Error) {
    return error.message;
  }

  return "unknown error";
}

function PurgeDialog({ recordingName }: Readonly<{ recordingName: string }>) {
  const { apiUrl } = useServerEnv();
  const { purge } = useServerStorage();

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
        <Button
          variant="secondary"
          onPress={dismiss}
          autoFocus
          data-testid="pd-btn-cancel"
        >
          Cancel
        </Button>
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

function ActionableRecordingCard(
  { recordingName, testid, onPurge, children }:
  Readonly<{
    recordingName: string
    testid: string
    onPurge: (recordingName: string) => void
    children: ReactNode
  }>
) {
  const { apiUrl } = useServerEnv();
  const { rerender } = useServerStorage();
  const [ busy, setBusy ] = useState(false);

  if(apiUrl === undefined) {
    return null;
  }

  const onRerender = async () => {
    setBusy(true);
    try {
      await rerender(recordingName);
      showSuccess(`Re-rendering scheduled for ${recordingName}`);
    } catch(e) {
      showError(`Unable to schedule re-rendering for ${recordingName}`, e);
    }
    setBusy(false);
  };

  return (
    <RecordingCard title={recordingName} testid={testid}>
      {children}

      <ActionGroup
        minWidth="size-3000"
        isJustified={true}
        disabledKeys={busy ? [ "rerender", "purge" ] : []}
        onAction={key => {
          if(key === "rerender") {
            onRerender();
          } else if(key === "purge") {
            onPurge(recordingName);
          }
        }}
      >
        <Item key="rerender" data-testid="prec-btn-rerender">
          <Refresh/>
          <Text>Rerender</Text>
        </Item>

        <Item key="purge" data-testid="prec-btn-purge">
          <Delete/>
          <Text>Purge</Text>
        </Item>
      </ActionGroup>
    </RecordingCard>
  );
}

function ProcessedRecordingCard(
  { recording, onPurge }: Readonly<{
    recording: DownloadableRecording
    onPurge: (recordingName: string) => void
  }>
) {
  const { apiUrl } = useServerEnv();

  if(apiUrl === undefined) {
    return null;
  }

  const url = downloadHref(apiUrl, recording);

  return (
    <ActionableRecordingCard
      recordingName={recording.name}
      onPurge={onPurge}
      testid="prec-card"
    >
      <Link
        variant="primary"
        key={recording.name}
        href={url}
        download={true}
        width="100%"
        target="_blank"
      >
        <ActionButton width="100%" isQuiet>
          <Download/>
          <Text>Download ({mibFormatter.format(recording.size / (2 ** 20))} MiB)</Text>
        </ActionButton>
      </Link>
    </ActionableRecordingCard>
  );
}

const RenderingRecordingCard = (
  { recording }: Readonly<{ recording: UnfinishedRecording }>
) =>
  <RecordingCard title={recording.name} testid="rendering-card">
    <Flex
      direction="row"
      gap="size-100"
      alignItems="center"
      justifyContent="center"
      height="100%"
    >
      <ProgressCircle size="S" aria-label="Rendering" isIndeterminate/>
      <Text>Rendering...</Text>
    </Flex>
  </RecordingCard>;

function UnprocessedRecordingCard(
  { recording, onPurge }: Readonly<{ recording: UnfinishedRecording; onPurge: (recordingName: string) => void }>
) {
  return (
    <ActionableRecordingCard
      recordingName={recording.name}
      onPurge={onPurge}
      testid="unprocessed-card"
    >
      <Text marginTop="size-50">Postprocessing failed.</Text>
    </ActionableRecordingCard>
  );
}

function AnyRecordingCard(
  { recording, onPurge }:
  Readonly<{
    recording: ServerStorageRecording
    onPurge: (recordingName: string) => void
  }>
) {
  if(recording.state === "completed") {
    return <ProcessedRecordingCard recording={recording} onPurge={onPurge}/>;
  } else if(recording.state === "rendering") {
    return <RenderingRecordingCard recording={recording}/>;
  } else if(recording.state === "unprocessed") {
    return <UnprocessedRecordingCard recording={recording} onPurge={onPurge}/>;
  }

  return null;
}

function ServerStorageSectionImpl({ id }: Readonly<{ id: string }>) {
  const { data, error } = useServerStorage();
  const [ purgeCandidate, setPurgeCandidate ] = useState<string | null>(null);

  const sectionTitle = "Server-Side Processed Recordings";

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

  if(data === undefined || data.length === 0) {
    return null;
  }

  return (
    <RecordingCardSection id={id} title={sectionTitle}>
      <DialogContainer onDismiss={() => setPurgeCandidate(null)}>
        { purgeCandidate !== null && <PurgeDialog recordingName={purgeCandidate}/> }
      </DialogContainer>
      {
        data.map(rec => <AnyRecordingCard key={rec.name} recording={rec} onPurge={setPurgeCandidate}/>)
      }
    </RecordingCardSection>
  );
}

export function ServerStorageSection({ id }: Readonly<{ id: string }>) {
  const { isAuthenticated, isExpired } = useAppSession();
  const { apiUrl } = useServerEnv();

  if(apiUrl === undefined || !isAuthenticated || isExpired) {
    return null;
  }

  return <ServerStorageSectionImpl id={id}/>;
}

"use client";

import { useAppSession } from "./SessionProvider";
import { useServerEnv } from "../hooks/useServerEnv";
import { RecordingCard, RecordingCardSection } from "./RecordingCardSection";
import { useServerStorage } from "../hooks/useServerStorage";
import * as z from "zod";
import { DownloadableRecording, downloadHref, ServerStorageRecording, UnfinishedRecording } from "../utils/serverStorage";
import { ReactNode, useState } from "react";
import { showError, showSuccess } from "../utils/notifications";
import { ApiError } from "../utils/apiFetch";
import { modals } from "@mantine/modals";
import { Alert, Button, Group, Loader, Text, ThemeIcon } from "@mantine/core";
import { DownloadIcon, RepeatIcon, TrashIcon, WarningIcon, CloudIcon, WarningOctagonIcon } from "@phosphor-icons/react";

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

function confirmPurge(
  recordingName: string,
  onConfirm: () => void,
  onCancel: () => void = () => {}
) {
  modals.openConfirmModal({
    title: "Confirm Purge",
    children:
      <Group wrap="nowrap" align="flex-start">
        <ThemeIcon variant="outline" color="warning" size="lg" radius="xl">
          <WarningIcon/>
        </ThemeIcon>
        <Text>
          You are about to permanently delete the recording <strong>{recordingName}</strong> from the server.
          This cannot be undone. Are you sure?
        </Text>
      </Group>,
    labels: {
      confirm: "Purge",
      cancel: "Cancel"
    },
    confirmProps: { "data-testid": "ss-btn-purgeconfirm", "color": "error" },
    cancelProps: { "data-testid": "ss-btn-purgecancel", "data-autofocus": true },
    onConfirm,
    onCancel,
    centered: true,
    size: "lg"
  });
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

      <Group>
        <Button
          flex="1 1 0"
          miw="max-content"
          data-testid="ss-btn-rerender"
          disabled={busy}
          onClick={onRerender}
          leftSection={<RepeatIcon/>}
          variant="outline"
        >
          Rerender
        </Button>
        <Button
          flex="1 1 0"
          miw="max-content"
          data-testid="ss-btn-purge"
          disabled={busy}
          onClick={() => confirmPurge(recordingName, () => onPurge(recordingName))}
          leftSection={<TrashIcon/>}
          color="warning"
          variant="outline"
        >
          Purge
        </Button>
      </Group>
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
      testid="ss-card-completed"
    >
      <Button
        component="a"
        download
        key={recording.name}
        href={url}
        w="100%"
        target="_blank"
        leftSection={<DownloadIcon/>}
      >
        Download ({mibFormatter.format(recording.size / (2 ** 20))} MiB)
      </Button>
    </ActionableRecordingCard>
  );
}

const RenderingRecordingCard = (
  { recording }: Readonly<{ recording: UnfinishedRecording }>
) =>
  <RecordingCard title={recording.name} testid="ss-card-rendering">
    <Group align="center" justify="center" h="100%">
      <Loader role="progressbar" aria-label="Rendering"/>
      <Text>Rendering...</Text>
    </Group>
  </RecordingCard>;

function UnprocessedRecordingCard(
  { recording, onPurge }: Readonly<{ recording: UnfinishedRecording; onPurge: (recordingName: string) => void }>
) {
  return (
    <ActionableRecordingCard
      recordingName={recording.name}
      onPurge={onPurge}
      testid="ss-card-unprocessed"
    >
      <Text>Postprocessing failed.</Text>
    </ActionableRecordingCard>
  );
}

function AnyRecordingCard(
  { recording }:
  Readonly<{
    recording: ServerStorageRecording
  }>
) {
  const { purge } = useServerStorage();

  const onPurge = async () => {
    try {
      await purge(recording.name);
      showSuccess(`Purged ${recording.name}`);
    } catch(e) {
      showError(`Failed to purge ${recording.name}`, e);
    }
  };

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

  const sectionTitle = "Server-Side Processed Recordings";

  if(error !== undefined) {
    return (
      <RecordingCardSection id={id} title={sectionTitle}>
        <Alert variant="light" color="error" icon={<WarningOctagonIcon/>} title="Error fetching list of processed recordings">
          {prettifyError(error)}
        </Alert>
      </RecordingCardSection>
    );
  }

  if(data === undefined || data.length === 0) {
    return null;
  }

  return (
    <RecordingCardSection id={id} title={sectionTitle} icon={<CloudIcon/>}>
      {
        data.map(rec => <AnyRecordingCard key={rec.name} recording={rec}/>)
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

  return (
    <ServerStorageSectionImpl id={id}/>
  );
}

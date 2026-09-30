"use client";

import { useAppSession } from "./SessionProvider";
import { useServerEnv } from "../hooks/useServerEnv";
import { ActionButton, Button, ButtonGroup, Content, Dialog, DialogContainer, Divider, Flex, Heading, InlineAlert, Link, ProgressCircle, Text, useDialogContainer } from "@adobe/react-spectrum";
import Download from "@spectrum-icons/workflow/Download";
import Refresh from "@spectrum-icons/workflow/Refresh";
import Delete from "@spectrum-icons/workflow/Delete";
import { RecordingCard, RecordingCardSection } from "./RecordingCardSection";
import { useProcessedRecordings, useRefreshProcessedRecordings } from "../hooks/useProcessedRecordings";
import * as z from "zod";
import { DownloadableRecording, downloadUrl, purgeRecording, RenderingRecording, schedulePostprocessing, UnprocessedRecording } from "../utils/serverStorage";
import { useLecture } from "../hooks/useLecture";
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

const useRerender = (recordingName: string) => {
  const { apiUrl } = useServerEnv();
  const { getAccessToken } = useAppSession();
  const { lecturerEmail } = useLecture();
  const refreshProcessedRecordings = useRefreshProcessedRecordings();
  const [ busy, setBusy ] = useState(false);

  const rerender = async () => {
    setBusy(true);

    try {
      await schedulePostprocessing(
        { apiUrl, getAccessToken },
        recordingName,
        lecturerEmail,
        { retries: 0, initialWaitMillis: 5000 }
      );

      await refreshProcessedRecordings();
    } catch(e) {
      console.warn(`Failed to schedule re-render for ${recordingName}`, e);
    }

    setBusy(false);
  };

  return [ busy, rerender ] as const;
};

function PurgeDialog({ recordingName }: Readonly<{ recordingName: string }>) {
  const { apiUrl } = useServerEnv();
  const { getAccessToken } = useAppSession();
  const { mutate } = useProcessedRecordings();

  const { dismiss } = useDialogContainer();
  const [ busy, setBusy ] = useState(false);

  if(apiUrl === undefined) {
    return null;
  }

  const initiatePurge = async () => {
    setBusy(true);
    await mutate(
      async () => {
        const result = await purgeRecording(apiUrl, recordingName, getAccessToken);

        if(result.message !== undefined) {
          if(result.status === "ok") {
            showSuccess(result.message);
          } else {
            showError(result.message);
            throw new Error(result.message);
          }
        }

        return undefined;
      }, {
        optimisticData: current => {
          if(current === undefined) {
            return undefined;
          }

          return {
            ...current,
            completed: current.completed.filter(rec => rec.name !== recordingName),
            unprocessed: current.unprocessed.filter(rec => rec.name !== recordingName),
            rendering: current.rendering.filter(rec => rec.name !== recordingName)
          };
        },
        rollbackOnError: true,
        revalidate: true,
        throwOnError: false,
        populateCache: false
      }
    );


    setBusy(false);
    dismiss();
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
        <Button isDisabled={busy} variant="secondary" onPress={dismiss} autoFocus data-testid="pd-btn-cancel">Cancel</Button>
        <Button
          isDisabled={busy}
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
        target="_blank"
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
        data-testid="prec-btn-rerender"
      >
        <Refresh/>
        <Text>Rerender</Text>
      </ActionButton>

      <ActionButton width="100%" onPress={() => onPurge()} data-testid="prec-btn-purge">
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
  const [ busy, rerender ] = useRerender(recording.name);

  return (
    <RecordingCard title={recording.name} testid="unprocessed-card">
      <Text>Postprocessing failed.</Text>
      <ActionButton
        width="100%"
        onPress={rerender}
        isDisabled={busy}
        data-testid="prec-btn-rerender"
      >
        <Refresh/>
        <Text>Rerender</Text>
      </ActionButton>
      <ActionButton width="100%" onPress={onPurge} data-testid="prec-btn-purge">
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

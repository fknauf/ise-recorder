"use client";

import { Button, Group, RingProgress, Stack, Text, ThemeIcon } from "@mantine/core";
import { modals } from "@mantine/modals";
import { TrashIcon, DownloadIcon, CloudArrowUpIcon, WarningIcon, BrowserIcon } from "@phosphor-icons/react";
import { downloadFile, RecordingFileList } from "../utils/browserStorage";
import { useBrowserStorage } from "../hooks/useBrowserStorage";
import { useReupload } from "../hooks/useReupload";
import { useActiveRecording } from "../hooks/useActiveRecording";
import { RecordingCard, RecordingCardSection } from "./RecordingCardSection";
import { useServerEnv } from "../hooks/useServerEnv";
import { useAppSession } from "./SessionProvider";
import { useAppStore } from "../hooks/useAppStore";
import { showError } from "../utils/notifications";

const mibFormatter = new Intl.NumberFormat(
  "en-us",
  {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false
  }
);

function confirmDelete(
  recordingName: string,
  onConfirm: () => void,
  onCancel: () => void = () => {}
) {
  modals.openConfirmModal({
    title: "Confirm Delete",
    children:
      <Group wrap="nowrap" align="flex-start">
        <ThemeIcon variant="outline" color="warning" size="lg" radius="xl">
          <WarningIcon/>
        </ThemeIcon>
        <Text>
          You are about to delete the raw recording <strong>{recordingName}</strong> from your browser.
          This recording has not been uploaded to the backend. Are you sure?
        </Text>
      </Group>,
    labels: {
      confirm: "Delete",
      cancel: "Cancel"
    },
    confirmProps: { "data-testid": "bs-btn-deleteconfirm", "color": "error" },
    cancelProps: { "data-testid": "bs-btn-deletecancel", "data-autofocus": true },
    onConfirm,
    onCancel,
    centered: true,
    size: "lg"
  });
}

function SavedRecordingCard({ recording, onDelete }: Readonly<{ recording: RecordingFileList; onDelete: (recordingName: string) => void }>) {
  const { apiUrl } = useServerEnv();
  const activeRecording = useActiveRecording();
  const { isUploading, progress, reupload } = useReupload(recording.name);
  const { authRequired, isAuthenticated } = useAppSession();

  const isRecording = recording.name === activeRecording.name;

  const uploadDisabled = isRecording || isUploading || (authRequired && !isAuthenticated);
  const deleteDisabled = isRecording || isUploading;

  const onDownload = async (filename: string) => {
    try {
      await downloadFile(recording.name, filename);
    } catch(e) {
      showError(`Failed download of ${recording.name}/${filename}`, e);
    }
  };

  return (
    <RecordingCard
      title={recording.name}
      testid="bs-card-recording"
    >
      <Button.Group orientation="vertical">
        {
          recording.files.map(({ name, size }) =>
            <Button
              key={`download-${name}`}
              disabled={isRecording}
              onClick={() => onDownload(name)}
              data-testid="bs-btn-download"
              leftSection={<DownloadIcon/>}
            >
              {name} {size !== undefined && `(${mibFormatter.format(size / 2 ** 20)} MiB)`}
            </Button>
          )
        }
      </Button.Group>
      {
        isUploading
          ? <Group
              justify="center"
              align="center"
              data-testid="bs-ind-uploading"
              h={36}
              gap="xs"
            >
              <RingProgress
                size={38}
                thickness={4}
                sections={[{ value: progress ?? 0, color: "info" }]}
                role="progressbar"
                aria-label="Uploading"
                aria-valuenow={progress}
                aria-valuemin={0}
                aria-valuemax={100}
              />
              <Text>Uploading...</Text>
            </Group>
          : <Group justify="center" wrap="nowrap">
              {
                apiUrl !== undefined
                  ? <Button
                      key="upload"
                      data-testid="bs-btn-reupload"
                      onClick={reupload}
                      disabled={uploadDisabled}
                      leftSection={<CloudArrowUpIcon/>}
                      variant="outline"
                    >
                    Re-upload
                    </Button>
                  : null
              }
              <Button
                key="delete"
                data-testid="bs-btn-delete"
                onClick={() => onDelete(recording.name)}
                disabled={deleteDisabled}
                leftSection={<TrashIcon/>}
                color="warning"
                variant="outline"
              >
                Delete
              </Button>
            </Group>
      }
    </RecordingCard>
  );
}

/**
 * Section on the main page showing all saved recordings.
 *
 * Shows download buttons for the individual files and a remove button for the whole recording.
 * Buttons are disabled for the currently active recording.
 */
export function BrowserStorageSection({ id }: Readonly<{ id: string }>) {
  const { removeSavedRecording, savedRecordings } = useBrowserStorage();
  const unstreamedRecordings = useAppStore(state => state.unstreamedRecordings);

  if(savedRecordings.length === 0) {
    return null;
  }

  const doDeleteRecording = async (recordingName: string) => {
    try {
      await removeSavedRecording(recordingName);
    } catch(e) {
      showError(`Failed to delete ${recordingName}`, e);
    }
  };

  const onDelete = async (recordingName: string) => {
    if(unstreamedRecordings.includes(recordingName)) {
      confirmDelete(recordingName, () => doDeleteRecording(recordingName));
    } else {
      await doDeleteRecording(recordingName);
    }
  };

  return (
    <RecordingCardSection id={id} title="Browser-Local Raw Recordings" icon={<BrowserIcon/>}>
      {
        savedRecordings.map(rec =>
          <SavedRecordingCard
            key={`saved-recording-${rec.name}`}
            recording={rec}
            onDelete={onDelete}
          />
        )
      }
    </RecordingCardSection>
  );
}

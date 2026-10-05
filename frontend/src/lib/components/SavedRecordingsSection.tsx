"use client";

import { ActionButton, ActionGroup, Button, ButtonGroup, Content, Dialog, DialogContainer, Divider, Flex, Heading, Item, ProgressCircle, Text, useDialogContainer } from "@adobe/react-spectrum";
import Delete from "@spectrum-icons/workflow/Delete";
import Download from "@spectrum-icons/workflow/Download";
import DataUpload from "@spectrum-icons/workflow/DataUpload";
import { downloadFile, RecordingFileList } from "../utils/browserStorage";
import { useBrowserStorage } from "../hooks/useBrowserStorage";
import { useReupload } from "../hooks/useReupload";
import { useActiveRecording } from "../hooks/useActiveRecording";
import { RecordingCard, RecordingCardSection } from "./RecordingCardSection";
import { useServerEnv } from "../hooks/useServerEnv";
import { useAppSession } from "./SessionProvider";
import { useState } from "react";
import { useAppStore } from "../hooks/useAppStore";

const mibFormatter = new Intl.NumberFormat(
  "en-us",
  {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false
  }
);

function DeleteDialog({ recordingName }: Readonly<{ recordingName: string }>) {
  const { dismiss } = useDialogContainer();
  const { removeSavedRecording } = useBrowserStorage();

  return (
    <Dialog size="L">
      <Heading>
        Confirm Delete
      </Heading>
      <Divider/>
      <Content>
        <Text>You are about to delete the raw recording <strong>{recordingName}</strong> from your browser. This recording has not been uploaded to the backend. Are you sure?</Text>
      </Content>
      <ButtonGroup>
        <Button
          variant="secondary"
          onPress={dismiss}
          autoFocus
          data-testid="sr-dd-btn-cancel"
        >
          Cancel
        </Button>
        <Button
          variant="negative"
          onPress={() => {
            dismiss();
            removeSavedRecording(recordingName);
          }}
          data-testid="sr-dd-btn-delete"
        >
          Delete
        </Button>
      </ButtonGroup>
    </Dialog>
  );
}

function SavedRecordingCard({ recording, onDelete }: Readonly<{ recording: RecordingFileList; onDelete: (recordingName: string) => void }>) {
  const { apiUrl } = useServerEnv();
  const activeRecording = useActiveRecording();
  const { isUploading, progress, reupload } = useReupload(recording.name);
  const { authRequired, isAuthenticated } = useAppSession();

  const isRecording = recording.name === activeRecording.name;

  const uploadDisabled = isRecording || isUploading || (authRequired && !isAuthenticated);
  const deleteDisabled = isRecording || isUploading;

  return (
    <RecordingCard
      title={recording.name}
      testid="sr-card"
    >
      <Flex
        direction="column"
        gap="size-100"
      >
        {
          recording.files.map(({ name, size }) =>
            <ActionButton
              key={`download-${name}`}
              isDisabled={isRecording}
              onPress={() => downloadFile(recording.name, name)}
              data-testid="sr-btn-download"
              isQuiet
            >
              <Download/>
              <Text>Download {name} {size !== undefined && `(${mibFormatter.format(size / 2 ** 20)} MiB)`}</Text>
            </ActionButton>
          )
        }
      </Flex>
      {
        isUploading
          ? <Flex
              direction="row"
              gap="size-100"
              justifyContent="center"
              alignItems="center"
              height="size-900"
              data-testid="sr-ind-uploading"
            >
              <ProgressCircle size="M" value={progress} aria-label="Uploading"/>
              <Text>Uploading...</Text>
            </Flex>
          : <ActionGroup
              isJustified={true}
              disabledKeys={[
                ...uploadDisabled ? [ "upload" ] : [],
                ...deleteDisabled ? [ "delete" ] : []
              ]}
              onAction={key => {
                if(key === "upload") {
                  reupload();
                } else if(key === "delete") {
                  onDelete(recording.name);
                }
              }}
            >
              {
                apiUrl !== undefined
                  ? <Item key="upload" data-testid="sr-btn-reupload">
                      <DataUpload/>
                      <Text>Re-upload</Text>
                    </Item>
                  : null
              }
              <Item key="delete" data-testid="sr-btn-remove">
                <Delete/>
                <Text>Delete</Text>
              </Item>
            </ActionGroup>
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
export function SavedRecordingsSection({ id }: Readonly<{ id: string }>) {
  const { removeSavedRecording, savedRecordings } = useBrowserStorage();
  const [ deleteCandidate, setDeleteCandidate ] = useState<string | null>(null);
  const unstreamedRecordings = useAppStore(state => state.unstreamedRecordings);

  if(savedRecordings.length === 0) {
    return null;
  }

  const onDelete = (recordingName: string) => {
    if(unstreamedRecordings.includes(recordingName)) {
      setDeleteCandidate(recordingName);
    } else {
      removeSavedRecording(recordingName);
    }
  };

  return (
    <RecordingCardSection id={id} title="Browser-Local Raw Recordings">
      <DialogContainer onDismiss={() => setDeleteCandidate(null)}>
        { deleteCandidate !== null && <DeleteDialog recordingName={deleteCandidate}/> }
      </DialogContainer>
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

"use client";

import { ActionButton, Flex, ProgressCircle, Text, View } from "@adobe/react-spectrum";
import Delete from "@spectrum-icons/workflow/Delete";
import Download from "@spectrum-icons/workflow/Download";
import DataUpload from "@spectrum-icons/workflow/DataUpload";
import { downloadFile, RecordingFileList } from "../utils/browserStorage";
import { useBrowserStorage, useReuploadSavedRecording } from "../hooks/useBrowserStorage";
import { useActiveRecording } from "../hooks/useActiveRecording";
import { RecordingCard, RecordingCardSection } from "./RecordingCardSection";
import { useAppStore } from "../hooks/useAppStore";
import { useServerEnv } from "../hooks/useServerEnv";

const mibFormatter = new Intl.NumberFormat(
  "en-us",
  {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false
  }
);

function SavedRecordingCard({ recording }: Readonly<{ recording: RecordingFileList }>) {
  const { apiUrl } = useServerEnv();
  const activeRecording = useActiveRecording();

  const { removeSavedRecording } = useBrowserStorage();

  const reuploadSavedRecording = useReuploadSavedRecording();
  const reuploadProgress = useAppStore(state => state.reuploadProgress.get(recording.name));

  const isRecording = recording.name === activeRecording.name;
  const isUploading = reuploadProgress !== undefined;

  return (
    <RecordingCard
      title={recording.name}
      testid="sr-card"
    >
      {
        recording.files.map(({ name, size }) =>
          <ActionButton
            key={`download-${name}`}
            isDisabled={isRecording}
            onPress={() => downloadFile(recording.name, name)}
          >
            <Download/>
            <Text>Download {name} {size !== undefined && `(${mibFormatter.format(size / 2 ** 20)} MiB)`}</Text>
          </ActionButton>
        )
      }
      {
        isUploading
          ? <Flex
              direction="row"
              gap="size-100"
              justifyContent="center"
              alignItems="center"
              height="size-900"
            >
              <ProgressCircle size="M" value={reuploadProgress} aria-label="Uploading"/>
              <Text>Uploading...</Text>
            </Flex>
          : <>
              <ActionButton
                isDisabled={isRecording || isUploading}
                onPress={() => removeSavedRecording(recording.name)}
              >
                <Delete/>
                <Text>Remove</Text>
              </ActionButton>
              {
                apiUrl !== undefined &&
                  <ActionButton
                    isDisabled={isRecording || isUploading}
                    onPress={() => reuploadSavedRecording(recording.name)}
                  >
                    <DataUpload/>
                    <Text>Re-upload manually</Text>
                  </ActionButton>
              }
            </>
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
export function SavedRecordingsSection() {
  const { savedRecordings } = useBrowserStorage();

  if(savedRecordings.length === 0) {
    return null;
  }

  return (
    <RecordingCardSection title="Browser-Local Raw Recordings">
      {
        savedRecordings.map(rec =>
          <SavedRecordingCard
            key={`saved-recording-${rec.name}`}
            recording={rec}
          />
        )
      }
    </RecordingCardSection>
  );
}

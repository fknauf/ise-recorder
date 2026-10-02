"use client";

import { ActionButton, Flex, ProgressCircle, Text } from "@adobe/react-spectrum";
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
  const { isUploading, progress, reupload } = useReupload(recording.name);
  const { authRequired, isAuthenticated } = useAppSession();

  const isRecording = recording.name === activeRecording.name;

  return (
    <RecordingCard
      title={recording.name}
      testid="sr-card"
    >
      <Flex
        direction="column"
        gap="size-100"
        height="100%"
        justifyContent="space-between"
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
            : <Flex direction="column" gap="size-100">
                {
                  apiUrl !== undefined &&
                    <ActionButton
                      isDisabled={isRecording || isUploading || (authRequired && !isAuthenticated)}
                      onPress={reupload}
                      data-testid="sr-btn-reupload"
                    >
                      <DataUpload/>
                      <Text>Re-upload</Text>
                    </ActionButton>
                }
                <ActionButton
                  isDisabled={isRecording || isUploading}
                  onPress={() => removeSavedRecording(recording.name)}
                  data-testid="sr-btn-remove"
                >
                  <Delete/>
                  <Text>Delete</Text>
                </ActionButton>
              </Flex>
        }
      </Flex>
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
  const { savedRecordings } = useBrowserStorage();

  if(savedRecordings.length === 0) {
    return null;
  }

  return (
    <RecordingCardSection id={id} title="Browser-Local Raw Recordings">
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

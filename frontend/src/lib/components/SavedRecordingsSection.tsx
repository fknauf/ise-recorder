"use client";

import { ActionButton, Text } from "@adobe/react-spectrum";
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

/**
 * Section on the main page showing all saved recordings.
 *
 * Shows download buttons for the individual files and a remove button for the whole recording.
 * Buttons are disabled for the currently active recording.
 */
export function SavedRecordingsSection() {
  const { apiUrl } = useServerEnv();
  const activeRecording = useActiveRecording();

  const {
    savedRecordings,
    removeSavedRecording
  } = useBrowserStorage();

  const reuploadSavedRecording = useReuploadSavedRecording();
  const manuallyUploading = useAppStore(state => state.manuallyUploading);

  const isDisabled = (r: RecordingFileList) => r.name === activeRecording.name;

  if(savedRecordings.length === 0) {
    return null;
  }

  return (
    <RecordingCardSection title="Browser-Local Raw Recordings">
      {
        savedRecordings.map(rec =>
          <RecordingCard
            title={rec.name}
            key={`saved-recording-${rec.name}`}
            testid="sr-card"
          >
            {
              rec.files.map(({ name: filename, size }) =>
                <ActionButton
                  key={`download-${filename}`}
                  isDisabled={isDisabled(rec)}
                  onPress={() => downloadFile(rec.name, filename)}
                >
                  <Download/>
                  <Text>Download {filename} {size !== undefined && `(${mibFormatter.format(size / 2 ** 20)} MiB)`}</Text>
                </ActionButton>
              )
            }
            <ActionButton
              isDisabled={isDisabled(rec)}
              onPress={() => removeSavedRecording(rec.name)}
            >
              <Delete/>
              <Text>Remove</Text>
            </ActionButton>
            {
              apiUrl !== undefined &&
              <ActionButton
                isDisabled={isDisabled(rec) || manuallyUploading.includes(rec.name)}
                onPress={() => reuploadSavedRecording(rec.name)}
              >
                <DataUpload/>
                <Text>Re-upload manually</Text>
              </ActionButton>
            }
          </RecordingCard>
        )
      }
    </RecordingCardSection>
  );
}

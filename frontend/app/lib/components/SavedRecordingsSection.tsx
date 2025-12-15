"use client";

import { ActionButton, Flex, Text, View } from "@adobe/react-spectrum";
import Delete from "@spectrum-icons/workflow/Delete";
import Download from "@spectrum-icons/workflow/Download";
import { downloadFile, RecordingFileList } from "../utils/browserStorage";
import { useBrowserStorage } from "../hooks/useBrowserStorage";
import { useActiveRecording } from "../hooks/useActiveRecording";

/**
 * Section on the main page showing all saved recordings.
 *
 * Shows download buttons for the individual files and a remove button for the whole recording.
 * Buttons are disabled for the currently active recording.
 */
export function SavedRecordingsSection() {
  const activeRecording = useActiveRecording();

  const {
    savedRecordings,
    removeSavedRecording
  } = useBrowserStorage();

  const formatter = new Intl.NumberFormat("en-us", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const isDisabled = (r: RecordingFileList) => r.name === activeRecording.name;

  return (
    <Flex direction="row" gap="size-100" wrap>
      {
        savedRecordings.map(rec =>
          <View
            key={`saved-recording-${rec.name}`}
            borderWidth="thin"
            borderColor="light"
            borderRadius="medium"
            padding="size-100"
            data-testid="sr-card"
          >
            <Flex direction="column" justifyContent="center" gap="size-100">
              <Text>{rec.name}</Text>
              {
                rec.files.map(({ name: filename, size }) =>
                  <ActionButton
                    key={`download-${filename}`}
                    isDisabled={isDisabled(rec)}
                    onPress={() => downloadFile(rec.name, filename)}
                  >
                    <Download/>
                    <Text>Download {filename} {size !== undefined && `(${formatter.format(size / 2 ** 20)} MiB)`}</Text>
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
            </Flex>
          </View>
        )
      }
    </Flex>
  );
}

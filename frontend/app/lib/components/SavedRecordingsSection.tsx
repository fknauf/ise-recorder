"use client";

import { ActionButton, Flex, Text, View } from "@adobe/react-spectrum";
import Delete from "@spectrum-icons/workflow/Delete";
import Download from "@spectrum-icons/workflow/Download";
import { RecordingFileList } from "../utils/filesystem";

interface SavedRecordingsCardProps {
  recording: RecordingFileList
  isDisabled: boolean
  onRemoved: () => void
  onDownload: (filename: string) => void
}

/**
 * Card showing a saved recording with download and delete buttons.
 *
 * Buttons are disabled if the recording it shows is currently being recorded.
 */
function SavedRecordingsCard(
  { recording, isDisabled, onRemoved, onDownload }: Readonly<SavedRecordingsCardProps>
) {
  const formatter = new Intl.NumberFormat("en-us", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <View
      borderWidth="thin"
      borderColor="light"
      borderRadius="medium"
      padding="size-100"
    >
      <Flex direction="column" justifyContent="center" gap="size-100">
        <Text>{recording.name}</Text>
        {
          recording.files.map(({ name: filename, size }) =>
            <ActionButton
              key={`download-${filename}`}
              isDisabled={isDisabled}
              onPress={() => onDownload(filename)}
            >
              <Download/>
              <Text>Download {filename} {size !== undefined && `(${formatter.format(size / 2 ** 20)} MiB)`}</Text>
            </ActionButton>
          )
        }
        <ActionButton
          isDisabled={isDisabled}
          onPress={onRemoved}
        >
          <Delete/>
          <Text>Remove</Text>
        </ActionButton>
      </Flex>
    </View>
  );
}

export interface SavedRecordingsSectionProps {
  recordings: RecordingFileList[]
  activeRecordingName?: string
  onRemoved: (recording: string) => void
  onDownload: (recording: string, filename: string) => void
}

/**
 * Section on the main page showing all saved recordings.
 */
export const SavedRecordingsSection = (
  { recordings, activeRecordingName, onRemoved, onDownload }: Readonly<SavedRecordingsSectionProps>
) =>
  <Flex direction="row" gap="size-100" wrap>
    {
      recordings.map(r =>
        <SavedRecordingsCard
          key={`saved-recording-${r.name}`}
          recording={r}
          isDisabled={r.name === activeRecordingName}
          onRemoved={() => onRemoved(r.name)}
          onDownload={filename => onDownload(r.name, filename)}
        />
      )
    }
  </Flex>;

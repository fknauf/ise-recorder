'use client';

import { ActionButton, Flex, Text, View } from "@adobe/react-spectrum";
import Delete from '@spectrum-icons/workflow/Delete';
import Download from '@spectrum-icons/workflow/Download';
import { readRecordingFile, deleteRecording, RecordingFileList } from "../utils/filesystem";

async function downloadFile(dir: string, filename: string) {
  // This is a bit hacky, but I haven't been able to come up with a cleaner
  // way. Read file, create an object url for it, temporarly append a link
  // to the document, click it programmatically and remove it again.
  //
  // It might be prudent to switch this to the File System Access API once
  // that is widely available.

  const file = await readRecordingFile(dir, filename);
  const url = URL.createObjectURL(file);

  try {
    const link = document.createElement('a');

    link.href = url;
    link.download = filename;
    link.rel = "noopener"
    link.hidden = true;

    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface SavedRecordingsCardProps {
  recording: RecordingFileList,
  isBeingRecorded: boolean,
  onRemoved: () => void
}

/**
 * Card showing a saved recording with download and delete buttons.
 *
 * Buttons are disabled if the recording it shows is currently being recorded.
 */
function SavedRecordingsCard(
  { recording, isBeingRecorded, onRemoved }: Readonly<SavedRecordingsCardProps>
) {
  const formatter = new Intl.NumberFormat('en-us', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
          recording.fileinfos.map(({ filename, size }) =>
            <ActionButton
            key={`download-${filename}`}
            isDisabled={isBeingRecorded}
            onPress={() => downloadFile(recording.name, filename)}
          >
              <Download/>
              <Text>Download {filename} {size !== undefined && `(${formatter.format(size / 2 ** 20)} MiB)`}</Text>
            </ActionButton>
          )
        }
        <ActionButton
          isDisabled={isBeingRecorded}
          onPress={() => { deleteRecording(recording.name).then(() => onRemoved()) }}
        >
          <Delete/>
          <Text>Remove</Text>
        </ActionButton>
      </Flex>
    </View>
  );
}

export interface SavedRecordingsSectionProps {
  recordings: RecordingFileList[],
  activeRecordingName?: string,
  onRemoved: () => void
}

/**
 * Section on the main page showing all saved recordings.
 */
export const SavedRecordingsSection = (
  { recordings, activeRecordingName, onRemoved }: Readonly<SavedRecordingsSectionProps>
) =>
  <Flex direction="row" gap="size-100" wrap>
    {
      recordings.map(r =>
        <SavedRecordingsCard
          key={`saved-recording-${r.name}`}
          recording={r}
          isBeingRecorded={r.name === activeRecordingName}
          onRemoved={onRemoved}
        />
      )
    }
  </Flex>

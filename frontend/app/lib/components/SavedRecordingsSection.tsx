'use client';

import { ActionButton, Flex, Text, View } from "@adobe/react-spectrum";
import Delete from '@spectrum-icons/workflow/Delete';
import Download from '@spectrum-icons/workflow/Download';
import { readRecordingFile, deleteRecording, RecordingFileList } from "../utils/filesystem";

async function downloadFile(dir: string, filename: string) {
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

function SavedRecordingsCard(
  { recording, isBeingRecorded, onRemoved }: SavedRecordingsCardProps
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

export const SavedRecordingsSection = (
  { recordings, activeRecordingName, onRemoved }: SavedRecordingsSectionProps
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

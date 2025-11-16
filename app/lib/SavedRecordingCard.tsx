
import { ActionButton, Flex, Text, View } from "@adobe/react-spectrum";
import Delete from '@spectrum-icons/workflow/Delete';
import Download from '@spectrum-icons/workflow/Download';
import { readRecordingFile, deleteRecording, RecordingNode } from "./filesystem";

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

export interface SavedRecordingsCardProps {
  recording: RecordingNode,
  onRemoved: () => void
}

export function SavedRecordingsCard(
  { recording, onRemoved }: SavedRecordingsCardProps
) {
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
          recording.files.map(file =>
            <ActionButton key={`download-${file}`} onPress={() => downloadFile(recording.name, file)}>
              <Download/>
              <Text>Download {file}</Text>
            </ActionButton>
          )
        }
        <ActionButton onPress={() => { deleteRecording(recording.name).then(() => onRemoved()) }}>
          <Delete/>
          <Text>Remove</Text>
        </ActionButton>
      </Flex>
    </View>
  );
}

export default SavedRecordingsCard;

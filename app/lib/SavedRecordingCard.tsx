
import { ActionButton, Flex, Link, Text, View } from "@adobe/react-spectrum";
import { SavedRecording } from "./types";
import Delete from '@spectrum-icons/workflow/Delete';

export interface SavedRecordingsCardProps {
  recording: SavedRecording,
  onRemove: () => void
}

export const SavedRecordingsCard = (
  props: SavedRecordingsCardProps
) =>
  <View
    borderWidth="thin"
    borderColor="light"
    borderRadius="medium"
    padding="size-100"
  >
    <Flex direction="column" justifyContent="center" gap="size-100">
      <Text>{props.recording.timestamp}</Text>
      {
        props.recording.tracks.map(track =>
          <Link
            key={track.title}
            download={`recording-${props.recording.timestamp}-${track.title}`}
            href={URL.createObjectURL(track.blob)}
          >
            Download {track.title}
          </Link>
        )
      }
      <ActionButton onPress={props.onRemove}>
        <Delete/>
        <Text>Remove</Text>
      </ActionButton>
    </Flex>
  </View>;

export default SavedRecordingsCard;

"use client";
import { ActionButton, Text } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import Delete from "@react-spectrum/s2/icons/Delete";
import Download from "@react-spectrum/s2/icons/Download";
import { downloadFile, RecordingFileList } from "../utils/browserStorage";
import { useBrowserStorage } from "../hooks/useBrowserStorage";
import { useActiveRecording } from "../hooks/useActiveRecording";

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
  const activeRecording = useActiveRecording();

  const {
    savedRecordings,
    removeSavedRecording
  } = useBrowserStorage();

  const isDisabled = (r: RecordingFileList) => r.name === activeRecording.name;

  return (
    <div
      className={style({
        display: "flex",
        flexDirection: "row",
        gap: 8,
        flexWrap: "wrap"
      })}
    >
      {
        savedRecordings.map(rec =>
          <div
            key={`saved-recording-${rec.name}`}
            data-testid="sr-card"
            className={style({
              display: "flex",
              flexDirection: "column",
              borderColor: "gray-300",
              borderRadius: "lg",
              borderStyle: "solid",
              borderWidth: 1,
              padding: 8,
              justifyContent: "center",
              gap: 8
            })}
          >
            <Text>{rec.name}</Text>
            {
              rec.files.map(({ name: filename, size }) =>
                <ActionButton
                  key={`download-${filename}`}
                  isDisabled={isDisabled(rec)}
                  onPress={() => downloadFile(rec.name, filename)}
                  styles={style({ width: "100%" })}
                >
                  <Download/>
                  <Text>Download {filename} {size !== undefined && `(${mibFormatter.format(size / 2 ** 20)} MiB)`}</Text>
                </ActionButton>
              )
            }
            <ActionButton
              isDisabled={isDisabled(rec)}
              onPress={() => removeSavedRecording(rec.name)}
              styles={style({ width: "100%" })}
            >
              <Delete/>
              <Text>Remove</Text>
            </ActionButton>
          </div>
        )
      }
    </div>
  );
}

"use client";

import { WarningIcon } from "@phosphor-icons/react";
import { useActiveRecording } from "../hooks/useActiveRecording";
import { useAppStore } from "../hooks/useAppStore";
import { Alert, List, Stack, Text } from "@mantine/core";

export function StreamingImpededWarning() {
  const recording = useActiveRecording();
  const unstreamedRecordings = useAppStore(state => state.unstreamedRecordings);

  if(unstreamedRecordings.length === 0) {
    return null;
  }

  // When a lecture is being recorded and not streamed, only talk about that one because it's where
  // the user's attention needs to be.
  if(recording.state === "recording" && unstreamedRecordings.includes(recording.name)) {
    return (
      <Alert variant="outline" color="warning" icon={<WarningIcon/>} title="Lecture is not being streamed to backend">
        <Stack>
          <Text>
            Please re-upload the recording files when the backend becomes available.
          </Text>
          { /* TODO: make this real
            <Text>
              ISE-Recorder will attempt a re-upload when the recording concludes.
            </Text>
            */}
        </Stack>
      </Alert>
    );
  }

  // When not recording, list everything. Now the user has use for the full list.
  return (
    <Alert variant="outline" color="warning" icon={<WarningIcon/>} title="Recorded lectures were not streamed to backend">
      <Stack>
        <Text>
          The following lectures were not streamed to the backend:
        </Text>

        <List>
          { unstreamedRecordings.map(rec => <List.Item key={rec}>{rec}</List.Item>) }
        </List>

        <Text>
          Please upload them manually once the backend is available.
        </Text>
      </Stack>
    </Alert>
  );
}

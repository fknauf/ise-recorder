"use client";

import { InlineAlert, Heading, Content, Flex, Text } from "@adobe/react-spectrum";
import { useActiveRecording } from "../hooks/useActiveRecording";
import { useAppStore } from "../hooks/useAppStore";

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
      <InlineAlert variant="notice">
        <Heading>Lecture is not being streamed to backend</Heading>
        <Content>
          <Flex direction="column" gap="size-100">
            <Text>
              Please re-upload the recording files when the backend becomes available.
            </Text>
            { /* TODO: make this real
            <Text>
              ISE-Recorder will attempt a re-upload when the recording concludes.
            </Text>
            */}
          </Flex>
        </Content>
      </InlineAlert>
    );
  }

  // When not recording, list everything. Now the user has use for the full list.
  return (
    <InlineAlert variant="notice">
      <Heading>Recorded lectures were not streamed to backend</Heading>
      <Content>
        <Flex direction="column" gap="size-100">
          <Text>
            The following lectures were not streamed to the backend; consider uploading them manually:
          </Text>

          <Flex direction="column" gap="size-0">
            { unstreamedRecordings.map(rec => <Text key={rec}>{rec}</Text>) }
          </Flex>
        </Flex>
      </Content>
    </InlineAlert>
  );
}

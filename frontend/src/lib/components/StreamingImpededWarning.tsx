"use client";

import { InlineAlert, Heading, Content, Flex, Text } from "@adobe/react-spectrum";
import { useActiveRecording } from "../hooks/useActiveRecording";

export function StreamingImpededWarning() {
  const recording = useActiveRecording();

  if(recording.state !== "recording" || !recording.streamingImpeded) {
    return null;
  }

  return (
    <InlineAlert variant="notice">
      <Heading>Lecture is not being streamed to backend</Heading>
      <Content>
        <Flex direction="column" gap="size-100">
          <Text>
            Manual postprocessing will be required.
          </Text>

          <Text>
            Remember to download the recording files when finished.
          </Text>
        </Flex>
      </Content>
    </InlineAlert>
  );
}

"use client";

import { InlineAlert, Heading, Content } from "@adobe/react-spectrum";
import { useActiveRecording } from "../hooks/useActiveRecording";

export function StreamingImpededWarning() {
  const recording = useActiveRecording();

  if(recording.state !== "recording" || !recording.streamingImpeded) {
    return null;
  }

  return (
    <InlineAlert variant="notice">
      <Heading>Lecture is not being streamed to the postprocessing backend</Heading>
      <Content>
        Manual postprocessing will be required. Please remember to download the recording
        files when the recording is finished.
      </Content>
    </InlineAlert>
  );
}

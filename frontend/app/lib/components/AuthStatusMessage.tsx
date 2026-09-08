"use client";

import { useAccessTokenSource } from "../hooks/useAuthTokenSource";
import { useAutoSignin } from "react-oidc-context";
import { Content, Flex, Heading, InlineAlert, ProgressCircle } from "@adobe/react-spectrum";
import { useActiveRecording } from "../hooks/useActiveRecording";

function AuthStatusMessageImpl() {
  const auth = useAutoSignin();

  if(auth.isAuthenticated) {
    return null;
  }

  if(auth.isLoading) {
    return (
      <Flex direction="row" justifyContent="center" marginTop="size-200">
        <InlineAlert variant="info">
          <Heading>Authentication Loading</Heading>
          <Content>
            <ProgressCircle size="M" isIndeterminate/> Authenticating...
          </Content>
        </InlineAlert>
      </Flex>
    );
  }

  return (
    <Flex direction="row" justifyContent="center" marginTop="size-200">
      <InlineAlert variant="negative">
        <Heading>Authentication Error</Heading>
        <Content>
          Authentication Error: {auth.error?.message ?? "Unknown Error"}
        </Content>
      </InlineAlert>
    </Flex>
  );
}

function StreamingImpededWarning() {
  const recording = useActiveRecording();

  if(recording.state !== "recording" || !recording.streamingImpeded) {
    return null;
  }

  return (
    <Flex direction="row" justifyContent="center" marginTop="size-200">
      <InlineAlert variant="notice">
        <Heading>Authentication Error</Heading>
        <Content>
          Lecture is not being streamed to the postprocessing backend because authentication was not possible when
          the stream was started. Manual postprocessing will be required. Please remember to download the recording
          files when the recording is finished.
        </Content>
      </InlineAlert>
    </Flex>
  );
}

export function AuthStatusMessage() {
  const tokenSource = useAccessTokenSource();

  if(!tokenSource.authRequired) {
    return null;
  }

  return (
    <>
      <AuthStatusMessageImpl/>
      <StreamingImpededWarning/>
    </>
  );
}

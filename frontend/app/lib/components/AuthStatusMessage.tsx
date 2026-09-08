"use client";

import { useAccessTokenSource } from "../hooks/useAuthTokenSource";
import { useAutoSignin } from "react-oidc-context";
import { Content, Flex, Heading, InlineAlert, ProgressCircle, Text } from "@adobe/react-spectrum";
import { useActiveRecording } from "../hooks/useActiveRecording";
import { useEffect, useState } from "react";

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
            <ProgressCircle aria-label="Authenticating" size="M" isIndeterminate/> <Text>Authenticating...</Text>
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
        <Heading>Lecture is not being streamed to the postprocessing backend</Heading>
        <Content>
          Manual postprocessing will be required. Please remember to download the recording
          files when the recording is finished.
        </Content>
      </InlineAlert>
    </Flex>
  );
}

export function AuthStatusMessage() {
  const tokenSource = useAccessTokenSource();
  const [ mounted, setMounted ] = useState(false);

  // Make sure SSR and first render both see this component as empty
  // to avoid complaints about mismatches during hydration.
  useEffect(() => setMounted(true), []);
  if(!tokenSource.authRequired || !mounted) {
    return null;
  }

  return (
    <>
      <AuthStatusMessageImpl/>
      <StreamingImpededWarning/>
    </>
  );
}

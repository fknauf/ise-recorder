"use client";

import { useAccessTokenSource } from "../hooks/useAccessTokenSource";
import { useAuth } from "react-oidc-context";
import { ActionButton, Content, Flex, Heading, InlineAlert, ProgressCircle, Text } from "@adobe/react-spectrum";
import { useActiveRecording } from "../hooks/useActiveRecording";
import Refresh from "@spectrum-icons/workflow/Refresh";
import Login from "@spectrum-icons/workflow/Login";
import { useAppStore } from "../hooks/useAppStore";
import { useServerEnv } from "../hooks/useServerEnv";

function AuthStatusMessageImpl() {
  const env = useServerEnv();
  const auth = useAuth();
  const { interactiveLogin, expandSessionHeadroom } = useAccessTokenSource();
  const stale = useAppStore(state => state.staleSession);

  if(env.apiUrl === undefined) {
    return null;
  }

  if(auth.isLoading) {
    return (
      <InlineAlert variant="info">
        <Heading>Authentication Loading</Heading>
        <Content>
          <ProgressCircle aria-label="Authenticating" size="M" isIndeterminate/> <Text>Authenticating...</Text>
        </Content>
      </InlineAlert>
    );
  }

  if(auth.error !== undefined) {
    return (
      <InlineAlert variant="negative">
        <Heading>Authentication Error</Heading>
        <Content>
          <Flex direction="column">
            <Text>Authentication Error: {auth.error.message || "Unknown Error"}</Text>
            <ActionButton onPress={interactiveLogin} marginTop="size-100" alignSelf="center">
              <Refresh/>
              <Text>Retry authentication</Text>
            </ActionButton>
          </Flex>
        </Content>
      </InlineAlert>
    );
  }

  if(!auth.isAuthenticated) {
    return (
      <InlineAlert variant="notice">
        <Heading>You are not authenticated</Heading>
        <Content>
          <Flex direction="column">
            <Text>Streaming to backend is disabled.</Text>
            <ActionButton onPress={interactiveLogin} marginTop="size-100" alignSelf="center">
              <Login/>
              <Text>Sign in</Text>
            </ActionButton>
          </Flex>
        </Content>
      </InlineAlert>
    );
  }

  if(stale) {
    return (
      <InlineAlert variant="notice">
        <Heading>Authentication Session is Stale</Heading>
        <Content>
          <Flex direction="column">
            <Text>The authentication session will expire soon.</Text>
            <ActionButton onPress={expandSessionHeadroom} marginTop="size-100" alignSelf="center">
              <Refresh/>
              <Text>Reauthenticate</Text>
            </ActionButton>
          </Flex>
        </Content>
      </InlineAlert>
    );
  }

  return null;
}

function StreamingImpededWarning() {
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

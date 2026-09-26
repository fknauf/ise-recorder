"use client";

import { useAppSession } from "./SessionProvider";
import { ActionButton, Content, Flex, Heading, InlineAlert, ProgressCircle, Text } from "@adobe/react-spectrum";
import Refresh from "@spectrum-icons/workflow/Refresh";
import Login from "@spectrum-icons/workflow/Login";
import { useServerEnv } from "../hooks/useServerEnv";

export function AuthStatusMessage() {
  const {
    apiUrl
  } = useServerEnv();

  const {
    authRequired,
    isAuthenticated,
    isLoading,
    error,
    isStale,
    interactiveSignin,
    expandSession
  } = useAppSession();

  if(apiUrl === undefined || !authRequired) {
    return null;
  }

  if(isLoading) {
    return (
      <InlineAlert variant="info">
        <Heading>Authentication Loading</Heading>
        <Content>
          <Flex direction="row" gap="size-100" justifyContent="center" alignItems="center">
            <ProgressCircle aria-label="Authenticating" size="M" isIndeterminate/>
            <Text>Authenticating...</Text>
          </Flex>
        </Content>
      </InlineAlert>
    );
  }

  if(error !== undefined) {
    return (
      <InlineAlert variant="negative">
        <Heading>Authentication Error</Heading>
        <Content>
          <Flex direction="column">
            <Text>Authentication Error: {error.message || "Unknown Error"}</Text>
            <ActionButton onPress={interactiveSignin} marginTop="size-100" alignSelf="center">
              <Refresh/>
              <Text>Retry authentication</Text>
            </ActionButton>
          </Flex>
        </Content>
      </InlineAlert>
    );
  }

  if(!isAuthenticated) {
    return (
      <InlineAlert variant="notice">
        <Heading>You are not authenticated</Heading>
        <Content>
          <Flex direction="column">
            <Text>Streaming to backend is disabled.</Text>
            <ActionButton onPress={interactiveSignin} marginTop="size-100" alignSelf="center">
              <Login/>
              <Text>Sign in</Text>
            </ActionButton>
          </Flex>
        </Content>
      </InlineAlert>
    );
  }

  if(isStale) {
    return (
      <InlineAlert variant="notice">
        <Heading>Authentication Session is Stale</Heading>
        <Content>
          <Flex direction="column">
            <Text>The authentication session will expire soon.</Text>
            <ActionButton onPress={expandSession} marginTop="size-100" alignSelf="center">
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

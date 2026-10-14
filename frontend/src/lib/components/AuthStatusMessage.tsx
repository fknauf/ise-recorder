"use client";

import { useAppSession } from "./SessionProvider";
import { Alert, Button, Group, Loader, Stack, Text } from "@mantine/core";
import { WarningOctagonIcon, WarningIcon, InfoIcon, RepeatIcon, SignInIcon } from "@phosphor-icons/react";
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
    reauthenticate
  } = useAppSession();

  if(apiUrl === undefined || !authRequired) {
    return null;
  }

  if(isLoading && !isAuthenticated) {
    return (
      <Alert variant="outline" color="info" icon={<InfoIcon/>} title="Authentication Loading">
        <Group justify="center" align="center" gap="xs">
          <Loader size="sm" role="progressbar" aria-label="Authenticating" color="info"/>
          <Text>Authenticating...</Text>
        </Group>
      </Alert>
    );
  }

  if(error !== undefined && error.source !== "signinSilent") {
    return (
      <Alert variant="outline" color="error" icon={<WarningOctagonIcon/>} title="Authentication Error">
        <Stack align="center">
          <Text>Authentication Error: {error.message || "Unknown Error"}</Text>
          <Button
            onClick={interactiveSignin}
            leftSection={<RepeatIcon size={14}/>}
          >
            Retry authentication
          </Button>
        </Stack>
      </Alert>
    );
  }

  if(!isAuthenticated) {
    return (
      <Alert variant="outline" color="warning" icon={<WarningIcon/>} title="You are not authenticated">
        <Stack align="center">
          <Text>Streaming to backend is disabled.</Text>
          <Button onClick={interactiveSignin} leftSection={<SignInIcon/>}>
            Sign in
          </Button>
        </Stack>
      </Alert>
    );
  }

  if(isStale) {
    return (
      <Alert variant="outline" color="orange" icon={<WarningIcon/>} title="Session is Stale">
        <Stack align="center">
          <Text>The authentication session will expire soon.</Text>
          <Button onClick={reauthenticate} leftSection={<RepeatIcon/>}>
            Reauthenticate
          </Button>
        </Stack>
      </Alert>
    );
  }

  return null;
}

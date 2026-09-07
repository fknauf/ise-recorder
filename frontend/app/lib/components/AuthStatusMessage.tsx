"use client";

import { useAccessTokenSource } from "../hooks/useAuthTokenSource";
import { useAuth, useAutoSignin } from "react-oidc-context";
import { Content, Flex, Heading, InlineAlert, ProgressCircle } from "@adobe/react-spectrum";
import { useEffect } from "react";

function AuthStatusMessageImpl({}: {}) {
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

export function AuthStatusMessage({}: {}) {
  const tokenSource = useAccessTokenSource();

  if(!tokenSource.authRequired) {
    return null;
  }

  return <AuthStatusMessageImpl/>;
}

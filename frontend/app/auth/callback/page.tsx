"use client";

import { Content, Heading, InlineAlert, ProgressCircle } from "@adobe/react-spectrum";
import { useAuth } from "react-oidc-context";

export default function AuthCallback() {
  const auth = useAuth();

  if(auth.isLoading) {
    return <ProgressCircle isIndeterminate size="L"/>;
  }

  if(auth.error !== undefined) {
    return <InlineAlert variant="negative">
      <Heading>AuthenticationFailed</Heading>
      <Content>{auth.error.message}</Content>
    </InlineAlert>
  }
}

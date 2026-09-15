"use client";
import { useAccessTokenSource } from "../hooks/useAccessTokenSource";
import { useAuth } from "react-oidc-context";
import { ActionButton, Content, Heading, InlineAlert, ProgressCircle, Text } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useActiveRecording } from "../hooks/useActiveRecording";
import Refresh from "@react-spectrum/s2/icons/Refresh";
import { useAppStore } from "../hooks/useAppStore";

function AuthStatusMessageImpl() {
  const auth = useAuth();
  const { expandSessionHeadroom } = useAccessTokenSource();
  const stale = useAppStore(state => state.staleSession);

  if(auth.isAuthenticated) {
    if(!stale) {
      return null;
    }

    return (
      <InlineAlert variant="notice">
        <Heading>Authentication Session is Stale</Heading>
        <Content>
          <div className={style({
            display: "flex",
            flexDirection: "column"
          })}
          >
            <Text>The authentication session will expire soon.</Text>
            <ActionButton
              onPress={expandSessionHeadroom}
              styles={style({
                marginTop: 8,
                alignSelf: "center"
              })}
            >
              <Refresh/>
              <Text>Reauthenticate</Text>
            </ActionButton>
          </div>
        </Content>
      </InlineAlert>
    );
  }

  if(auth.isLoading) {
    return (
      <InlineAlert variant="informative">
        <Heading>Authentication Loading</Heading>
        <Content>
          <ProgressCircle aria-label="Authenticating" size="M" isIndeterminate/> <Text>Authenticating...</Text>
        </Content>
      </InlineAlert>
    );
  }

  return (
    <InlineAlert variant="negative">
      <Heading>Authentication Error</Heading>
      <Content>
        Authentication Error: {auth.error?.message ?? "Unknown Error"}
      </Content>
    </InlineAlert>
  );
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

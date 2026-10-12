"use client";
import "@mantine/notifications/styles.css";
import { Accordion, Group, Stack } from "@mantine/core";
import { QuotaWarning } from "@/lib/components/QuotaWarning";
import { RecorderControls } from "@/lib/components/RecorderControls";
import { BrowserStorageSection } from "@/lib/components/BrowserStorageSection";
import { PreviewSection } from "@/lib/components/PreviewSection";
import { GithubLink } from "@/lib/components/GithubLink";
import { AuthStatusMessage } from "@/lib/components/AuthStatusMessage";
import { useAutoSignin } from "react-oidc-context";
import { useAppSession } from "@/lib/components/SessionProvider";
import { useHydrated } from "@/lib/hooks/useHydrated";
import { ServerStorageSection } from "@/lib/components/ServerStorageSection";
import { StreamingImpededWarning } from "@/lib/components/StreamingImpededWarning";
import { Notifications } from "@mantine/notifications";

function AutoSignin() {
  useAutoSignin();
  return null;
}

export function Home() {
  const hydrated = useHydrated();
  const { autoSignin } = useAppSession();

  return (
    <Stack justify="center">
      {
        hydrated && autoSignin && <AutoSignin/>
      }
      <Group justify="center" gap={64} align="flex-start">
        <RecorderControls/>
        <GithubLink/>
      </Group>
      <Group justify="center">
        <AuthStatusMessage/>
        <StreamingImpededWarning/>
        <QuotaWarning thresholdBytes={2 ** 30}/>
      </Group>
      <PreviewSection canvasWidth={384} canvasHeight={216}/>
      <Accordion multiple defaultValue={["saved", "processed"]}>
        <BrowserStorageSection id="saved"/>
        <ServerStorageSection id="processed"/>
      </Accordion>
      <Notifications limit={3} position="bottom-center"/>
    </Stack>
  );
}

export default Home;

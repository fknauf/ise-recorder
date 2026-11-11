"use client";
import "@mantine/notifications/styles.css";
import { Accordion, Group, Stack } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { useAutoSignin } from "react-oidc-context";
import { AuthStatusMessage } from "@/lib/components/AuthStatusMessage";
import { BrowserStorageSection } from "@/lib/components/BrowserStorageSection";
import { ColorModeToggle } from "@/lib/components/ColorModeToggle";
import { GithubLink } from "@/lib/components/GithubLink";
import { PreviewSection } from "@/lib/components/PreviewSection";
import { QuotaWarning } from "@/lib/components/QuotaWarning";
import { RecorderControls, UnlabelledRow } from "@/lib/components/RecorderControls";
import { ServerStorageSection } from "@/lib/components/ServerStorageSection";
import { useAppSession } from "@/lib/components/SessionProvider";
import { StreamingImpededWarning } from "@/lib/components/StreamingImpededWarning";
import { useHydrated } from "@/lib/hooks/useHydrated";

function AutoSignin() {
  useAutoSignin();
  return null;
}

export function Home() {
  const hydrated = useHydrated();
  const { autoSignin } = useAppSession();

  return (
    <Stack justify="center">
      {hydrated && autoSignin && <AutoSignin />}
      <Group justify="center" gap={64} align="flex-start">
        <RecorderControls />
        <UnlabelledRow>
          <ColorModeToggle />
          <GithubLink />
        </UnlabelledRow>
      </Group>
      <Group justify="center" align="flex-start">
        <AuthStatusMessage />
        <StreamingImpededWarning />
        <QuotaWarning thresholdBytes={2 ** 30} />
      </Group>
      <PreviewSection canvasWidth={384} canvasHeight={216} />
      <Accordion multiple defaultValue={["saved", "processed"]}>
        <BrowserStorageSection id="saved" />
        <ServerStorageSection id="processed" />
      </Accordion>
      <Notifications limit={3} position="bottom-center" />
    </Stack>
  );
}

export default Home;

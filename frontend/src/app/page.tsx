"use client";

import { Accordion, Flex, ToastContainer } from "@adobe/react-spectrum";
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

function AutoSignin() {
  useAutoSignin();
  return null;
}

export function Home() {
  const hydrated = useHydrated();
  const { autoSignin } = useAppSession();

  return (
    <Flex direction="column" width="100vw" height="100vh" gap="size-100">
      {
        hydrated && autoSignin && <AutoSignin/>
      }
      <Flex direction="row" justifyContent="center" gap="size-500">
        <RecorderControls/>
        <GithubLink marginTop="size-450" size="M"/>
      </Flex>

      <Flex direction="row" justifyContent="center" marginTop="size-200" gap="size-100">
        <AuthStatusMessage/>
        <StreamingImpededWarning/>
        <QuotaWarning thresholdBytes={2 ** 30}/>
      </Flex>
      <PreviewSection canvasWidth={384} canvasHeight={216}/>
      <Accordion isQuiet allowsMultipleExpanded defaultExpandedKeys={["saved", "processed"]}>
        <BrowserStorageSection id="saved"/>
        <ServerStorageSection id="processed"/>
      </Accordion>
      <ToastContainer/>
    </Flex>
  );
}

export default Home;

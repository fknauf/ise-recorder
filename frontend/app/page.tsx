"use client";

import { Flex, ToastContainer } from "@adobe/react-spectrum";
import { QuotaWarning } from "./lib/components/QuotaWarning";
import { RecorderControls } from "./lib/components/RecorderControls";
import { SavedRecordingsSection } from "./lib/components/SavedRecordingsSection";
import { PreviewSection } from "./lib/components/PreviewSection";
import { GithubLink } from "./lib/components/GithubLink";

export const Home = () =>
  <Flex direction="column" width="100vw" height="100vh" gap="size-100">
    <Flex direction="row" justifyContent="center" gap="size-500">
      <RecorderControls/>
      <GithubLink marginTop="size-450"/>
    </Flex>

    <QuotaWarning thresholdBytes={2 ** 30}/>
    <PreviewSection canvasWidth={384} canvasHeight={216}/>
    <SavedRecordingsSection/>
    <ToastContainer/>
  </Flex>;

export default Home;

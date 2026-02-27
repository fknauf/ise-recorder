"use client";

import { Flex, Link, ToastContainer } from "@adobe/react-spectrum";
import { QuotaWarning } from "./lib/components/QuotaWarning";
import { RecorderControls } from "./lib/components/RecorderControls";
import { SavedRecordingsSection } from "./lib/components/SavedRecordingsSection";
import { PreviewSection } from "./lib/components/PreviewSection";
import { GithubIcon } from "./lib/components/GithubIcon";

export const Home = () =>
  <Flex direction="column" width="100vw" height="100vh" gap="size-100">
    <Flex direction="row" alignItems="end" justifyContent="center" gap="size-500">
      <RecorderControls/>

      <Link
        href="https://github.com/fknauf/ise-recorder"
        variant="secondary"
        isQuiet
      >
        <GithubIcon/>
      </Link>
    </Flex>

    <QuotaWarning thresholdBytes={2 ** 30}/>
    <PreviewSection canvasWidth={384} canvasHeight={216}/>
    <SavedRecordingsSection/>
    <ToastContainer/>
  </Flex>;

export default Home;

"use client";

import { Content, Flex, Heading, InlineAlert, Text } from "@adobe/react-spectrum";
import { useBrowserStorage } from "../hooks/useBrowserStorage";

const mibFormatter = new Intl.NumberFormat(
  "en-us",
  {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
    useGrouping: false
  }
);

function formatMib(x: number | undefined) {
  if(x === undefined) {
    return "N/A";
  } else {
    return mibFormatter.format(x / 2 ** 20) + " MiB";
  }
}

export interface QuotaWarningProps {
  thresholdBytes: number
}

/**
 * Shows a warning message iff the browser's OPFS quota is almost used up.
 */
export function QuotaWarning({ thresholdBytes }: Readonly<QuotaWarningProps>) {
  const { quota, usage } = useBrowserStorage();

  const quotaCritical = quota !== undefined && usage !== undefined && quota - usage < thresholdBytes;

  if(!quotaCritical) {
    return null;
  }

  return (
    <InlineAlert variant="notice">
      <Heading>Quota warning</Heading>
      <Content>
        <Flex direction="column">
          <Text>
            Browser storage running low: {formatMib(usage)} of {formatMib(quota)} used.
          </Text>
          
          <Text>
            Please consider removing some old recordings.
          </Text>
        </Flex>          
      </Content>
    </InlineAlert>
  );
}

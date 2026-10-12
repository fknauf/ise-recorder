"use client";

import { Alert, Stack, Text } from "@mantine/core";
import { useBrowserStorage } from "../hooks/useBrowserStorage";
import { WarningIcon } from "@phosphor-icons/react";

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
    <Alert variant="outline" color="warning" icon={<WarningIcon/>} title="Quota Warning">
      <Stack>
        <Text>
          Browser storage running low: {formatMib(usage)} of {formatMib(quota)} used.
        </Text>

        <Text>
          Please consider removing some old recordings.
        </Text>
      </Stack>
    </Alert>
  );
}

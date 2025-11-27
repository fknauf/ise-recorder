'use client';

import { Content, Flex, Heading, InlineAlert } from "@adobe/react-spectrum";

const mibFormatter = new Intl.NumberFormat('en-us', { minimumFractionDigits: 0, maximumFractionDigits: 0, useGrouping: false });

function formatMib(x: number | undefined) {
  if(x === undefined) {
    return "N/A"
  } else {
    return mibFormatter.format(x / 2 ** 20) + " MiB";
  }
}

function formatQuotaWarning(usage: number | undefined, quota: number | undefined): string | undefined {
  if(quota === undefined || usage === undefined) {
    return "Quota information not available. This browser may be unable to save recordings locally.";
  }

  const quotaCritical = quota - usage < 2 ** 30;

  if(quotaCritical) {
    return `Browser storage running low: ${formatMib(usage)} of ${formatMib(quota)} used. Please consider removing some old recordings.`;
  }
}


export interface QuotaWarningProps {
  usage?: number,
  quota?: number
}

/**
 * Shows a warning message iff the browser's OPFS quota is almost used up.
 */
export function QuotaWarning({ usage, quota }: Readonly<QuotaWarningProps>) {
  const message = formatQuotaWarning(usage, quota);

  if(message === undefined) {
    return <></>
  }

  return (
    <Flex direction="row" justifyContent="center" marginTop="size-200">
      <InlineAlert variant="notice">
        <Heading>Quota warning</Heading>
        <Content>
          {message}
        </Content>
      </InlineAlert>
    </Flex>
  );
}

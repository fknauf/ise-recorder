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

export function QuotaWarning({ usage, quota }: { usage?: number, quota?: number}) {
  const quotaCritical = quota !== undefined && usage !== undefined && quota - usage < 2 ** 30;

  if(quotaCritical) {
    return (
        <Flex direction="row" justifyContent="center" marginTop="size-200">
          <InlineAlert variant="notice">
            <Heading>Quota warning</Heading>
            <Content>
              Browser storage running low: {formatMib(usage)} of {formatMib(quota)} used. Please consider removing some old recordings.
            </Content>
          </InlineAlert>
        </Flex>
      );
  } else {
    return <></>
  }
}

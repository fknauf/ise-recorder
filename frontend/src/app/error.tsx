"use client";

import { Content, Flex, Heading, InlineAlert } from "@adobe/react-spectrum";
import { useEffect } from "react";

export default function ErrorPage({
  error
}: Readonly<{
  error: Error & { digest?: string }
}>) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Flex direction="row" justifyContent="center" marginTop="size-200">
      <InlineAlert variant="negative">
        <Heading>Unexpected Error</Heading>
        <Content>
          {error.message}
        </Content>
      </InlineAlert>
    </Flex>
  );
}

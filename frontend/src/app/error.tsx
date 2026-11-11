"use client";

import { Alert, Group } from "@mantine/core";
import { WarningOctagonIcon } from "@phosphor-icons/react";
import { useEffect } from "react";

export default function ErrorPage({
  error,
}: Readonly<{
  error: Error & { digest?: string };
}>) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Group justify="center">
      <Alert variant="light" color="error" title="Unexpected Error" icon={<WarningOctagonIcon />}>
        {error.message}
      </Alert>
    </Group>
  );
}

"use client";

import { Group } from "@mantine/core";
import { AuthStatusMessage } from "@/lib/components/AuthStatusMessage";

export default function AuthCallback() {
  return (
    <Group justify="center" mt="md">
      <AuthStatusMessage />
    </Group>
  );
}

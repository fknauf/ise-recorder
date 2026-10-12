"use client";

import { AuthStatusMessage } from "@/lib/components/AuthStatusMessage";
import { Group } from "@mantine/core";

export default function AuthCallback() {
  return (
    <Group justify="center" mt="md">
      <AuthStatusMessage/>
    </Group>
  );
}

"use client";

import { AuthStatusMessage } from "@/lib/components/AuthStatusMessage";
import { Flex } from "@adobe/react-spectrum";

export default function AuthCallback() {
  return (
    <Flex direction="row" justifyContent="center" marginTop="size-200">
      <AuthStatusMessage/>
    </Flex>
  );
}

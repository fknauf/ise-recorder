"use client";

import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { ActionIcon, Box } from "@mantine/core";
import { useMantineColorScheme, useComputedColorScheme } from "@mantine/core";
import { useColorScheme } from "@mantine/hooks";

export function ColorModeToggle() {
  const { setColorScheme, clearColorScheme } = useMantineColorScheme();
  const computedColorScheme = useComputedColorScheme();
  const os = useColorScheme();

  const toggleColorScheme = () => {
    const next = computedColorScheme === "dark" ? "light" : "dark";
    if(next === os) {
      clearColorScheme();
    } else {
      setColorScheme(next);
    }
  };

  return (
    <ActionIcon
      variant="outline"
      color="neutral"
      size="input-sm"
      radius="xl"
      aria-label="Color Mode Toggle"
      data-testid="cm-btn-toggle"
      onClick={toggleColorScheme}
    >
      <Box component={SunIcon} lightHidden style={{ width: "70%", height: "70%" }}/>
      <Box component={MoonIcon} darkHidden style={{ width: "70%", height: "70%" }}/>
    </ActionIcon>
  );
}

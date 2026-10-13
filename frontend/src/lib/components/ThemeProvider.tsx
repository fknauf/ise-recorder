"use client";

import { createTheme, DefaultMantineColor, MantineColorsTuple, MantineProvider, virtualColor } from "@mantine/core";

declare module "@mantine/core" {
  export interface MantineThemeColorsOverride {
    colors: Record<
      "error" |
      "warning" |
      "success" |
      "info" |
      "neutral" |
      DefaultMantineColor,
      MantineColorsTuple
    >
  }
}

const mainColor: MantineColorsTuple = [
  "#eff2ff",
  "#dfe2f2",
  "#bdc2de",
  "#99a0ca",
  "#7a84b9",
  "#6672af",
  "#5c69ac",
  "#4c5897",
  "#424e88",
  "#36437a"
];

const theme = createTheme({
  primaryColor: "mainColor",
  colors: {
    mainColor,
    error: virtualColor({
      name: "error",
      light: "red",
      dark: "red"
    }),
    warning: virtualColor({
      name: "warning",
      light: "orange",
      dark: "orange"
    }),
    success: virtualColor({
      name: "success",
      light: "green",
      dark: "green"
    }),
    info: virtualColor({
      name: "info",
      light: "blue",
      dark: "blue"
    }),
    neutral: virtualColor({
      name: "neutral",
      light: "gray",
      dark: "gray"
    })
  }
});

export function ThemeProvider({ nonce, children }: { nonce: string | undefined; children: React.ReactNode }) {
  const getNonce = nonce !== undefined ? () => nonce : undefined;

  return (
    <MantineProvider theme={theme} defaultColorScheme="auto" getStyleNonce={getNonce}>
      {children}
    </MantineProvider>
  );
}

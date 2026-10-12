"use client";

import { createTheme, MantineColorsTuple, MantineProvider, virtualColor } from "@mantine/core";

declare module "@mantine/core" {
  export interface MantineThemeColorsOverride {
    colors: Record<
      | "error" |
      "warning" |
      "success" |
      "info" |
      "neutral" |
      string,
      MantineColorsTuple
    >
  }
}

const theme = createTheme({
  colors: {
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

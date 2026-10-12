import "@mantine/core/styles.css";
import "./globals.css";

import type { Metadata } from "next";
import { ColorSchemeScript, mantineHtmlProps } from "@mantine/core";
import { AppStoreProvider } from "@/lib/hooks/useAppStore";
import { getServerEnv } from "@/lib/utils/serverEnv";
import { SessionProvider } from "@/lib/components/SessionProvider";
import { ModalsProvider } from "@mantine/modals";
import { headers } from "next/headers";
import { ThemeProvider } from "@/lib/components/ThemeProvider";

export const metadata: Metadata = {
  title: "ISE-Recorder",
  description: "ISE Lecture Recorder"
};

export default async function RootLayout(
  { children }: Readonly<{ children: React.ReactNode }>
) {
  const env = await getServerEnv();
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <ColorSchemeScript nonce={nonce} defaultColorScheme="auto"/>
      </head>
      <body>
        <ThemeProvider nonce={nonce}>
          <ModalsProvider>
            <AppStoreProvider serverEnv={env}>
              <SessionProvider serverEnv={env}>
                {children}
              </SessionProvider>
            </AppStoreProvider>
          </ModalsProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

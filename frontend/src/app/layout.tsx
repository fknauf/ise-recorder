import "@react-spectrum/s2/page.css";
import "./globals.css";
import type { Metadata } from "next";
import { SpectrumProvider } from "@/lib/components/SpectrumProvider";
import { AppStoreProvider } from "@/lib/hooks/useAppStore";
import { getServerEnv } from "@/lib/utils/serverEnv";
import { AccessTokenSourceProvider } from "@/lib/hooks/useAccessTokenSource";
import { headers } from "next/headers";

export async function generateMetadata(): Promise<Metadata> {
  const headerStore = await headers();
  const nonce = headerStore.get("x-nonce") || undefined;

  return {
    title: "ISE-Recorder",
    description: "ISE Lecture Recorder",
    other: nonce !== undefined ? { "csp-nonce": nonce } : {}
  };
}

export default async function RootLayout(
  { children }: Readonly<{ children: React.ReactNode }>
) {
  const env = await getServerEnv();
  const headerStore = await headers();
  const nonce = headerStore.get("x-nonce") || undefined;

  return (
    <html lang="en" nonce={nonce}>
      <body>
        <SpectrumProvider locale="en-US">
          <AppStoreProvider serverEnv={env}>
            <AccessTokenSourceProvider>
              {children}
            </AccessTokenSourceProvider>
          </AppStoreProvider>
        </SpectrumProvider>
      </body>
    </html>
  );
}

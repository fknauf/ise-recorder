import type { Metadata } from "next";
import "./globals.css";
import { SpectrumProvider } from "@/lib/components/SpectrumProvider";
import { AppStoreProvider } from "@/lib/hooks/useAppStore";
import { getServerEnv } from "@/lib/utils/serverEnv";
import { AccessTokenSourceProvider } from "@/lib/hooks/useAccessTokenSource";

export const metadata: Metadata = {
  title: "ISE-Recorder",
  description: "ISE Lecture Recorder"
};

export default async function RootLayout(
  { children }: Readonly<{ children: React.ReactNode }>
) {
  const env = await getServerEnv();

  return (
    <html lang="en">
      <body>
        <SpectrumProvider>
          <AppStoreProvider serverEnv={env}>
            <AccessTokenSourceProvider serverEnv={env}>
              {children}
            </AccessTokenSourceProvider>
          </AppStoreProvider>
        </SpectrumProvider>
      </body>
    </html>
  );
}

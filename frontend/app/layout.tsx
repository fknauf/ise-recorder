import type { Metadata } from "next";
import "./globals.css";
import { SpectrumProvider } from "./lib/components/SpectrumProvider";
import { ServerEnvProvider } from "./lib/hooks/useServerEnv";
import { getServerEnv } from "./lib/utils/serverEnv";

export const metadata: Metadata = {
  title: "ISE-Recorder",
  description: "ISE Lecture Recorder"
};

export default async function RootLayout(
  { children }: Readonly<{ children: React.ReactNode }>
) {
  "use server";

  const env = await getServerEnv();

  return (
    <html lang="en">
      <body>
        <SpectrumProvider>
          <ServerEnvProvider env={env}>
            {children}
          </ServerEnvProvider>
        </SpectrumProvider>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";
import { SpectrumProvider } from "@/lib/components/SpectrumProvider";
import { AppStoreProvider } from "@/lib/hooks/useAppStore";
import { getServerEnv } from "@/lib/utils/serverEnv";
import { AccessTokenSourceProvider, OidcConfiguration } from "@/lib/hooks/useAuthTokenSource";

export const metadata: Metadata = {
  title: "ISE-Recorder",
  description: "ISE Lecture Recorder"
};

export default async function RootLayout(
  { children }: Readonly<{ children: React.ReactNode }>
) {
  const env = await getServerEnv();

  let openIdConfig: OidcConfiguration | undefined = undefined;

  if(env.oidcProviderUrl !== undefined) {
    if(env.oidcClientId === undefined) {
      throw Error("OpenID provider configured but no client ID supplied");
    }

    openIdConfig = {
      providerUrl: env.oidcProviderUrl,
      clientId: env.oidcClientId
    };
  }

  return (
    <html lang="en">
      <body>
        <SpectrumProvider>
          <AccessTokenSourceProvider config={openIdConfig}>
            <AppStoreProvider serverEnv={env}>
              {children}
            </AppStoreProvider>
          </AccessTokenSourceProvider>
        </SpectrumProvider>
      </body>
    </html>
  );
}

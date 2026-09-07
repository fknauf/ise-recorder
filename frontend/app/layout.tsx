import type { Metadata } from "next";
import "./globals.css";
import { SpectrumProvider } from "./lib/components/SpectrumProvider";
import { AppStoreProvider } from "./lib/hooks/useAppStore";
import { getServerEnv } from "./lib/utils/serverEnv";
import { AccessTokenSourceProvider, OpenIdConfiguration } from "./lib/hooks/useAuthTokenSource";

export const metadata: Metadata = {
  title: "ISE-Recorder",
  description: "ISE Lecture Recorder"
};

export default async function RootLayout(
  { children }: Readonly<{ children: React.ReactNode }>
) {
  "use server";

  const env = await getServerEnv();

  let openIdConfig: OpenIdConfiguration | undefined = undefined;

  if(env.openid_provider_url !== undefined) {
    if(env.openid_client_id === undefined) {
      throw Error("OpenID provider configured but no client ID supplied");
    }

    openIdConfig = {
      providerUrl: env.openid_provider_url,
      clientId: env.openid_client_id
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

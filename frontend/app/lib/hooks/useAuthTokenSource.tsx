"use client";

import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { AuthProvider } from "react-oidc-context";
import { UserManager } from "oidc-client-ts";
import { useRouter } from "next/navigation";

interface AccessTokenSource {
  authRequired: boolean
  getAccessToken: () => Promise<string | undefined>
}

export const AccessTokenSourceContext = createContext<AccessTokenSource | undefined>(undefined);

export interface OidcConfiguration {
  providerUrl: string
  clientId: string
}

export interface AccessTokenSourceProviderProps {
  config?: OidcConfiguration
  children?: ReactNode
}

export interface AuthenticatedTokenSourceProviderProps {
  config: OidcConfiguration
  children?: ReactNode
}

function AnonymousTokenSourceProvider({ children }: Readonly<{ children: ReactNode }>) {
  const value = useMemo(() => ({
    authRequired: false,
    getAccessToken: async () => undefined
  }), []);

  return (
    <AccessTokenSourceContext.Provider value={value}>
      {children}
    </AccessTokenSourceContext.Provider>
  );
}

function AuthenticatedTokenSourceProvider({ config, children }: Readonly<AuthenticatedTokenSourceProviderProps>) {
  const [ userMgr ] = useState(() =>
    new UserManager({
      authority: config.providerUrl,
      client_id: config.clientId,
      redirect_uri: typeof window === "undefined"
        ? ""
        : `${window.location.origin}/auth/callback`,
      scope: "openid profile email",
      automaticSilentRenew: true,
      accessTokenExpiringNotificationTimeInSeconds: 120,
    })
  );

  const router = useRouter();
  const onSigninCallback = useCallback(() => router.replace("/"), [router]);

  const value = useMemo(() => ({
    authRequired: true,
    getAccessToken: async () => {
      const user = await userMgr.getUser();

      if(user === null || user.expired) {
        return undefined;
      }

      return user.access_token;
    }
  }), [userMgr]);

  return (
    <AccessTokenSourceContext.Provider value={value}>
      <AuthProvider userManager={userMgr} onSigninCallback={onSigninCallback}>
        {children}
      </AuthProvider>
    </AccessTokenSourceContext.Provider>
  );
}

export function AccessTokenSourceProvider({ config, children }: Readonly<AccessTokenSourceProviderProps>) {
  const authRequired = config !== undefined;

  if(authRequired) {
    return (
      <AuthenticatedTokenSourceProvider config={config}>
        {children}
      </AuthenticatedTokenSourceProvider>
    );
  } else {
    return (
      <AnonymousTokenSourceProvider>
        {children}
      </AnonymousTokenSourceProvider>
    );
  }
}

export function useAccessTokenSource(): AccessTokenSource {
  const store = useContext(AccessTokenSourceContext);

  if(store === undefined) {
    throw new Error("useAccessTokenSource must be used within AccessTokenSourceProvider");
  }

  return store;
}

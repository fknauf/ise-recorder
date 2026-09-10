"use client";

import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { AuthProvider } from "react-oidc-context";
import { UserManager } from "oidc-client-ts";
import { useRouter } from "next/navigation";
import { ServerEnv } from "../utils/serverEnv";

interface AccessTokenSource {
  authRequired: boolean
  getAccessToken: () => Promise<string | undefined>
  refreshAccessToken: () => Promise<string | undefined>
}

export const AccessTokenSourceContext = createContext<AccessTokenSource | undefined>(undefined);

interface AuthenticatedTokenSourceProviderProps {
  providerUrl: string
  clientId: string
  maxAge: number | undefined
  children?: ReactNode
}

function AnonymousTokenSourceProvider({ children }: Readonly<{ children: ReactNode }>) {
  const value = useMemo(() => ({
    authRequired: false,
    getAccessToken: async () => undefined,
    refreshAccessToken: async () => undefined
  }), []);

  return (
    <AccessTokenSourceContext.Provider value={value}>
      {children}
    </AccessTokenSourceContext.Provider>
  );
}

function AuthenticatedTokenSourceProvider({ providerUrl, clientId, maxAge, children }: Readonly<AuthenticatedTokenSourceProviderProps>) {
  const [ userMgr ] = useState(() =>
    new UserManager({
      authority: providerUrl,
      client_id: clientId,
      redirect_uri: typeof window === "undefined"
        ? ""
        : `${window.location.origin}/auth/callback`,
      scope: "openid profile email",
      automaticSilentRenew: true,
      accessTokenExpiringNotificationTimeInSeconds: 120,
      max_age: maxAge
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
    },
    refreshAccessToken: async () => {
      try {
        const user = await userMgr.signinSilent({
          max_age: maxAge,
          forceIframeAuth: true,
          silentRequestTimeoutInSeconds: 15
        });
        return user?.access_token;
      } catch(e) {
        console.warn("Explicit access token refresh failed, using existing access token (if available)", e);
        const existing = await userMgr.getUser();
        return existing !== null && !existing.expired ? existing.access_token : undefined;
      }
    }
  }), [userMgr, maxAge]);

  return (
    <AccessTokenSourceContext.Provider value={value}>
      <AuthProvider userManager={userMgr} onSigninCallback={onSigninCallback}>
        {children}
      </AuthProvider>
    </AccessTokenSourceContext.Provider>
  );
}

export interface AccessTokenSourceProviderProps {
  serverEnv: ServerEnv
  children: ReactNode
}

export function AccessTokenSourceProvider({ serverEnv, children }: Readonly<AccessTokenSourceProviderProps>) {
  if(serverEnv.oidcProviderUrl !== undefined) {
    if(serverEnv.oidcClientId === undefined) {
      throw Error("OpenID provider configured but no client ID supplied");
    }

    return (
      <AuthenticatedTokenSourceProvider
        providerUrl={serverEnv.oidcProviderUrl}
        clientId={serverEnv.oidcClientId}
        maxAge={serverEnv.oidcMaxAge}
      >
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

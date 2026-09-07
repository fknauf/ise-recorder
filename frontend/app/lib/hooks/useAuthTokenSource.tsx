"use client";

import { createContext, ReactNode, useContext, useMemo, useState } from "react";
import { AuthProvider } from "react-oidc-context";
import { User, UserManager } from "oidc-client-ts";

interface AccessTokenSource {
  authRequired: boolean
  getAccessToken: () => Promise<string | undefined>
}

const AccessTokenSourceContext = createContext<AccessTokenSource | undefined>(undefined);

export interface OpenIdConfiguration {
  providerUrl: string,
  clientId: string,
}

export interface AccessTokenSourceProviderProps {
  config?: OpenIdConfiguration
  children?: ReactNode
}

export interface AuthenticatedTokenSourceProviderProps {
  config: OpenIdConfiguration
  children?: ReactNode
}

function AnonymousTokenSourceProvider({ children } : Readonly<{ children : ReactNode}>) {
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

const onSigninCallback = (_user: User | undefined): void => {
  window.history.replaceState({}, document.title, window.location.pathname);
};

function AuthenticatedTokenSourceProvider({ config, children }: Readonly<AuthenticatedTokenSourceProviderProps>) {
  const [ userMgr ] = useState(() => 
    new UserManager({
      authority: config.providerUrl,
      client_id: config.clientId,
      redirect_uri: typeof window === "undefined"
        ? ""
        : `${window.location.origin}/auth/callback`,
      scope: "openid profile email offline_access",
      automaticSilentRenew: true,
      accessTokenExpiringNotificationTimeInSeconds: 120,
    })
  );

  const value = useMemo(() => ({
    authRequired: true,
    getAccessToken: async () => (await userMgr.getUser())?.access_token
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

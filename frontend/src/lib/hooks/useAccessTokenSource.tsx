"use client";

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AuthProvider } from "react-oidc-context";
import { UserManager } from "oidc-client-ts";
import { useRouter } from "next/navigation";
import { useAppStore } from "./useAppStore";
import { useServerEnv } from "./useServerEnv";

export type SessionExpansionResult =
  "still-fresh" | "still-stale" | "expired" | "renewed";

interface AccessTokenSource {
  authRequired: boolean
  getAccessToken: () => Promise<string | undefined>
  expandSessionHeadroom: () => Promise<SessionExpansionResult>
}

interface AuthenticatedTokenSourceProviderProps {
  providerUrl: string
  clientId: string
  maxAge: number | undefined
  children?: ReactNode
}

const MAX_TIMEOUT_MILLIS = 2 ** 31 - 1;

interface Staleness {
  stale: boolean
  recheckMillis?: number
}

export const AccessTokenSourceContext = createContext<AccessTokenSource | undefined>(undefined);

async function sessionStaleness(
  userMgr: UserManager,
  maxAge: number | undefined
): Promise<Staleness> {
  const user = await userMgr.getUser().catch(() => null);

  if(user === null) {
    return { stale: true };
  }

  if(maxAge === undefined || user.profile.auth_time === undefined) {
    return { stale: false };
  }

  const staleAtMillis = (user.profile.auth_time + maxAge) * 1000;
  const approxNowMillis = Math.max(user.profile.iat * 1000, Date.now());
  const remainingMillis = staleAtMillis - approxNowMillis;

  return remainingMillis > 0
    ? { stale: false, recheckMillis: remainingMillis }
    : { stale: true };
}

const anonymousTokenSource: AccessTokenSource = {
  authRequired: false,
  getAccessToken: async () => undefined,
  expandSessionHeadroom: async () => "still-fresh"
};

function AnonymousTokenSourceProvider({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <AccessTokenSourceContext.Provider value={anonymousTokenSource}>
      {children}
    </AccessTokenSourceContext.Provider>
  );
}

function AuthenticatedTokenSourceProvider({ providerUrl, clientId, maxAge, children }: Readonly<AuthenticatedTokenSourceProviderProps>) {
  const setStaleSession = useAppStore(store => store.setStaleSession);
  const router = useRouter();

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
      max_age: maxAge,
      filterProtocolClaims: [ "nbf", "jti", "nonce", "acr", "amr", "azp", "at_hash" ]
    })
  );

  const onSigninCallback = useCallback(() => router.replace("/"), [router]);

  // clean up userMgr when the component is unmounted. Library does not handle it for us.
  useEffect(() => () => userMgr.stopSilentRenew(), [userMgr]);

  useEffect(() => {
    // set a timer that fires when the session goes past max_age
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const check = async () => {
      clearTimeout(timer);
      const { stale, recheckMillis } = await sessionStaleness(userMgr, maxAge);

      if(cancelled) {
        return;
      }

      setStaleSession(stale);

      if(recheckMillis !== undefined) {
        timer = setTimeout(check, Math.min(recheckMillis, MAX_TIMEOUT_MILLIS));
      }
    };

    // set event handlers that reset the timer when the session age changes or we're unsure of our clock
    check();
    userMgr.events.addUserLoaded(check);
    userMgr.events.addUserUnloaded(check);
    document.addEventListener("visibilitychange", check);

    // make sure all this is cleaned up when the component is unmounted
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", check);
      userMgr.events.removeUserUnloaded(check);
      userMgr.events.removeUserLoaded(check);
      clearTimeout(timer);
    };
  }, [maxAge, setStaleSession, userMgr]);

  const getAccessToken = useCallback(async () => {
    const user = await userMgr.getUser();

    if(user === null || user.expired) {
      return undefined;
    }

    return user.access_token;
  }, [userMgr]);

  const expandSessionHeadroom = useCallback(async () => {
    if((await sessionStaleness(userMgr, maxAge)).stale) {
      try {
        await userMgr.signinPopup();
        return "renewed";
      } catch(e) {
        console.warn("Failed to reauthenticate stale oidc session, continuing with existing session", e);

        const existing = await userMgr.getUser().catch(() => null);

        if(existing === null || existing.expired) {
          return "expired";
        }

        return "still-stale";
      }
    }

    try {
      // Force access/refresh token renewal at recording start.
      await userMgr.signinSilent();
    } catch(e) {
      console.warn("Failed to force-refresh access/refresh token, continuing with existing tokens", e);
    }

    return "still-fresh";
  }, [maxAge, userMgr]);

  const value = useMemo<AccessTokenSource>(() => ({
    authRequired: true,
    getAccessToken,
    expandSessionHeadroom
  }), [getAccessToken, expandSessionHeadroom]);

  return (
    <AccessTokenSourceContext.Provider value={value}>
      <AuthProvider userManager={userMgr} onSigninCallback={onSigninCallback}>
        {children}
      </AuthProvider>
    </AccessTokenSourceContext.Provider>
  );
}

export function AccessTokenSourceProvider({ children }: Readonly<{ children: ReactNode }>) {
  const env = useServerEnv();

  if(env.oidcProviderUrl !== undefined) {
    if(env.oidcClientId === undefined) {
      throw Error("OpenID provider configured but no client ID supplied");
    }

    return (
      <AuthenticatedTokenSourceProvider
        key={`${env.oidcProviderUrl}${env.oidcClientId}${env.oidcMaxAge}`}
        providerUrl={env.oidcProviderUrl}
        clientId={env.oidcClientId}
        maxAge={env.oidcMaxAge}
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

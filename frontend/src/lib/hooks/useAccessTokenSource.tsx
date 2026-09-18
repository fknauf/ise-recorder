"use client";

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AuthProvider } from "react-oidc-context";
import { UserManager } from "oidc-client-ts";
import { useRouter } from "next/navigation";
import { useAppStore } from "./useAppStore";
import { useServerEnv } from "./useServerEnv";

export type SessionTransition =
  "still-fresh" | "still-stale" | "expired" | "renewed";

interface AccessTokenSource {
  authRequired: boolean
  getAccessToken: () => Promise<string | undefined>
  interactiveLogin: () => Promise<void>
  expandSessionHeadroom: () => Promise<SessionTransition>
}

interface AuthenticatedTokenSourceProviderProps {
  providerUrl: string
  clientId: string
  maxAge: number | undefined
  children?: ReactNode
}

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
  // adjust for clock drift: normally, Date.now() is after the current access token's iat. If not, then
  // the server clock and our clock are misaligned. Use iat then because it's closer to the server's now.
  const approxNowMillis = Math.max(user.profile.iat * 1000, Date.now());
  const remainingMillis = staleAtMillis - approxNowMillis;

  return remainingMillis > 0
    ? { stale: false, recheckMillis: remainingMillis }
    : { stale: true };
}

// Stub token source for yolo mode: no auth required, can't provide tokens, there's technically
// no session but also no need for one, so behave as if there always were a fresh session.
const anonymousTokenSource: AccessTokenSource = {
  authRequired: false,
  getAccessToken: async () => undefined,
  interactiveLogin: async () => {},
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
  const callbackUrl = typeof window === "undefined"
    ? ""
    : `${window.location.origin}/auth/callback`;

  // Need to roll our own UserManager instead of relying on react-oidc-context so we have access
  // to it later. That's required for manual reauthentication and headroom expansion ahead of a recording.
  const [ userMgr ] = useState(() =>
    new UserManager({
      authority: providerUrl,
      client_id: clientId,
      redirect_uri: callbackUrl,
      scope: "openid profile email",
      automaticSilentRenew: true,
      accessTokenExpiringNotificationTimeInSeconds: 120,
      max_age: maxAge,
      filterProtocolClaims: [ "nbf", "jti", "nonce", "acr", "amr", "azp", "at_hash" ] // don't filter auth_time. Otherwise same as default.
    })
  );

  // clean up userMgr when the component is unmounted. Library does not handle it for us.
  useEffect(() => () => userMgr.stopSilentRenew(), [userMgr]);

  // Staleness detection: set a flag in the store when session goes past max_age, unset it when
  // the session is renewed. This uses a timer set to the expected expiry time and userMgr events
  // as triggers, and on each trigger checks the session state and resets the timer if appropriate.
  useEffect(() => {
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
        // timer's max value is about 25 days. If expiry is further away, do a spurious check in 25 days.
        const MAX_TIMEOUT_MILLIS = 2 ** 31 - 1;
        timer = setTimeout(check, Math.min(recheckMillis, MAX_TIMEOUT_MILLIS));
      }
    };

    // set event handlers that reset the timer when the session age changes or when we're unsure of our clock
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

  const interactiveLogin = useCallback(async () => {
    try {
      await userMgr.signinPopup();
    } catch(e) {
      console.warn("Failed to authenticate", e);
    }
  }, [userMgr]);

  // Expanding the session headroom means making sure the current session isn't stale and refreshing the access token
  // manually, so we have its full length at the beginning of the recording.
  //
  // If the current session is past max_age, this will force the user to reauthenticate and get a fresh session.
  // Refreshing the access token is best-effort and not all that necessary in normal deployments with short-lived access
  // tokens, but this way if a user likes access tokens that live long enough to cover a recording, then the access token
  // present at the beginning of the recording will not need renewal during the lecture.
  const expandSessionHeadroom = useCallback(async () => {
    const refreshSession = async (
      fn: () => Promise<SessionTransition>,
      defaultValue: SessionTransition,
      errMsg: string
    ) => {
      try {
        return await fn();
      } catch(e) {
        console.warn(errMsg, e);

        const existing = await userMgr.getUser().catch(() => null);

        if(existing === null || existing.expired) {
          return "expired";
        }
      }

      return defaultValue;
    };

    if((await sessionStaleness(userMgr, maxAge)).stale) {
      return refreshSession(
        () => userMgr.signinPopup().then(() => "renewed"),
        "still-stale",
        "Failed to reauthenticate stale oidc session, continuing with existing session"
      );
    }

    return refreshSession(
      () => userMgr.signinSilent().then(() => "still-fresh"),
      "still-fresh",
      "Failed to force-refresh access/refresh token, continuing with existing tokens"
    );
  }, [maxAge, userMgr]);

  const value = useMemo<AccessTokenSource>(() => ({
    authRequired: true,
    interactiveLogin,
    getAccessToken,
    expandSessionHeadroom
  }), [getAccessToken, interactiveLogin, expandSessionHeadroom]);

  const onSigninCallback = useCallback(() => {
    if(window.self === window.top) {
      router.replace("/");
    }
  }, [router]);

  return (
    <AccessTokenSourceContext.Provider value={value}>
      <AuthProvider
        userManager={userMgr}
        onSigninCallback={onSigninCallback}
      >
        {children}
      </AuthProvider>
    </AccessTokenSourceContext.Provider>
  );
}

export function AccessTokenSourceProvider({ children }: Readonly<{ children: ReactNode }>) {
  const env = useServerEnv();

  // Support openid authentication and legacy yolo-who-needs-authentication mode. Split into two
  // impl components to conform to React hook rules.
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
  const tokenSource = useContext(AccessTokenSourceContext);

  if(tokenSource === undefined) {
    throw new Error("useAccessTokenSource must be used within AccessTokenSourceProvider");
  }

  return tokenSource;
}

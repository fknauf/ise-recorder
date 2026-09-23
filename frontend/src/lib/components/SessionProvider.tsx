"use client";

import { createContext, ReactNode, useContext, useEffect, useState } from "react";
import { AuthProvider, useAuth } from "react-oidc-context";
import { User, UserManager } from "oidc-client-ts";
import { useRouter } from "next/navigation";
import { ServerEnv } from "../utils/serverEnv";
import { determineSessionStaleness } from "../utils/session";

export type SessionTransition =
  "still-fresh" | "still-stale" | "expired" | "renewed" | "not-signed-in";

export interface AppSession {
  authRequired: boolean
  autoSignin: boolean
  isAuthenticated: boolean
  isLoading: boolean
  isExpired: boolean | undefined
  isStale: boolean
  error: Error | undefined
  userName: string | undefined

  getAccessToken: () => Promise<string | undefined>
  signout: () => Promise<void>
  interactiveSignin: () => Promise<void>
  reauthenticate: () => Promise<void>
  expandSession: () => Promise<SessionTransition>
}

interface SessionProviderProps {
  providerUrl: string
  clientId: string
  maxAge: number | undefined
  autoSigninConfigured: boolean
  children?: ReactNode
}

interface SessionContextBridgeProps {
  userManager: UserManager
  autoSigninConfigured: boolean
  isStale: boolean
  recheckStaleness: () => Promise<boolean>
  children: ReactNode
}

const SessionContext = createContext<AppSession | null>(null);

function AuthenticatedSessionContextBridge(
  {
    userManager,
    autoSigninConfigured,
    isStale,
    recheckStaleness,
    children
  }: Readonly<SessionContextBridgeProps>
) {
  const [ autoSignin, setAutoSignin ] = useState(autoSigninConfigured);
  const {
    isAuthenticated,
    isLoading,
    error,
    user,
    events,
    removeUser,
    signinPopup,
    signinSilent
  } = useAuth();

  const userName = user?.profile.preferred_username ?? user?.profile.name ?? user?.profile.email ?? "The Nameless One";

  const getAccessToken = async () => {
    const freshUser = await userManager.getUser().catch(() => null);

    if(freshUser === undefined || freshUser === null || freshUser?.expired) {
      return undefined;
    }

    return freshUser.access_token;
  };

  const signout = async () => {
    setAutoSignin(false);
    try {
      await removeUser();
    } catch(e) {
      console.error("Failed to sign out", e);
    }
  };

  const interactiveSignin = async () => {
    await signinPopup().catch(() => null);
  };

  const reauthenticate = async () => {
    const prevUser = user;
    const next = await signinPopup({ max_age: 0, popupAbortOnClose: true });

    if(next === null && prevUser) {
      await events.load(prevUser);
    }
  };

  // Expanding the session headroom means making sure the current session isn't stale and refreshing the access token
  // manually, so we have its full length at the beginning of the recording.
  //
  // If the current session is past max_age, this will force the user to reauthenticate and get a fresh session.
  // Refreshing the access token is best-effort and not all that necessary in normal deployments with short-lived access
  // tokens, but this way if a user likes access tokens that live long enough to cover a recording, then the access token
  // present at the beginning of the recording will not need renewal during the lecture.
  const expandSession = async () => {
    const refreshSession = async (
      fn: () => Promise<User | null>,
      successValue: SessionTransition,
      defaultValue: SessionTransition,
      errMsg: string
    ) => {
      if(await fn() !== null) {
        return successValue;
      }

      console.warn(errMsg);

      const freshUser = await userManager.getUser().catch(() => null);
      if(freshUser === null || freshUser.expired) {
        return "expired";
      }

      return defaultValue;
    };

    if(await recheckStaleness()) {
      return refreshSession(
        signinPopup,
        "renewed",
        "still-stale",
        "Failed to reauthenticate stale oidc session, continuing with existing session"
      );
    }

    return refreshSession(
      signinSilent,
      "still-fresh",
      "still-fresh",
      "Failed to force-refresh access/refresh token, continuing with existing tokens"
    );
  };

  return (
    <SessionContext.Provider
      value={{
        authRequired: true,
        autoSignin,
        isAuthenticated,
        isLoading,
        isExpired: user?.expired,
        isStale,
        error,
        userName,
        getAccessToken,
        signout,
        interactiveSignin,
        reauthenticate,
        expandSession
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

function AuthenticatedSessionProvider({ providerUrl, clientId, maxAge, autoSigninConfigured, children }: Readonly<SessionProviderProps>) {
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

  const [ stale, setStale ] = useState(false);

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
      const { stale, recheckMillis } = await determineSessionStaleness(userMgr, maxAge);

      if(cancelled) {
        return;
      }

      setStale(stale);

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
  }, [maxAge, setStale, userMgr]);

  const onSigninCallback = () => {
    if(window.self === window.top) {
      router.replace("/");
    }
  };

  const recheckStaleness = () =>
    determineSessionStaleness(userMgr, maxAge).then(r => r.stale);

  return (
    <AuthProvider
      userManager={userMgr}
      onSigninCallback={onSigninCallback}
    >
      <AuthenticatedSessionContextBridge
        userManager={userMgr}
        autoSigninConfigured={autoSigninConfigured}
        isStale={stale}
        recheckStaleness={recheckStaleness}
      >
        {children}
      </AuthenticatedSessionContextBridge>
    </AuthProvider>
  );
}

function AnonymousSessionProvider(
  { children }: Readonly<{ children: ReactNode }>
) {
  return (
    <SessionContext.Provider
      value={{
        authRequired: false,
        autoSignin: false,
        isAuthenticated: false,
        isLoading: false,
        isExpired: false,
        isStale: false,
        userName: undefined,
        error: undefined,
        getAccessToken: async () => undefined,
        signout: async () => {},
        interactiveSignin: async () => {},
        reauthenticate: async () => {},
        expandSession: async () => "not-signed-in"
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

interface ServerProviderProps {
  serverEnv: ServerEnv
  children: ReactNode
}

export function SessionProvider({ serverEnv, children }: Readonly<ServerProviderProps>) {
  // Support openid authentication and legacy yolo-who-needs-authentication mode. Split into two
  // impl components to conform to React hook rules.
  if(serverEnv.oidcProviderUrl !== undefined) {
    if(serverEnv.oidcClientId === undefined) {
      throw Error("OpenID provider configured but no client ID supplied");
    }

    return (
      <AuthenticatedSessionProvider
        autoSigninConfigured={serverEnv.oidcAutoSignin || false}
        providerUrl={serverEnv.oidcProviderUrl}
        clientId={serverEnv.oidcClientId}
        maxAge={serverEnv.oidcMaxAge}
      >
        {children}
      </AuthenticatedSessionProvider>
    );
  } else {
    return (
      <AnonymousSessionProvider>
        {children}
      </AnonymousSessionProvider>
    );
  }
}

export function useAppSession() {
  const tokenSource = useContext(SessionContext);

  if(tokenSource === null) {
    throw new Error("useAppSession must be used within SessionProvider");
  }

  return tokenSource;
}

"use client";

import { createContext, ReactNode, useContext, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { AuthProvider, ErrorContext, useAuth } from "react-oidc-context";
import { User } from "oidc-client-ts";
import { useRouter } from "next/navigation";
import { ServerEnv } from "../utils/serverEnv";

export type SessionTransition =
  "can-stream" | "cannot-stream" | "was-renewed";

export interface AppSession {
  authRequired: boolean
  autoSignin: boolean
  isAuthenticated: boolean
  isLoading: boolean
  isExpired: boolean | undefined
  isStale: boolean
  error: ErrorContext | undefined
  userName: string | undefined

  getAccessToken: () => Promise<string | undefined>
  signout: () => Promise<void>
  interactiveSignin: () => Promise<void>
  reauthenticate: () => Promise<void>
  expandSession: () => Promise<SessionTransition>
}

interface OidcSessionBridgeProps {
  maxAge: number | undefined
  autoSigninConfigured: boolean
  children?: ReactNode
}

interface SessionProviderProps {
  serverEnv: ServerEnv
  children: ReactNode
}

const SessionContext = createContext<AppSession | null>(null);

function sessionStaleAtMillis(user: User | null | undefined, maxAge: number | undefined) {
  if(user === undefined || user === null || maxAge === undefined || user.profile.auth_time === undefined) {
    return undefined;
  }

  const staleAt = (user.profile.auth_time + maxAge) * 1000;
  return staleAt > user.profile.iat * 1000 ? staleAt : 0;
}

function useIsStale(
  user: User | null | undefined,
  maxAge: number | undefined
) {
  const staleAt = sessionStaleAtMillis(user, maxAge);

  const subscribe = (onChange: () => void) => {
    if(staleAt === undefined) {
      return () => {};
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    const armTimer = () => {
      clearTimeout(timer);
      const remainingMillis = staleAt - Date.now();
      if(remainingMillis > 0) {
        const timeoutMillis = Math.min(remainingMillis, 2 ** 31 - 1);
        const timerAction = () => {
          onChange();
          armTimer();
        };

        timer = setTimeout(timerAction, timeoutMillis);
      }
    };

    const onVisibilityChange = () => {
      onChange();
      armTimer();
    };

    armTimer();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  };

  return useSyncExternalStore(
    subscribe,
    () => staleAt !== undefined && Date.now() >= staleAt,
    () => false
  );
}

/**
 * The part of the OidcSessionProvider logic that needs to sit inside AuthProvider, see below
 */
function OidcSessionBridge({ maxAge, autoSigninConfigured, children }: Readonly<OidcSessionBridgeProps>) {
  const [ autoSignin, setAutoSignin ] = useState(autoSigninConfigured);
  const auth = useAuth();
  const authRef = useRef(auth);
  const isStale = useIsStale(auth.user, maxAge);

  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  const userName =
    auth.user?.profile.preferred_username ??
    auth.user?.profile.name ??
    auth.user?.profile.email ??
    "The Nameless One";

  const pendingRenewal = useRef<Promise<User | null>>(undefined);

  const doRenewIfExpired = async () => {
    const freshUser = authRef.current.user;

    if(freshUser?.expired && freshUser.refresh_token !== undefined) {
      // If several calls arrive here at the same time, make the later ones wait for the
      // renewal attempt the first one kicked off rather than start their own, conflicting ones.
      if(pendingRenewal.current === undefined) {
        pendingRenewal.current = authRef.current.signinSilent()
          .catch(() => null)
          .finally(() => {
            pendingRenewal.current = undefined;
          });
      }

      return await pendingRenewal.current;
    }

    return freshUser;
  };

  const renewIfExpired = useEffectEvent(doRenewIfExpired);

  useEffect(() => {
    if(auth.user?.expired && auth.user.refresh_token !== undefined) {
      void renewIfExpired();
    }
  }, [auth.user]);

  const getAccessToken = async () => {
    // Renewal should not usually be necessary here, so this is largely a defensive-coding measure
    // and should be a nop. If it isn't, the user probably expired while the tab was inactive. In
    // that case we make a best effort to force-refresh.
    const freshUser = await doRenewIfExpired();

    if(freshUser === null || freshUser?.expired) {
      return undefined;
    }

    return freshUser?.access_token;
  };

  const signout = async () => {
    setAutoSignin(false);
    try {
      await authRef.current.removeUser();
    } catch(e) {
      console.error("Failed to sign out", e);
    }
  };

  const interactiveSignin = async () => {
    await authRef.current.signinPopup({ popupAbortOnClose: true });
  };

  const reauthenticate = async () => {
    // max_age: 0 to force-reauthenticate even when the session isn't stale.
    await authRef.current.signinPopup({ max_age: 0, popupAbortOnClose: true });
  };

  // Expanding the session headroom means refreshing the access token manually, so we have its full length at the beginning
  // of the recording.
  //
  // Refreshing the access token is best-effort and not all that necessary in normal deployments with short-lived access
  // tokens, but this way if a user likes access tokens that live long enough to cover a recording, then the access token
  // present at the beginning of the recording will not need renewal during the lecture.
  const expandSession = async () => {
    const currentUser = authRef.current.user;

    // user not logged in
    if(currentUser === null || currentUser === undefined) {
      return "cannot-stream";
    }

    // No refresh token, so force-refreshing is pointless. Refer to session expiration state.
    if(currentUser.refresh_token === undefined) {
      return currentUser.expired ? "cannot-stream" : "can-stream";
    }

    // Refresh access token, so it has as long a lifetime as we can manage.
    if(await authRef.current.signinSilent() !== null) {
      return "can-stream";
    }

    // If refreshing failed, log and refer to session expiration state.
    console.warn("Failed to force-refresh access/refresh token, continuing with existing tokens");

    const freshUser = authRef.current.user;
    if(freshUser === null || freshUser === undefined || freshUser.expired) {
      return "cannot-stream";
    }

    return "can-stream";
  };

  return (
    <SessionContext.Provider
      value={{
        authRequired: true,
        autoSignin: autoSignin,
        isAuthenticated: auth.isAuthenticated,
        isLoading: auth.isLoading,
        isExpired: auth.user?.expired,
        isStale: isStale,
        userName: userName,
        error: auth.error,
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

/**
 * OpenID connect session provider. Uses react-oidc-context, puts an OidcSessionBridge inside it, where
 * most of the actual work happens. This part sets up the AuthProvider and checks the server env for sanity.
 */
function OidcSessionProvider(
  { serverEnv, children }: Readonly<SessionProviderProps>
) {
  const router = useRouter();

  if(serverEnv.oidcProviderUrl === undefined) {
    throw Error("OpenID authentication is configured, but ISE_RECORD_OIDC_PROVIDER_URL is not set.");
  }

  if(serverEnv.oidcClientId === undefined) {
    throw Error("OpenID authentication is configured, but ISE_RECORD_OIDC_CLIENT_ID is not set.");
  }

  const callbackUrl = typeof window === "undefined"
    ? ""
    : `${window.location.origin}/auth/callback`;

  const onSigninCallback = (user: User | undefined) => {
    if(user !== undefined) {
      // This corresponds to a redirect sign-in, i.e. not in popup flows or silent renewal
      router.replace("/");
    }
  };

  return (
    <AuthProvider
      authority={serverEnv.oidcProviderUrl}
      client_id={serverEnv.oidcClientId}
      redirect_uri={callbackUrl}
      scope="openid profile email"
      automaticSilentRenew={true}
      accessTokenExpiringNotificationTimeInSeconds={120}
      max_age={serverEnv.oidcMaxAge}
      filterProtocolClaims={[ "nbf", "jti", "nonce", "acr", "amr", "azp", "at_hash" ]} // don't filter auth_time. Otherwise same as default.
      onSigninCallback={onSigninCallback}
    >
      <OidcSessionBridge
        autoSigninConfigured={serverEnv.oidcAutoSignin || false}
        maxAge={serverEnv.oidcMaxAge}
      >
        {children}
      </OidcSessionBridge>
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
        expandSession: async () => "can-stream"
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function SessionProvider({ serverEnv, children }: Readonly<SessionProviderProps>) {
  // Support openid authentication and legacy yolo-who-needs-authentication mode. Split into two
  // impl components to conform to React hook rules.

  // default to disabled in frontend-only deployments, oidc otherwise
  const authBackend = serverEnv.authBackend || (serverEnv.apiUrl ? "oidc" : "disabled");

  if(authBackend === "oidc") {
    return (
      <OidcSessionProvider serverEnv={serverEnv}>
        {children}
      </OidcSessionProvider>
    );
  } else if(authBackend === "disabled") {
    return (
      <AnonymousSessionProvider>
        {children}
      </AnonymousSessionProvider>
    );
  }

  throw new Error(`Invalid authentication backend "${serverEnv.authBackend}" configured, must be "oidc" or "disabled"`);
}

export function useAppSession() {
  const tokenSource = useContext(SessionContext);

  if(tokenSource === null) {
    throw new Error("useAppSession must be used within SessionProvider");
  }

  return tokenSource;
}

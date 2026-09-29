import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { ReactNode } from "react";
import { SessionProvider, useAppSession } from "@/lib/components/SessionProvider";
import { ServerEnv } from "@/lib/utils/serverEnv";

/**
 * The session provider is a thin layer over react-oidc-context: it configures AuthProvider,
 * and builds the app's session from what useAuth() reports. So react-oidc-context is what is
 * faked here -- an AuthProvider that records the props it is configured with, and a useAuth()
 * backed by a small store the tests set -- rather than the UserManager beneath it.
 *
 * The fake keeps to what the provider relies on the library for, and nothing more:
 *
 * - State is user, isLoading, isAuthenticated and error. isAuthenticated is "there is a
 *   user and their token has not expired", as the library computes it when a user loads.
 * - After mounting, AuthProvider loads the stored user into that state -- without raising a
 *   userLoaded event, which is what the old staleness watcher missed after a reload.
 *   renderAppSession() plays that part.
 * - signinSilent and signinPopup resolve with the new user and load it into the state, or,
 *   when they fail, resolve with null and put an error saying which method failed into the
 *   state. They do not reject.
 * - removeUser drops the user, and does reject when the user store refuses.
 */
const oidc = vi.hoisted(() => {
  interface FakeProfile {
    iat: number
    auth_time?: number
    preferred_username?: string
    name?: string
    email?: string
  }

  interface FakeUser {
    access_token: string
    refresh_token?: string
    expired: boolean
    profile: FakeProfile
  }

  interface FakeError extends Error {
    source: string
  }

  interface AuthState {
    user: FakeUser | null | undefined
    isLoading: boolean
    isAuthenticated: boolean
    error: FakeError | undefined
  }

  // what AuthProvider starts out with, before it has read the user store
  const initialState = (): AuthState => ({ user: undefined, isLoading: true, isAuthenticated: false, error: undefined });

  let state = initialState();
  const listeners = new Set<() => void>();

  const setState = (update: Partial<AuthState>) => {
    state = { ...state, ...update };
    listeners.forEach(listener => listener());
  };

  const loadUser = (user: FakeUser | null) => setState({
    user,
    isLoading: false,
    isAuthenticated: user !== null && !user.expired,
    error: undefined
  });

  /** What the next sign-in of each kind does: sign this user in, fail with this error, or neither. */
  const outcome = {
    signinSilent: null as FakeUser | Error | null,
    signinPopup: null as FakeUser | Error | null,
    /** Hold signinSilent open until this settles, so callers can pile up behind it. */
    signinSilentGate: null as Promise<void> | null,
    removeUser: null as Error | null
  };

  // How the library wraps each sign-in method: loading while it runs, the new user on success,
  // an error in the state and a null result on failure.
  const navigator = (source: "signinSilent" | "signinPopup") => async () => {
    setState({ isLoading: true });

    if(source === "signinSilent" && outcome.signinSilentGate !== null) {
      await outcome.signinSilentGate;
    }

    const result = outcome[source];

    if(result instanceof Error) {
      setState({ isLoading: false, error: Object.assign(result, { source }) });
      return null;
    }

    if(result === null) {
      setState({ isLoading: false });
      return null;
    }

    loadUser(result);
    return result;
  };

  const methods = {
    signinSilent: vi.fn(navigator("signinSilent")),
    signinPopup: vi.fn(navigator("signinPopup")),
    removeUser: vi.fn(async () => {
      if(outcome.removeUser !== null) {
        throw outcome.removeUser;
      }

      setState({ user: undefined, isAuthenticated: false });
    })
  };

  /** Every set of props AuthProvider was rendered with, latest last. */
  const providerProps: Record<string, unknown>[] = [];

  const reset = () => {
    state = initialState();
    listeners.clear();
    outcome.signinSilent = null;
    outcome.signinPopup = null;
    outcome.signinSilentGate = null;
    outcome.removeUser = null;
    providerProps.length = 0;
    Object.values(methods).forEach(method => method.mockClear());
  };

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    setState,
    loadUser,
    outcome,
    methods,
    providerProps,
    reset
  };
});

vi.mock("react-oidc-context", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  return {
    AuthProvider: (props: Record<string, unknown> & { children?: ReactNode }) => {
      oidc.providerProps.push(props);
      return props.children;
    },
    useAuth: () => {
      const state = React.useSyncExternalStore(oidc.subscribe, oidc.getState);
      // one object per state, as the library's context value is
      return React.useMemo(() => ({ ...state, ...oidc.methods }), [ state ]);
    }
  };
});

// useRouter needs an app-router context that renderHook does not provide. One shared
// replace, so a test can see where the provider navigated.
const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router
}));

const MAX_AGE_SECONDS = 25200;

const authenticatedEnv: ServerEnv = {
  apiUrl: "http://localhost:5000",
  oidcProviderUrl: "http://keycloak.localhost:8080/realms/ise",
  oidcClientId: "ise-recorder",
  oidcMaxAge: MAX_AGE_SECONDS,
  oidcAutoSignin: false
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A signed-in user whose authentication happened `ageSeconds` ago. */
const userAged = (
  ageSeconds: number,
  overrides: Partial<{
    access_token: string
    refresh_token: string
    expired: boolean
    iat: number
    preferred_username: string
    name: string
    email: string
  }> = {}
) => ({
  access_token: overrides.access_token ?? "current-token",
  refresh_token: overrides.refresh_token,
  expired: overrides.expired ?? false,
  profile: {
    auth_time: nowSeconds() - ageSeconds,
    iat: overrides.iat ?? nowSeconds(),
    preferred_username: overrides.preferred_username,
    name: overrides.name,
    email: overrides.email
  }
});

function providerWrapper(serverEnv: ServerEnv) {
  const Wrapper = ({ children }: Readonly<{ children: ReactNode }>) =>
    <SessionProvider serverEnv={serverEnv}>
      {children}
    </SessionProvider>;

  Wrapper.displayName = "SessionProviderTestWrapper";
  return Wrapper;
}

/** Let the provider's effects and whatever they started run their course. */
const settle = () => act(async () => {});

/**
 * Mount the provider, then load `stored` the way AuthProvider does once it has mounted: by
 * setting its state, without any event -- what happens on every page load, and after a
 * reload with a session still in the user store.
 *
 * Flushed inside act() rather than waited for, because waitFor() runs on timers, and the
 * staleness tests below install a fake clock before mounting.
 */
async function renderAppSession(serverEnv: ServerEnv, stored: ReturnType<typeof userAged> | null = null) {
  const rendered = renderHook(useAppSession, { wrapper: providerWrapper(serverEnv) });

  await act(async () => {
    oidc.loadUser(stored);
  });
  await settle();

  return rendered;
}

/** A user signs in or is renewed while the page is open. */
const signIn = (user: ReturnType<typeof userAged>) => act(async () => {
  oidc.loadUser(user);
});

/** The props AuthProvider was last rendered with. */
const authProviderProps = () => {
  expect(oidc.providerProps.length).toBeGreaterThan(0);
  return oidc.providerProps.at(-1)!;
};

beforeEach(() => {
  oidc.reset();
  localStorage.clear();
});

afterEach(() => {
  // unconditionally, so that a test which times out while the clock is faked cannot take
  // the rest of the file down with it
  vi.useRealTimers();
  localStorage.clear();
  vi.clearAllMocks();
});

test("useAppSession refuses to work outside a provider", () => {
  // React logs the render failure; the throw itself is what we are asserting on.
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    expect(() => renderHook(() => useAppSession()))
      .toThrow("useAppSession must be used within SessionProvider");
  } finally {
    consoleError.mockRestore();
  }
});

// --- which kind of deployment ---------------------------------------------
//
// Authentication is on by default wherever there is a backend to protect, so that running
// an open one takes ISE_RECORD_AUTH=disabled, written down on purpose. A deployment without
// a backend has nothing to authenticate against and defaults to anonymous.

/** Rendering fails outright: a deployment configured like this must not come up at all. */
function expectRenderToFail(serverEnv: ServerEnv) {
  // React logs the render failure; the throw itself is what we are asserting on
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    expect(() => renderHook(() => useAppSession(), { wrapper: providerWrapper(serverEnv) })).toThrow();
  } finally {
    consoleError.mockRestore();
  }
}

const PROVIDER = {
  oidcProviderUrl: "http://keycloak.localhost:8080/realms/ise",
  oidcClientId: "ise-recorder"
};

async function expectAnonymous(serverEnv: ServerEnv) {
  const { result } = await renderAppSession(serverEnv);

  expect(result.current.authRequired).toBe(false);
  expect(result.current.isAuthenticated).toBe(false);
  expect(await result.current.getAccessToken()).toBeUndefined();
  // there is no session to expand, and the backend takes uploads without one
  expect(await result.current.expandSession()).toBe("can-stream");
  // no authentication means no OIDC library at all
  expect(oidc.providerProps).toStrictEqual([]);
}

async function expectAuthenticationRequired(serverEnv: ServerEnv) {
  const { result } = await renderAppSession(serverEnv);

  expect(result.current.authRequired).toBe(true);
  authProviderProps();
}

test("a deployment without a backend is anonymous by default", async () => {
  await expectAnonymous({});
});

test("a deployment with a backend requires authentication by default", async () => {
  await expectAuthenticationRequired({ apiUrl: "http://localhost:5000", ...PROVIDER });
});

test("a deployment with a backend but no OpenID configuration does not render", () => {
  // what used to be an open deployment, by leaving the provider out; now it has to say so
  expectRenderToFail({ apiUrl: "http://localhost:5000" });
});

test("authentication can be turned off for a deployment with a backend", async () => {
  await expectAnonymous({ apiUrl: "http://localhost:5000", authBackend: "disabled" });
});

test("authentication can be turned on for a deployment without a backend", async () => {
  await expectAuthenticationRequired({ authBackend: "oidc", ...PROVIDER });
});

test("an empty auth setting falls back to the default", async () => {
  // ISE_RECORD_AUTH= with nothing after it, as the backend reads it too
  await expectAuthenticationRequired({ apiUrl: "http://localhost:5000", authBackend: "", ...PROVIDER });
  cleanup();
  oidc.reset();
  await expectAnonymous({ authBackend: "" });
});

test.each([ "none", "off", "OIDC", "Disabled" ])("an unknown auth setting (%s) does not render", value => {
  expectRenderToFail({ apiUrl: "http://localhost:5000", authBackend: value, ...PROVIDER });
});

test("OpenID without a provider URL does not render", () => {
  expectRenderToFail({ authBackend: "oidc", oidcClientId: "ise-recorder" });
});

test("OpenID without a client ID does not render", () => {
  expectRenderToFail({ authBackend: "oidc", oidcProviderUrl: PROVIDER.oidcProviderUrl });
});

test("an anonymous deployment never reports a stale or failed session", async () => {
  const { result } = await renderAppSession({ apiUrl: "http://localhost:5000", authBackend: "disabled" });

  // the banners key off these, and there is no session here to go stale or fail
  expect(result.current.isStale).toBe(false);
  expect(result.current.isExpired).toBe(false);
  expect(result.current.error).toBeUndefined();
  expect(result.current.autoSignin).toBe(false);
});

// --- how AuthProvider is configured ----------------------------------------

test("AuthProvider is configured from the server environment", async () => {
  await renderAppSession(authenticatedEnv);

  // max_age here does double duty: it enforces freshness on the interactive sign-in,
  // and it is what makes the provider include auth_time in the ID token at all.
  expect(authProviderProps()).toMatchObject({
    authority: "http://keycloak.localhost:8080/realms/ise",
    client_id: "ise-recorder",
    redirect_uri: `${window.location.origin}/auth/callback`,
    scope: "openid profile email",
    automaticSilentRenew: true,
    max_age: MAX_AGE_SECONDS
  });
});

test("max_age is left unset when the deployment does not configure one", async () => {
  await renderAppSession({ ...authenticatedEnv, oidcMaxAge: undefined });

  expect(authProviderProps().max_age).toBeUndefined();
});

test("auth_time is kept out of the claims the library filters from the profile", async () => {
  await renderAppSession(authenticatedEnv);

  // oidc-client-ts filters auth_time out of user.profile by default -- which is what it does
  // for any truthy setting that is not a list -- and that silently switches staleness
  // detection off: without auth_time a session never turns stale.
  const filter = authProviderProps().filterProtocolClaims;

  expect(Array.isArray(filter)).toBe(true);
  expect(filter).not.toContain("auth_time");
});

// --- what the session reports ----------------------------------------------

test("a signed-in user is reported as authenticated", async () => {
  const { result } = await renderAppSession(authenticatedEnv, userAged(60));

  expect(result.current.isAuthenticated).toBe(true);
  expect(result.current.isExpired).toBe(false);
});

test("nobody signed in is reported as unauthenticated", async () => {
  const { result } = await renderAppSession(authenticatedEnv);

  expect(result.current.isAuthenticated).toBe(false);
  expect(result.current.userName).toBe("The Nameless One");
});

test("the user name comes from the profile, with fallbacks for providers that send less", async () => {
  const { result } = await renderAppSession(authenticatedEnv, userAged(60, { preferred_username: "dozent", name: "Dr. Dozent" }));
  expect(result.current.userName).toBe("dozent");

  await signIn(userAged(60, { name: "Dr. Dozent", email: "dozent@example.edu" }));
  expect(result.current.userName).toBe("Dr. Dozent");

  await signIn(userAged(60, { email: "dozent@example.edu" }));
  expect(result.current.userName).toBe("dozent@example.edu");

  await signIn(userAged(60));
  expect(result.current.userName).toBe("The Nameless One");
});

test("the loading state and errors are passed through as the library reports them", async () => {
  const { result } = await renderAppSession(authenticatedEnv, userAged(60));

  await act(async () => {
    oidc.setState({ isLoading: true, error: Object.assign(new Error("provider unreachable"), { source: "renewSilent" }) });
  });

  expect(result.current.isLoading).toBe(true);
  expect(result.current.error?.message).toBe("provider unreachable");
});

// --- getAccessToken --------------------------------------------------------

test("getAccessToken returns the token of a signed-in user", async () => {
  const { result } = await renderAppSession(authenticatedEnv, userAged(60, { access_token: "current-token", refresh_token: "refresh" }));

  expect(await result.current.getAccessToken()).toBe("current-token");
  // a token that is still good is handed out as it is, refresh token or not
  expect(oidc.methods.signinSilent).not.toHaveBeenCalled();
});

test("getAccessToken returns nothing when nobody is signed in", async () => {
  const { result } = await renderAppSession(authenticatedEnv);

  expect(await result.current.getAccessToken()).toBeUndefined();
});

test("getAccessToken returns nothing for an expired user without a refresh token", async () => {
  const { result } = await renderAppSession(authenticatedEnv, userAged(60, { expired: true }));

  expect(await result.current.getAccessToken()).toBeUndefined();
  // without a refresh token a silent sign-in falls back to an iframe the provider does not
  // answer usefully
  expect(oidc.methods.signinSilent).not.toHaveBeenCalled();
});

// oidc-client-ts renews on a timer, which a background tab throttles and a discarded one
// never runs, and it does not renew at all when a page loads with a token that has already
// expired. getAccessToken is on the path of every upload, so it renews on demand when the
// timer did not get to.

/** getAccessToken inside act: a renewal loads the new user into the session's state. */
async function accessTokenFrom(getAccessToken: () => Promise<string | undefined>) {
  let token: string | undefined;
  await act(async () => {
    token = await getAccessToken();
  });
  return token;
}

test("getAccessToken renews an expired token with the refresh token", async () => {
  // signed in while the page is open, so the renewal on load is not what does it
  const { result } = await renderAppSession(authenticatedEnv);
  await signIn(userAged(60, { access_token: "stale-token", refresh_token: "refresh", expired: true }));
  oidc.outcome.signinSilent = userAged(0, { access_token: "renewed-token", refresh_token: "refresh" });
  oidc.methods.signinSilent.mockClear();

  expect(await accessTokenFrom(result.current.getAccessToken)).toBe("renewed-token");
  expect(oidc.methods.signinSilent).toHaveBeenCalledOnce();
  // and the rest of the app learns about it, so the "not signed in" notice goes away
  expect(result.current.isAuthenticated).toBe(true);
});

test("concurrent requests for a token share one renewal", async () => {
  // every track uploads its own chunks, so several of these arrive at once when the token
  // runs out; each starting its own refresh would at best waste requests, and at worst
  // trip refresh token rotation into failing all but one of them
  const { result } = await renderAppSession(authenticatedEnv, userAged(60, { refresh_token: "refresh" }));

  // captured the way a recording captures it, and called alongside the current one: the
  // renewal in flight has to be shared across renders, not only within one
  const capturedGetAccessToken = result.current.getAccessToken;

  let releaseRenewal: () => void = () => {};
  oidc.outcome.signinSilentGate = new Promise(resolve => {
    releaseRenewal = resolve;
  });
  oidc.outcome.signinSilent = userAged(0, { access_token: "renewed-token", refresh_token: "refresh" });
  await signIn(userAged(60, { access_token: "stale-token", refresh_token: "refresh", expired: true }));

  let tokens: (string | undefined)[] = [];
  await act(async () => {
    const pending = Promise.all([
      capturedGetAccessToken(),
      result.current.getAccessToken(),
      result.current.getAccessToken()
    ]);

    // let all three reach the renewal before it completes
    await new Promise(resolve => setTimeout(resolve, 0));
    releaseRenewal();
    tokens = await pending;
  });

  expect(tokens).toStrictEqual([ "renewed-token", "renewed-token", "renewed-token" ]);
  // the renewal the page itself started when the expired user arrived is the same one
  expect(oidc.methods.signinSilent).toHaveBeenCalledOnce();
});

test("a failed renewal yields no token rather than rejecting", async () => {
  // purgeRecording awaits this outside any try, so a rejection would leave the purge dialog
  // stuck in its busy state
  const { result } = await renderAppSession(authenticatedEnv);
  oidc.outcome.signinSilent = new Error("refresh token rejected");
  await signIn(userAged(60, { access_token: "stale-token", refresh_token: "refresh", expired: true }));

  // the expired token is not handed out as a fallback: the backend would only refuse it
  expect(await accessTokenFrom(result.current.getAccessToken)).toBeUndefined();
});

test("a failed renewal does not keep later requests from trying again", async () => {
  // the shared renewal is released once it has settled, however it settled -- otherwise one
  // failed refresh would stand in for every renewal after it, for the rest of the lecture
  const { result } = await renderAppSession(authenticatedEnv);
  oidc.outcome.signinSilent = new Error("provider unreachable");
  await signIn(userAged(60, { access_token: "stale-token", refresh_token: "refresh", expired: true }));

  expect(await accessTokenFrom(result.current.getAccessToken)).toBeUndefined();

  oidc.outcome.signinSilent = userAged(0, { access_token: "renewed-token", refresh_token: "refresh" });
  expect(await accessTokenFrom(result.current.getAccessToken)).toBe("renewed-token");
});

// A recording holds on to one getAccessToken for its whole length -- useStartStopRecording
// builds the ServerStorageDestination once and every chunk upload calls through it, for
// ninety minutes. Silent renewal replaces the user several times over that span, so the
// function has to read the *current* user rather than the one that was in scope when the
// recording started, or uploads start failing with 401 partway through the lecture.
test("a getAccessToken captured at the start of a recording follows later renewals", async () => {
  const { result } = await renderAppSession(authenticatedEnv, userAged(60, { access_token: "first-token" }));
  const capturedGetAccessToken = result.current.getAccessToken;

  await signIn(userAged(0, { access_token: "renewed-token" }));

  expect(await capturedGetAccessToken()).toBe("renewed-token");
});

// --- renewing on load --------------------------------------------------------
//
// The library does not renew a token that was already expired when it was loaded -- after a
// reload the next morning, say -- and reports such a user as not authenticated. The refresh
// token may well still work, so the page tries it once by itself.

test("a user whose token ran out before the page loaded is renewed without anyone asking", async () => {
  oidc.outcome.signinSilent = userAged(0, { access_token: "renewed-token", refresh_token: "refresh" });

  const { result } = await renderAppSession(
    authenticatedEnv,
    userAged(60, { access_token: "stale-token", refresh_token: "refresh", expired: true })
  );

  expect(oidc.methods.signinSilent).toHaveBeenCalledOnce();
  expect(result.current.isAuthenticated).toBe(true);
  expect(await result.current.getAccessToken()).toBe("renewed-token");
});

test("a renewal on load that fails is not tried again on every change of the session", async () => {
  // A failed attempt leaves the same expired user behind, and the session's state goes on
  // changing -- the attempt's own loading and error, a failed background renewal, anything
  // else the library reports. Retrying on each change would hammer the provider's token
  // endpoint for as long as the refresh token is refused, which may be forever. So a new
  // attempt takes a new user, not merely a new render.
  oidc.outcome.signinSilent = new Error("invalid_grant");

  const { result } = await renderAppSession(
    authenticatedEnv,
    userAged(60, { refresh_token: "refresh", expired: true })
  );

  // the session changes again once the failed attempt is well over
  await act(async () => {
    oidc.setState({ error: Object.assign(new Error("provider unreachable"), { source: "renewSilent" }) });
  });
  await settle();

  expect(oidc.methods.signinSilent).toHaveBeenCalledOnce();
  expect(result.current.isAuthenticated).toBe(false);
});

test.each([
  [ "nobody is signed in", null ],
  [ "the token is still good", userAged(60, { refresh_token: "refresh" }) ],
  [ "there is no refresh token to renew with", userAged(60, { expired: true }) ]
])("nothing is renewed on load when %s", async (_label, stored) => {
  await renderAppSession(authenticatedEnv, stored);

  expect(oidc.methods.signinSilent).not.toHaveBeenCalled();
});

// --- expandSession ---------------------------------------------------------
//
// Called when a recording starts, to decide whether it streams to the backend, and to give the
// access token as long a life as the provider allows. It asks nothing of the user: a session
// past max_age has its own banner offering to reauthenticate, and the recording goes ahead on
// whatever session there is.

test("nobody signed in cannot stream, and is not asked to sign in", async () => {
  const { result } = await renderAppSession(authenticatedEnv);

  expect(await result.current.expandSession()).toBe("cannot-stream");
  expect(oidc.methods.signinPopup).not.toHaveBeenCalled();
  expect(oidc.methods.signinSilent).not.toHaveBeenCalled();
});

test("a session without a refresh token streams on the token it has, without a refresh", async () => {
  const { result } = await renderAppSession(authenticatedEnv, userAged(60));

  expect(await result.current.expandSession()).toBe("can-stream");
  expect(oidc.methods.signinSilent).not.toHaveBeenCalled();
});

test("an expired session without a refresh token cannot stream", async () => {
  const { result } = await renderAppSession(authenticatedEnv, userAged(60, { expired: true }));

  expect(await result.current.expandSession()).toBe("cannot-stream");
  expect(oidc.methods.signinSilent).not.toHaveBeenCalled();
});

test("a session with a refresh token is refreshed before the recording starts", async () => {
  const { result } = await renderAppSession(authenticatedEnv, userAged(60, { refresh_token: "refresh" }));
  oidc.outcome.signinSilent = userAged(0, { access_token: "fresh-token", refresh_token: "refresh" });

  let transition;
  await act(async () => {
    transition = await result.current.expandSession();
  });

  expect(transition).toBe("can-stream");
  expect(oidc.methods.signinSilent).toHaveBeenCalledOnce();
  expect(await result.current.getAccessToken()).toBe("fresh-token");
});

test("a failed refresh with a token that still works streams on that token", async () => {
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    const { result } = await renderAppSession(authenticatedEnv, userAged(60, { refresh_token: "refresh" }));
    oidc.outcome.signinSilent = new Error("token endpoint hiccup");

    let transition;
    await act(async () => {
      transition = await result.current.expandSession();
    });

    expect(transition).toBe("can-stream");
  } finally {
    consoleWarn.mockRestore();
  }
});

test("a failed refresh on a dead token means the recording cannot stream", async () => {
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    oidc.outcome.signinSilent = new Error("refresh token rejected");
    const { result } = await renderAppSession(authenticatedEnv, userAged(60, { refresh_token: "refresh", expired: true }));

    let transition;
    await act(async () => {
      transition = await result.current.expandSession();
    });

    expect(transition).toBe("cannot-stream");
  } finally {
    consoleWarn.mockRestore();
  }
});

test("a stale session does not open a sign-in popup when the recording starts", async () => {
  // by design: the stale banner offers to reauthenticate, and a popup at the press of the
  // record button would only get between the lecturer and the lecture
  const { result } = await renderAppSession(authenticatedEnv, userAged(MAX_AGE_SECONDS + 600, { refresh_token: "refresh" }));
  oidc.outcome.signinSilent = userAged(MAX_AGE_SECONDS + 600, { refresh_token: "refresh" });

  let transition;
  await act(async () => {
    transition = await result.current.expandSession();
  });

  expect(transition).toBe("can-stream");
  expect(oidc.methods.signinPopup).not.toHaveBeenCalled();
});

// --- signing in and reauthenticating ------------------------------------------

test("an interactive sign-in is an ordinary popup sign-in", async () => {
  const { result } = await renderAppSession(authenticatedEnv);
  oidc.outcome.signinPopup = userAged(0, { access_token: "signed-in" });

  await act(() => result.current.interactiveSignin());

  expect(result.current.isAuthenticated).toBe(true);
  expect(await result.current.getAccessToken()).toBe("signed-in");

  const [ args ] = oidc.methods.signinPopup.mock.calls[0] as unknown as [ Record<string, unknown> ];
  // without it the library never notices a closed popup, and the session stays in its
  // loading state for good
  expect(args).toMatchObject({ popupAbortOnClose: true });
  // unlike reauthenticate: a user who still has a session with the provider should come
  // straight back rather than be made to type a password
  expect(args).not.toHaveProperty("max_age");
});

test("reauthenticate forces a fresh authentication rather than reusing the SSO session", async () => {
  const { result } = await renderAppSession(authenticatedEnv, userAged(MAX_AGE_SECONDS + 600));
  oidc.outcome.signinPopup = userAged(0, { access_token: "reauthenticated" });

  await act(() => result.current.reauthenticate());

  // max_age: 0 is what makes the provider ask again instead of silently confirming the
  // session that is already there
  expect(oidc.methods.signinPopup).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ max_age: 0, popupAbortOnClose: true }));
  expect(await result.current.getAccessToken()).toBe("reauthenticated");
  expect(result.current.isStale).toBe(false);
});

// --- signing out and the auto sign-in gate ----------------------------------

// Sign-out is local: it drops the stored user and leaves the provider's SSO session
// alone. That makes it a no-op in an auto-signin deployment unless something stops
// useAutoSignin from redirecting straight back in, which is what the autoSignin flag on
// the session is for. The page reads that flag instead of the environment.

test("auto sign-in is offered when the deployment configures it", async () => {
  const { result } = await renderAppSession({ ...authenticatedEnv, oidcAutoSignin: true });

  expect(result.current.autoSignin).toBe(true);
});

test("auto sign-in is not offered when the deployment does not configure it", async () => {
  const { result } = await renderAppSession(authenticatedEnv);

  expect(result.current.autoSignin).toBe(false);
});

test("signing out drops the session and stops signing back in", async () => {
  const { result } = await renderAppSession({ ...authenticatedEnv, oidcAutoSignin: true }, userAged(60));

  await act(() => result.current.signout());

  expect(oidc.methods.removeUser).toHaveBeenCalledOnce();
  expect(result.current.autoSignin).toBe(false);
  expect(result.current.isAuthenticated).toBe(false);
});

// Otherwise a failed removeUser leaves auto sign-in armed, and the next render loop sends
// the user who just asked to leave straight back to the provider. The flag has to be
// cleared first and the rejection swallowed, so signout never rejects into the button
// handler either -- UserMenu passes it straight to onPress.
test("a sign-out whose user store refuses still stops signing back in", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    const { result } = await renderAppSession({ ...authenticatedEnv, oidcAutoSignin: true }, userAged(60));
    oidc.outcome.removeUser = new Error("session storage unavailable");

    await act(async () => {
      await expect(result.current.signout()).resolves.toBeUndefined();
    });

    expect(result.current.autoSignin).toBe(false);
    // swallowed so it never reaches onPress, but not silently: the session is now in a
    // state the lecturer did not ask for and nothing else would say so
    expect(consoleError).toHaveBeenCalled();
  } finally {
    consoleError.mockRestore();
  }
});

// --- staleness ---------------------------------------------------------------
//
// A session past max_age is not expired -- its tokens still work -- but it is too old to
// count on for the length of a lecture, so the page says so and offers to reauthenticate.

test("a session within max_age is not stale", async () => {
  const { result } = await renderAppSession(authenticatedEnv, userAged(60));

  expect(result.current.isStale).toBe(false);
});

test("a session past max_age is stale", async () => {
  const { result } = await renderAppSession(authenticatedEnv, userAged(MAX_AGE_SECONDS + 600));

  expect(result.current.isStale).toBe(true);
});

test("a session loaded with the page turns stale exactly when it ages out", async () => {
  // The case that went unnoticed after a reload: the stored user reaches the page through
  // the library's state alone, with no userLoaded event, and nothing but the user arriving
  // there may be needed to arm the deadline.
  vi.useFakeTimers({ toFake: [ "setTimeout", "clearTimeout", "Date" ] });

  try {
    const remainingSeconds = 120;
    const { result } = await renderAppSession(authenticatedEnv, userAged(MAX_AGE_SECONDS - remainingSeconds));
    expect(result.current.isStale).toBe(false);

    // one second short of the deadline, nothing has changed
    await act(async () => {
      await vi.advanceTimersByTimeAsync((remainingSeconds - 1) * 1000);
    });
    expect(result.current.isStale).toBe(false);

    // and then it flips, without waiting out any polling interval
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.isStale).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("staleness is looked at again when the tab comes back", async () => {
  // A background tab throttles its timers, or does not run them at all while the laptop
  // sleeps. The clock moves past the deadline here without the timer firing; coming back
  // to the tab has to be enough to notice.
  vi.useFakeTimers({ toFake: [ "Date" ] });

  try {
    const { result } = await renderAppSession(authenticatedEnv, userAged(MAX_AGE_SECONDS - 60));
    expect(result.current.isStale).toBe(false);

    vi.setSystemTime(Date.now() + 120 * 1000);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(result.current.isStale).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("a fresh sign-in clears staleness", async () => {
  const { result } = await renderAppSession(authenticatedEnv, userAged(MAX_AGE_SECONDS + 600));
  expect(result.current.isStale).toBe(true);

  // a reauthentication elsewhere establishes a new session; the banner must clear without
  // waiting out any timer
  await signIn(userAged(0));

  expect(result.current.isStale).toBe(false);
});

test("signing out clears staleness", async () => {
  // with nobody signed in there is nothing to reauthenticate; the page says "not signed in"
  const { result } = await renderAppSession(authenticatedEnv, userAged(MAX_AGE_SECONDS + 600));
  expect(result.current.isStale).toBe(true);

  await act(() => result.current.signout());

  expect(result.current.isStale).toBe(false);
});

test("the token's own issue time wins when the local clock lags behind the provider", async () => {
  // Wall clock says the session is a minute old, but the provider issued the current token
  // far later than our clock believes. Trusting the wall clock would mean starting a lecture
  // on a session that is really long past max_age, so the more pessimistic of the two wins.
  const { result } = await renderAppSession(authenticatedEnv, userAged(60, { iat: nowSeconds() + 10 * MAX_AGE_SECONDS }));

  expect(result.current.isStale).toBe(true);
});

test.each([
  [ "the deployment configures no max_age", { ...authenticatedEnv, oidcMaxAge: undefined }, userAged(10 * MAX_AGE_SECONDS) ],
  [ "the provider sends no auth_time", authenticatedEnv, { ...userAged(10 * MAX_AGE_SECONDS), profile: { iat: nowSeconds() } } ]
])("a session never turns stale when %s", async (_label, serverEnv, stored) => {
  vi.useFakeTimers({ toFake: [ "setTimeout", "clearTimeout", "Date" ] });

  try {
    const { result } = await renderAppSession(serverEnv, stored as ReturnType<typeof userAged>);

    expect(result.current.isStale).toBe(false);
    // and nothing is waiting to change that
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

// --- the callback page -----------------------------------------------------
//
// Every sign-in flow ends on /auth/callback. After a redirect sign-in that window is the
// app's, and has to go back to it. After a popup or silent sign-in it is the popup or the
// iframe, which only reports back -- left to navigate, it would load the whole app in there,
// and with auto sign-in configured start a sign-in of its own. The library tells the two apart
// by what it hands onSigninCallback.

test("a redirect sign-in leaves the callback page for the app", async () => {
  await renderAppSession(authenticatedEnv);
  const onSigninCallback = authProviderProps().onSigninCallback as (user: unknown) => void;

  onSigninCallback(userAged(0));

  expect(router.replace).toHaveBeenCalledExactlyOnceWith("/");
});

test("a popup or silent sign-in leaves the callback page where it is", async () => {
  await renderAppSession(authenticatedEnv);
  const onSigninCallback = authProviderProps().onSigninCallback as (user: unknown) => void;

  onSigninCallback(undefined);

  expect(router.replace).not.toHaveBeenCalled();
});

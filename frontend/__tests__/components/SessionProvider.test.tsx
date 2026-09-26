import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { SessionProvider, useAppSession } from "@/lib/components/SessionProvider";
import { ServerEnv } from "@/lib/utils/serverEnv";

/**
 * The authenticated provider builds a real UserManager, which would talk to an OpenID
 * provider. Fake the class so the tests can hand it users, make signinSilent/signinPopup
 * fail on demand, inspect the settings it was constructed with, and fire the session
 * events the staleness watcher subscribes to.
 *
 * react-oidc-context is deliberately *not* mocked. AuthProvider is a thin reducer over
 * whatever UserManager it is handed -- it calls getUser() once, subscribes to
 * events.userLoaded/userUnloaded/userSignedOut/silentRenewError, and wraps the navigator
 * methods -- so this one fake drives both halves of the provider. Mocking useAuth as well
 * would mean keeping two fakes consistent by hand, and the interesting bugs live exactly
 * in the seam between them.
 */
const oidc = vi.hoisted(() => {
  // Mirrors oidc-client-ts: an array lists the claims to delete, anything falsy filters
  // nothing, and any other truthy value means the library default. The internally
  // required claims can never be removed.
  const DEFAULT_PROTOCOL_CLAIMS = [ "nbf", "jti", "auth_time", "nonce", "acr", "amr", "azp", "at_hash" ];
  const INTERNAL_REQUIRED_CLAIMS = [ "sub", "iss", "aud", "exp", "iat" ];

  function applyClaimFilter<T extends Record<string, unknown>>(claims: T, filterSetting: unknown): T {
    if(!filterSetting) {
      return { ...claims };
    }

    const toRemove = Array.isArray(filterSetting) ? filterSetting as string[] : DEFAULT_PROTOCOL_CLAIMS;
    const result: Record<string, unknown> = { ...claims };

    for(const claim of toRemove) {
      if(!INTERNAL_REQUIRED_CLAIMS.includes(claim)) {
        delete result[claim];
      }
    }

    return result as T;
  }

  interface FakeProfile extends Record<string, unknown> {
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

  type Listener = (...args: never[]) => void;

  class FakeUserManager {
    readonly settings: Record<string, unknown>;

    /**
     * What the user store holds. Assigning this is what the staleness watcher sees on its
     * next check; it does *not* reach the AuthProvider reducer, which only learns about
     * users through getUser() at mount and through the events below. Use signIn() to move
     * both at once.
     */
    user: FakeUser | null = null;

    /** Test-only: make getUser reject, as a blocked or corrupt user store does. */
    getUserError: Error | null = null;
    /** Test-only: what signinPopup does -- resolve with a user, or throw. */
    signinPopupResult: FakeUser | Error | null = null;
    /** Test-only: what signinSilent does -- resolve with a user, or throw. */
    signinSilentResult: FakeUser | Error | null = null;
    /** Test-only: hold signinSilent open until this settles, so callers can pile up behind it. */
    signinSilentGate: Promise<void> | null = null;
    /**
     * Test-only: the user closes the sign-in popup. Mirrors the library, which only notices
     * with popupAbortOnClose -- then it rejects with "Popup closed by user"; without it, the
     * sign-in never settles, which is what left the UI stuck in its loading state.
     */
    popupClosedByUser = false;
    /** Test-only: make removeUser reject, as a blocked or corrupt user store does. */
    removeUserError: Error | null = null;

    signinPopupCalls = 0;
    signinSilentCalls = 0;
    removeUserCalls = 0;
    stopSilentRenewCalls = 0;
    /** The args of each signinPopup call, so max_age=0 on a reauthenticate is observable. */
    signinPopupArgs: unknown[] = [];

    private listeners: Record<string, Set<Listener>> = {
      userLoaded: new Set(),
      userUnloaded: new Set(),
      userSignedOut: new Set(),
      silentRenewError: new Set()
    };

    constructor(settings: Record<string, unknown>) {
      this.settings = settings;
      instances.push(this);
    }

    private emit = (event: string, ...args: never[]) =>
      this.listeners[event].forEach(listener => listener(...args));

    // The real UserManager filters protocol claims once at sign-in and stores the
    // *result*, so getUser never sees the unfiltered set. Model that here: it is the
    // only thing that makes these tests notice if auth_time gets filtered away again.
    getUser = async (): Promise<FakeUser | null> => {
      if(this.getUserError !== null) {
        throw this.getUserError;
      }

      return this.user === null
        ? null
        : { ...this.user, profile: applyClaimFilter(this.user.profile, this.settings.filterProtocolClaims) };
    };

    signinSilent = async (): Promise<FakeUser | null> => {
      this.signinSilentCalls += 1;

      if(this.signinSilentGate !== null) {
        await this.signinSilentGate;
      }

      if(this.signinSilentResult instanceof Error) {
        throw this.signinSilentResult;
      }

      if(this.signinSilentResult !== null) {
        await this.events.load(this.signinSilentResult);
      }

      return this.signinSilentResult;
    };

    signinPopup = async (args?: unknown): Promise<FakeUser | null> => {
      this.signinPopupCalls += 1;
      this.signinPopupArgs.push(args);

      if(this.popupClosedByUser) {
        if((args as { popupAbortOnClose?: boolean } | undefined)?.popupAbortOnClose) {
          throw new Error("Popup closed by user");
        }

        return new Promise<never>(() => {});
      }

      if(this.signinPopupResult instanceof Error) {
        throw this.signinPopupResult;
      }

      if(this.signinPopupResult !== null) {
        await this.events.load(this.signinPopupResult);
      }

      return this.signinPopupResult;
    };

    /**
     * What AuthProvider calls on mount when the page URL carries a sign-in response. The real
     * one returns the user only for a redirect sign-in; a popup or silent callback hands the
     * response to the window that started it and returns nothing.
     */
    signinCallback = async (): Promise<FakeUser | undefined> => callback.user;

    removeUser = async (): Promise<void> => {
      this.removeUserCalls += 1;

      if(this.removeUserError !== null) {
        throw this.removeUserError;
      }

      this.user = null;
      await this.events.unload();
    };

    stopSilentRenew = () => {
      this.stopSilentRenewCalls += 1;
    };

    // The shape react-oidc-context subscribes to, plus load/unload: the real
    // UserManagerEvents exposes those and SessionProvider.reauthenticate calls load()
    // to put a user back after an aborted re-authentication.
    events = {
      addUserLoaded: (l: Listener) => this.listeners.userLoaded.add(l),
      removeUserLoaded: (l: Listener) => this.listeners.userLoaded.delete(l),
      addUserUnloaded: (l: Listener) => this.listeners.userUnloaded.add(l),
      removeUserUnloaded: (l: Listener) => this.listeners.userUnloaded.delete(l),
      addUserSignedOut: (l: Listener) => this.listeners.userSignedOut.add(l),
      removeUserSignedOut: (l: Listener) => this.listeners.userSignedOut.delete(l),
      addSilentRenewError: (l: Listener) => this.listeners.silentRenewError.add(l),
      removeSilentRenewError: (l: Listener) => this.listeners.silentRenewError.delete(l),

      load: async (user: FakeUser) => {
        this.user = user;
        this.emit("userLoaded", user as never);
      },
      unload: async () => {
        this.user = null;
        this.emit("userUnloaded");
      }
    };

    /** Test-only: the provider raised userLoaded without us going through a sign-in. */
    emitUserLoaded = () => this.emit("userLoaded", this.user as never);

    get listenerCount() {
      return this.listeners.userLoaded.size + this.listeners.userUnloaded.size;
    }
  }

  const instances: FakeUserManager[] = [];
  // set before mounting: the UserManager is built during the provider's render
  const callback: { user: FakeUser | undefined } = { user: undefined };
  return { FakeUserManager, instances, applyClaimFilter, callback };
});

vi.mock("oidc-client-ts", () => ({ UserManager: oidc.FakeUserManager }));

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
  overrides: Partial<{ access_token: string; refresh_token: string; expired: boolean; iat: number; preferred_username: string }> = {}
) => ({
  access_token: overrides.access_token ?? "current-token",
  refresh_token: overrides.refresh_token,
  expired: overrides.expired ?? false,
  profile: {
    auth_time: nowSeconds() - ageSeconds,
    iat: overrides.iat ?? nowSeconds(),
    preferred_username: overrides.preferred_username
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

/**
 * Mount the provider and wait for it to settle. Two async things run on mount: the
 * staleness watcher's first check, and AuthProvider's own getUser() -- until the latter
 * resolves the session reports isLoading, which is not the state any of these tests are
 * about.
 *
 * The UserManager is built inside the provider's render, so there is no way to seed it
 * with a user beforehand. Tests sign a user in afterwards with
 * `userManager().events.load(...)`, which is what the real library does at the end of
 * every sign-in and what both halves of the provider listen to.
 */
async function renderAppSession(serverEnv: ServerEnv) {
  const rendered = renderHook(useAppSession, { wrapper: providerWrapper(serverEnv) });

  // Both settle on microtasks, so flushing inside act() is enough -- and it has to be
  // enough, because waitFor() is driven by timers and two tests below install a fake
  // clock before mounting. A waitFor() under that clock never resolves, the test times
  // out before its useRealTimers() runs, and every later test in the file hangs too.
  await act(async () => {});
  expect(rendered.result.current.isLoading).toBe(false);

  return rendered;
}

/** The UserManager the authenticated provider just built. */
const userManager = () => {
  expect(oidc.instances.length).toBe(1);
  return oidc.instances[0];
};

beforeEach(() => {
  oidc.instances.length = 0;
  oidc.callback.user = undefined;
  localStorage.clear();
});

afterEach(() => {
  // unconditionally, so that a test which times out while the clock is faked cannot take
  // the rest of the file down with it
  vi.useRealTimers();
  oidc.instances.length = 0;
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

// --- unauthenticated deployments -------------------------------------------

test("an unconfigured deployment yields an anonymous session", async () => {
  const { result } = await renderAppSession({ apiUrl: "http://localhost:5000" });

  expect(result.current.authRequired).toBe(false);
  expect(result.current.isAuthenticated).toBe(false);
  expect(await result.current.getAccessToken()).toBeUndefined();
  expect(await result.current.expandSession()).toBe("not-signed-in");
  // no OpenID provider means no UserManager at all
  expect(oidc.instances.length).toBe(0);
});

test("an anonymous deployment never reports a stale or failed session", async () => {
  const { result } = await renderAppSession({ apiUrl: "http://localhost:5000" });

  // the banners key off these, and there is no session here to go stale or fail
  expect(result.current.isStale).toBe(false);
  expect(result.current.isExpired).toBe(false);
  expect(result.current.error).toBeUndefined();
  expect(result.current.autoSignin).toBe(false);
});

test("a provider URL without a client ID is a configuration error", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    const wrapper = providerWrapper({
      oidcProviderUrl: "http://keycloak.localhost:8080/realms/ise",
      oidcClientId: undefined
    });

    expect(() => renderHook(() => useAppSession(), { wrapper }))
      .toThrow("OpenID provider configured but no client ID supplied");
  } finally {
    consoleError.mockRestore();
  }
});

// --- how the UserManager is built ------------------------------------------

test("a configured deployment yields an authenticated session", async () => {
  const { result } = await renderAppSession(authenticatedEnv);

  expect(result.current.authRequired).toBe(true);
});

test("the UserManager is configured from the server environment", async () => {
  await renderAppSession(authenticatedEnv);

  // max_age here does double duty: it enforces freshness on the interactive sign-in,
  // and it is what makes the provider include auth_time in the ID token at all.
  expect(userManager().settings).toMatchObject({
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

  expect(userManager().settings.max_age).toBeUndefined();
});

test("auth_time survives whatever claim filtering the UserManager is configured with", async () => {
  await renderAppSession(authenticatedEnv);

  // oidc-client-ts filters auth_time out of user.profile by default, which silently
  // disables staleness detection entirely: no notice, and expandSession always
  // takes the silent-refresh branch instead of the popup. This asserts the setting
  // keeps it, whatever form the setting takes.
  const filtered = oidc.applyClaimFilter(
    { auth_time: 1, iat: 2 },
    userManager().settings.filterProtocolClaims
  );

  expect(filtered).toHaveProperty("auth_time");
});

// --- what the session reports ----------------------------------------------

test("a signed-in user is reported as authenticated", async () => {
  const { result } = await renderAppSession(authenticatedEnv);

  await act(() => userManager().events.load(userAged(60)));

  expect(result.current.isAuthenticated).toBe(true);
  expect(result.current.isExpired).toBe(false);
});

test("nobody signed in is reported as unauthenticated", async () => {
  const { result } = await renderAppSession(authenticatedEnv);

  expect(result.current.isAuthenticated).toBe(false);
  expect(result.current.userName).toBe("The Nameless One");
});

test("the user name comes from the profile, with a fallback for a provider that sends none", async () => {
  const { result } = await renderAppSession(authenticatedEnv);

  await act(() => userManager().events.load(userAged(60, { preferred_username: "dozent" })));
  expect(result.current.userName).toBe("dozent");

  await act(() => userManager().events.load(userAged(60)));
  expect(result.current.userName).toBe("The Nameless One");
});

// --- getAccessToken --------------------------------------------------------

test("getAccessToken returns the token of a signed-in user", async () => {
  const { result } = await renderAppSession(authenticatedEnv);

  await act(() => userManager().events.load(userAged(60, { access_token: "current-token", refresh_token: "refresh" })));

  expect(await result.current.getAccessToken()).toBe("current-token");
  // a token that is still good is handed out as it is, refresh token or not
  expect(userManager().signinSilentCalls).toBe(0);
});

test("getAccessToken returns nothing when nobody is signed in", async () => {
  const { result } = await renderAppSession(authenticatedEnv);

  expect(await result.current.getAccessToken()).toBeUndefined();
});

test("getAccessToken returns nothing for an expired user without a refresh token", async () => {
  const { result } = await renderAppSession(authenticatedEnv);

  await act(() => userManager().events.load(userAged(60, { access_token: "stale-token", expired: true })));

  expect(await result.current.getAccessToken()).toBeUndefined();
  // without a refresh token signinSilent would fall back to an iframe flow nobody configured
  expect(userManager().signinSilentCalls).toBe(0);
});

// oidc-client-ts renews on a timer, which a background tab throttles and a discarded one
// never runs, and it does not renew at all when a page loads with a token that has already
// expired. getAccessToken is on the path of every upload, so it renews on demand when the
// timer did not get to.

/** getAccessToken inside act: a renewal goes through AuthProvider and updates its state. */
async function accessTokenFrom(getAccessToken: () => Promise<string | undefined>) {
  let token: string | undefined;
  await act(async () => {
    token = await getAccessToken();
  });
  return token;
}

test("getAccessToken renews an expired token with the refresh token", async () => {
  const { result } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  await act(() => mgr.events.load(userAged(60, { access_token: "stale-token", refresh_token: "refresh", expired: true })));
  mgr.signinSilentResult = userAged(0, { access_token: "renewed-token", refresh_token: "refresh" });

  expect(await accessTokenFrom(result.current.getAccessToken)).toBe("renewed-token");
  expect(mgr.signinSilentCalls).toBe(1);
  // and the rest of the app learns about it, so the "not signed in" notice goes away
  expect(result.current.isAuthenticated).toBe(true);
});

test("concurrent requests for a token share one renewal", async () => {
  // every track uploads its own chunks, so several of these arrive at once when the token
  // runs out; each starting its own refresh would at best waste requests, and at worst
  // trip refresh token rotation into failing all but one of them
  const { result } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  // captured the way a recording captures it, and called alongside the current one: the
  // renewal in flight has to be shared across renders, not only within one
  const capturedGetAccessToken = result.current.getAccessToken;
  await act(() => mgr.events.load(userAged(60, { access_token: "stale-token", refresh_token: "refresh", expired: true })));

  let releaseRenewal: () => void = () => {};
  mgr.signinSilentGate = new Promise(resolve => {
    releaseRenewal = resolve;
  });
  mgr.signinSilentResult = userAged(0, { access_token: "renewed-token", refresh_token: "refresh" });

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
  expect(mgr.signinSilentCalls).toBe(1);
});

test("a failed renewal yields no token and is reported", async () => {
  const { result } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  await act(() => mgr.events.load(userAged(60, { access_token: "stale-token", refresh_token: "refresh", expired: true })));
  mgr.signinSilentResult = new Error("refresh token rejected");

  expect(await accessTokenFrom(result.current.getAccessToken)).toBeUndefined();
  // the expired token is not handed out as a fallback: the backend would only refuse it
  expect(result.current.error?.message).toBe("refresh token rejected");
});

test("a failed renewal does not keep later requests from trying again", async () => {
  // the shared renewal is released once it has settled, however it settled -- otherwise one
  // failed refresh would stand in for every renewal after it, for the rest of the lecture
  const { result } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  await act(() => mgr.events.load(userAged(60, { access_token: "stale-token", refresh_token: "refresh", expired: true })));

  mgr.signinSilentResult = new Error("provider unreachable");
  expect(await accessTokenFrom(result.current.getAccessToken)).toBeUndefined();

  mgr.signinSilentResult = userAged(0, { access_token: "renewed-token", refresh_token: "refresh" });
  expect(await accessTokenFrom(result.current.getAccessToken)).toBe("renewed-token");

  expect(mgr.signinSilentCalls).toBe(2);
  // and the recovery clears the error again
  expect(result.current.error).toBeUndefined();
});

test("getAccessToken yields nothing when the user store cannot be read", async () => {
  const { result } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  await act(() => mgr.events.load(userAged(60)));

  // every chunk upload during a lecture goes through this, and serverStorage treats a
  // rejection as a failed request rather than as an unauthenticated one -- so a browser
  // that blocks storage mid-recording would turn into upload errors instead of a
  // streaming-impeded warning
  mgr.getUserError = new Error("SecurityError: storage is not available");

  expect(await result.current.getAccessToken()).toBeUndefined();
});

// A recording holds on to one getAccessToken for its whole length -- useStartStopRecording
// builds the ServerStorageDestination once and every chunk upload calls through it, for
// ninety minutes. Silent renewal replaces the user several times over that span, so the
// function has to read the *current* user rather than the one that was in scope when the
// recording started, or uploads start failing with 401 partway through the lecture.
test("a getAccessToken captured at the start of a recording follows silent renewal", async () => {
  const { result } = await renderAppSession(authenticatedEnv);

  await act(() => userManager().events.load(userAged(60, { access_token: "first-token" })));

  // captured the way recordLecture captures it
  const capturedGetAccessToken = result.current.getAccessToken;

  await act(() => userManager().events.load(userAged(0, { access_token: "renewed-token" })));

  expect(await capturedGetAccessToken()).toBe("renewed-token");
});

// --- expandSession ---------------------------------------------------------

test("a fresh session is refreshed silently rather than through a popup", async () => {
  const { result } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  await act(() => mgr.events.load(userAged(60)));
  mgr.signinSilentResult = userAged(0, { access_token: "fresh-token" });

  await act(async () => {
    expect(await result.current.expandSession()).toBe("still-fresh");
  });

  expect(mgr.signinSilentCalls).toBe(1);
  expect(mgr.signinPopupCalls).toBe(0);
});

test("a stale session is renewed through a popup rather than silently", async () => {
  const { result } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  await act(() => mgr.events.load(userAged(MAX_AGE_SECONDS + 600)));
  mgr.signinPopupResult = userAged(0);

  await act(async () => {
    expect(await result.current.expandSession()).toBe("renewed");
  });

  expect(mgr.signinPopupCalls).toBe(1);
  expect(mgr.signinSilentCalls).toBe(0);
});

test("no session at all is treated as stale", async () => {
  const { result } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  mgr.user = null;
  mgr.signinPopupResult = userAged(0);

  await act(async () => {
    await result.current.expandSession();
  });

  expect(mgr.signinPopupCalls).toBe(1);
  expect(mgr.signinSilentCalls).toBe(0);
});

test("a deployment without max_age never treats a session as stale", async () => {
  const { result } = await renderAppSession({ ...authenticatedEnv, oidcMaxAge: undefined });
  const mgr = userManager();

  await act(() => mgr.events.load(userAged(10 * MAX_AGE_SECONDS)));
  mgr.signinSilentResult = userAged(0);

  await act(async () => {
    await result.current.expandSession();
  });

  expect(mgr.signinSilentCalls).toBe(1);
  expect(mgr.signinPopupCalls).toBe(0);
});

test("a provider that omits auth_time never treats a session as stale", async () => {
  const { result } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  const aged = userAged(10 * MAX_AGE_SECONDS);
  await act(() => mgr.events.load({ ...aged, profile: { iat: aged.profile.iat } }));
  mgr.signinSilentResult = userAged(0);

  await act(async () => {
    await result.current.expandSession();
  });

  expect(mgr.signinSilentCalls).toBe(1);
  expect(mgr.signinPopupCalls).toBe(0);
});

test("the token's own issue time wins when the local clock lags behind the provider", async () => {
  const { result } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  // Wall clock says the session is a minute old, but the provider issued the current
  // token far later than our clock believes. Trusting the wall clock would mean
  // starting a lecture on a session that is really long past max_age, so the more
  // pessimistic of the two has to win.
  await act(() => mgr.events.load(userAged(60, { iat: nowSeconds() + 10 * MAX_AGE_SECONDS })));
  mgr.signinPopupResult = userAged(0);

  await act(async () => {
    await result.current.expandSession();
  });

  expect(mgr.signinPopupCalls).toBe(1);
  expect(mgr.signinSilentCalls).toBe(0);
});

test("a silent refresh that fails on a dead token is reported as expired", async () => {
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    const { result } = await renderAppSession(authenticatedEnv);
    const mgr = userManager();

    // Within max_age, so the session is not stale and the silent branch is taken -- but
    // the access token died while the laptop was asleep and the refresh cannot revive it.
    // This is the case the whole impeded path exists for, and the silent branch reports it
    // through the only value that differs from its success value.
    await act(() => mgr.events.load(userAged(60, { expired: true })));
    mgr.signinSilentResult = new Error("refresh token rejected");

    await act(async () => {
      expect(await result.current.expandSession()).toBe("expired");
    });

    expect(mgr.signinPopupCalls).toBe(0);
  } finally {
    consoleWarn.mockRestore();
  }
});

test("a stale session's popup the user closes does not hold up the recording", async () => {
  // startRecording waits on this before it gets past "preparing"; a popup that never
  // settled left the record button disabled until the page was reloaded
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    const { result } = await renderAppSession(authenticatedEnv);
    const mgr = userManager();

    await act(() => mgr.events.load(userAged(MAX_AGE_SECONDS + 600)));
    mgr.popupClosedByUser = true;

    await act(async () => {
      expect(await settledWithin(result.current.expandSession())).toBe("still-stale");
    });

    expect(mgr.signinPopupCalls).toBe(1);
  } finally {
    consoleWarn.mockRestore();
  }
});

// react-oidc-context wraps every navigator method: it catches, dispatches an ERROR into
// its own state, and *resolves with null* rather than throwing. So the null return is the
// only signal that a sign-in failed, and these pin that expandSession reads it. Getting
// this wrong is quiet in both directions: a declined popup reported as "renewed" makes
// startRecording drop the user back to idle without a word, and it leaves "expired"
// unreachable -- which is the one value isStreamingImpeded() looks for, so a recording on
// a dead session would stream to the backend anyway with no warning.
test("a declined popup leaves a still-usable token reported as still-stale", async () => {
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    const { result } = await renderAppSession(authenticatedEnv);
    const mgr = userManager();

    await act(() => mgr.events.load(userAged(MAX_AGE_SECONDS + 600)));
    mgr.signinPopupResult = new Error("popup closed by user");

    await act(async () => {
      expect(await result.current.expandSession()).toBe("still-stale");
    });
  } finally {
    consoleWarn.mockRestore();
  }
});

test("a declined popup on an expired token is reported as expired", async () => {
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    const { result } = await renderAppSession(authenticatedEnv);
    const mgr = userManager();

    await act(() => mgr.events.load({ ...userAged(MAX_AGE_SECONDS + 600), expired: true }));
    mgr.signinPopupResult = new Error("popup closed by user");

    await act(async () => {
      expect(await result.current.expandSession()).toBe("expired");
    });
  } finally {
    consoleWarn.mockRestore();
  }
});

test("a failed popup with nobody signed in is reported as expired", async () => {
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    const { result } = await renderAppSession(authenticatedEnv);
    const mgr = userManager();

    mgr.user = null;
    mgr.signinPopupResult = new Error("provider unreachable");

    await act(async () => {
      expect(await result.current.expandSession()).toBe("expired");
    });
  } finally {
    consoleWarn.mockRestore();
  }
});

test("a hiccup refreshing a fresh session does not make it look stale", async () => {
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    const { result } = await renderAppSession(authenticatedEnv);
    const mgr = userManager();

    // The session is well within max_age; only the token refresh failed.
    await act(() => mgr.events.load(userAged(60)));
    mgr.signinSilentResult = new Error("token endpoint hiccup");

    // The refresh is advisory -- failing it says nothing about how old the session is,
    // so it must not be reported as staleness.
    await act(async () => {
      expect(await result.current.expandSession()).toBe("still-fresh");
    });
  } finally {
    consoleWarn.mockRestore();
  }
});

// --- signing in ------------------------------------------------------------

test("an interactive sign-in establishes a session", async () => {
  const { result } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  mgr.signinPopupResult = userAged(0, { access_token: "signed-in" });

  await act(() => result.current.interactiveSignin());

  expect(result.current.isAuthenticated).toBe(true);
  expect(await result.current.getAccessToken()).toBe("signed-in");
  // unlike reauthenticate, this is an ordinary sign-in: a user who still has a session
  // with the provider should come straight back rather than be made to type a password
  expect(mgr.signinPopupArgs.at(-1)).not.toMatchObject({ max_age: 0 });
});

test("a declined sign-in leaves the user signed out rather than rejecting", async () => {
  const { result } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  mgr.signinPopupResult = null;

  // UserMenu and AuthStatusMessage hand this straight to onPress, so a rejection here
  // becomes an unhandled one with nothing to catch it
  await act(async () => {
    await expect(result.current.interactiveSignin()).resolves.toBeUndefined();
  });

  expect(result.current.isAuthenticated).toBe(false);
});

/** Resolves with "still pending" if `promise` has not settled by then, rather than hanging the test. */
function settledWithin<T>(promise: Promise<T>, millis = 1000) {
  return Promise.race([ promise, new Promise<"still pending">(resolve => setTimeout(() => resolve("still pending"), millis)) ]);
}

test("a sign-in popup the user closes ends the sign-in rather than leaving it pending", async () => {
  // without popupAbortOnClose the library never notices, and the session stays in its
  // loading state for good: AuthStatusMessage spins, and nothing offers to sign in again
  const { result } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  mgr.popupClosedByUser = true;

  await act(async () => {
    expect(await settledWithin(result.current.interactiveSignin())).toBeUndefined();
  });

  expect(result.current.isLoading).toBe(false);
  expect(result.current.isAuthenticated).toBe(false);
  expect(result.current.error?.message).toBe("Popup closed by user");
});

// --- reauthenticate --------------------------------------------------------

test("reauthenticate forces a fresh authentication rather than reusing the SSO session", async () => {
  const { result } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  await act(() => mgr.events.load(userAged(60)));
  mgr.signinPopupResult = userAged(0, { access_token: "reauthenticated" });

  await act(() => result.current.reauthenticate());

  // max_age: 0 is what makes the provider re-prompt instead of silently confirming the
  // session that is already there
  expect(mgr.signinPopupArgs.at(-1)).toMatchObject({ max_age: 0 });
  expect(await result.current.getAccessToken()).toBe("reauthenticated");
});

test("an aborted reauthentication puts the previous user back", async () => {
  const { result } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  await act(() => mgr.events.load(userAged(60, { access_token: "still-good" })));

  // closing the popup resolves with null rather than throwing, and the user must not be
  // left signed out over it
  mgr.signinPopupResult = null;

  await act(() => result.current.reauthenticate());

  expect(result.current.isAuthenticated).toBe(true);
  expect(await result.current.getAccessToken()).toBe("still-good");
});

test("a reauthentication popup the user closes puts the previous user back", async () => {
  const { result } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  await act(() => mgr.events.load(userAged(60, { access_token: "still-good" })));
  mgr.popupClosedByUser = true;

  await act(async () => {
    expect(await settledWithin(result.current.reauthenticate())).toBeUndefined();
  });

  expect(await result.current.getAccessToken()).toBe("still-good");
});

// --- the staleness watcher -------------------------------------------------

test("the watcher reports a session past max_age as stale", async () => {
  const { result } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  await act(() => mgr.events.load(userAged(MAX_AGE_SECONDS + 600)));

  await waitFor(() => expect(result.current.isStale).toBe(true));
});

test("the watcher clears staleness when the session is renewed elsewhere", async () => {
  const { result } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  await act(() => mgr.events.load(userAged(MAX_AGE_SECONDS + 600)));
  await waitFor(() => expect(result.current.isStale).toBe(true));

  // a re-auth elsewhere establishes a new session; the banner must clear without
  // waiting out any poll interval
  await act(() => mgr.events.load(userAged(0)));

  await waitFor(() => expect(result.current.isStale).toBe(false));
});

test("the watcher flips the session to stale exactly when it ages out", async () => {
  vi.useFakeTimers({ toFake: [ "setTimeout", "clearTimeout", "Date" ] });

  try {
    const remainingSeconds = 120;
    const { result } = await renderAppSession(authenticatedEnv);
    const mgr = userManager();

    await act(() => mgr.events.load(userAged(MAX_AGE_SECONDS - remainingSeconds)));
    await act(async () => {});
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

test("a session that can never age out arms no timer at all", async () => {
  vi.useFakeTimers({ toFake: [ "setTimeout", "clearTimeout", "Date" ] });

  try {
    // no max_age configured, so only an event can ever change the verdict
    const { result } = await renderAppSession({ ...authenticatedEnv, oidcMaxAge: undefined });
    const mgr = userManager();

    await act(() => mgr.events.load(userAged(60)));
    await act(async () => {});

    expect(vi.getTimerCount()).toBe(0);
    expect(result.current.isStale).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("the watcher unsubscribes from the provider on unmount", async () => {
  const { unmount } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  await waitFor(() => expect(mgr.listenerCount).toBeGreaterThan(0));

  unmount();

  expect(mgr.listenerCount).toBe(0);
});

test("the silent renewal timer is stopped on unmount", async () => {
  const { unmount } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  expect(mgr.stopSilentRenewCalls).toBe(0);

  unmount();

  // automaticSilentRenew starts a timer that nothing else would ever stop
  expect(mgr.stopSilentRenewCalls).toBe(1);
});

// --- an unreadable user store ----------------------------------------------

// getUser rejects when the browser refuses storage access, or when the stored entry is
// damaged enough that JSON.parse throws. Neither is common, but the consequence used to
// be out of proportion: expandSession is awaited outside any try in startRecording, so
// the rejection escaped as an unhandled rejection and left the recorder wedged in
// "preparing" with no message and no way back but a reload.

test("an unreadable user store is treated as a stale session rather than crashing", async () => {
  const { result } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  mgr.getUserError = new Error("SecurityError: storage is not available");
  mgr.signinPopupResult = userAged(0);

  // stale rather than fresh: it must prompt for authentication, not skip the check
  await act(async () => {
    expect(await result.current.expandSession()).toBe("renewed");
  });

  expect(mgr.signinPopupCalls).toBe(1);
});

// The recovery path reads the store a second time to decide between "expired" and a
// session that is merely stale. An unguarded read there -- a store blocked by the browser,
// or damaged enough that JSON.parse throws -- would turn expandSession into a rejection,
// and startRecording would abandon the lecture with a "Recording failed" toast in exactly
// the case the impeded path exists for: fall back to recording locally, do not refuse to
// record at all.
test("an unreadable user store during popup recovery is reported as expired", async () => {
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    const { result } = await renderAppSession(authenticatedEnv);
    const mgr = userManager();

    await act(() => mgr.events.load(userAged(60)));

    // the store fails, so the session reads as stale and the popup is attempted -- and it
    // fails too. The recovery read then hits the same failure.
    mgr.getUserError = new Error("SyntaxError: Unexpected end of JSON input");
    mgr.signinPopupResult = new Error("popup closed by user");

    await act(async () => {
      expect(await result.current.expandSession()).toBe("expired");
    });
  } finally {
    consoleWarn.mockRestore();
  }
});

test("the staleness watcher flips to stale when the user store becomes unreadable", async () => {
  const { result } = await renderAppSession(authenticatedEnv);
  const mgr = userManager();

  // establish a genuinely fresh session first, so the assertion below has somewhere to
  // move from -- nobody-signed-in already reads as stale, which would make it vacuous
  await act(() => mgr.events.load(userAged(0)));
  expect(result.current.isStale).toBe(false);

  mgr.getUserError = new Error("storage unavailable");

  await act(async () => {
    mgr.emitUserLoaded();
  });

  // the watcher re-checks on provider events; a rejection there would leave the last
  // verdict standing and an unhandled rejection behind
  await waitFor(() => expect(result.current.isStale).toBe(true));
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
  const { result } = await renderAppSession({ ...authenticatedEnv, oidcAutoSignin: true });
  const mgr = userManager();

  await act(() => mgr.events.load(userAged(60)));

  await act(() => result.current.signout());

  expect(mgr.removeUserCalls).toBe(1);
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
    const { result } = await renderAppSession({ ...authenticatedEnv, oidcAutoSignin: true });
    const mgr = userManager();

    await act(() => mgr.events.load(userAged(60)));
    mgr.removeUserError = new Error("session storage unavailable");

    await act(async () => {
      await expect(result.current.signout()).resolves.toBeUndefined();
    });

    expect(mgr.removeUserCalls).toBe(1);
    expect(result.current.autoSignin).toBe(false);
    // swallowed so it never reaches onPress, but not silently: the session is now in a
    // state the lecturer did not ask for and nothing else would say so
    expect(consoleError).toHaveBeenCalled();
  } finally {
    consoleError.mockRestore();
  }
});

// --- the callback page -----------------------------------------------------
//
// Every sign-in flow ends on /auth/callback. After a redirect sign-in that window is the
// app's, and has to go back to it. After a popup sign-in it is the popup, which only reports
// back and is closed by the window that opened it -- left to navigate, it would load the whole
// app inside the popup, and with auto sign-in configured start a sign-in of its own there.

/**
 * Mount with a sign-in response in the URL, the way the callback page is loaded -- and in a
 * top-level window, which is where both a redirect and a popup sign-in end up. The suite runs
 * inside an iframe, where a window-based check would never navigate and a popup could not be
 * told from anything else. window.top cannot be replaced, but window.self can.
 */
async function renderOnCallbackPage() {
  const original = window.location.href;
  window.history.replaceState(null, "", `${window.location.pathname}?code=abc&state=xyz`);
  Object.defineProperty(window, "self", { value: window.top, configurable: true, writable: true });

  try {
    return await renderAppSession(authenticatedEnv);
  } finally {
    Object.defineProperty(window, "self", { value: window, configurable: true, writable: true });
    window.history.replaceState(null, "", original);
  }
}

test("a redirect sign-in leaves the callback page for the app", async () => {
  oidc.callback.user = userAged(0);

  await renderOnCallbackPage();

  expect(router.replace).toHaveBeenCalledExactlyOnceWith("/");
});

test("a popup or silent sign-in leaves the callback page where it is", async () => {
  oidc.callback.user = undefined;

  await renderOnCallbackPage();

  expect(router.replace).not.toHaveBeenCalled();
});

test("a page without a sign-in response navigates nowhere", async () => {
  // the provider sits in the root layout, so this is every other page of the app
  oidc.callback.user = userAged(0);

  await renderAppSession(authenticatedEnv);

  expect(router.replace).not.toHaveBeenCalled();
});

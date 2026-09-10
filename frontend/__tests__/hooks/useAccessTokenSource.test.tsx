import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { AppStoreProvider, useAppStore } from "@/lib/hooks/useAppStore";
import { AccessTokenSourceProvider, useAccessTokenSource } from "@/lib/hooks/useAccessTokenSource";
import { ServerEnv } from "@/lib/utils/serverEnv";

/**
 * The authenticated provider builds a real UserManager, which would talk to an OpenID
 * provider. Fake the class so the tests can hand it users, make signinSilent/signinPopup
 * fail on demand, inspect the settings it was constructed with, and fire the session
 * events the staleness watcher subscribes to.
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
  }

  interface FakeUser {
    access_token: string
    expired: boolean
    profile: FakeProfile
  }

  type Listener = () => void;

  class FakeUserManager {
    readonly settings: Record<string, unknown>;
    user: FakeUser | null = null;

    signinSilentCalls = 0;
    signinPopupCalls = 0;
    signinSilentResult: FakeUser | Error | null = null;
    signinPopupResult: FakeUser | Error | null = null;

    private userLoaded = new Set<Listener>();
    private userUnloaded = new Set<Listener>();

    constructor(settings: Record<string, unknown>) {
      this.settings = settings;
      instances.push(this);
    }

    // The real UserManager filters protocol claims once at sign-in and stores the
    // *result*, so getUser never sees the unfiltered set. Model that here: it is the
    // only thing that makes these tests notice if auth_time gets filtered away again.
    getUser = async (): Promise<FakeUser | null> =>
      (this.user === null
        ? null
        : { ...this.user, profile: applyClaimFilter(this.user.profile, this.settings.filterProtocolClaims) });

    signinSilent = async (): Promise<FakeUser | null> => {
      this.signinSilentCalls += 1;

      if(this.signinSilentResult instanceof Error) {
        throw this.signinSilentResult;
      }

      return this.signinSilentResult;
    };

    signinPopup = async (): Promise<FakeUser | null> => {
      this.signinPopupCalls += 1;

      if(this.signinPopupResult instanceof Error) {
        throw this.signinPopupResult;
      }

      return this.signinPopupResult;
    };

    stopSilentRenewCalls = 0;

    stopSilentRenew = () => {
      this.stopSilentRenewCalls += 1;
    };

    events = {
      addUserLoaded: (listener: Listener) => this.userLoaded.add(listener),
      removeUserLoaded: (listener: Listener) => this.userLoaded.delete(listener),
      addUserUnloaded: (listener: Listener) => this.userUnloaded.add(listener),
      removeUserUnloaded: (listener: Listener) => this.userUnloaded.delete(listener)
    };

    /** Test-only: pretend the provider raised userLoaded. */
    emitUserLoaded = () => this.userLoaded.forEach(listener => listener());

    get listenerCount() {
      return this.userLoaded.size + this.userUnloaded.size;
    }
  }

  const instances: FakeUserManager[] = [];
  return { FakeUserManager, instances, applyClaimFilter };
});

vi.mock("oidc-client-ts", () => ({ UserManager: oidc.FakeUserManager }));

// AuthProvider would drive the real sign-in flow; useRouter needs an app-router context
// that renderHook does not provide.
vi.mock("react-oidc-context", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() })
}));

const MAX_AGE_SECONDS = 25200;

const authenticatedEnv: ServerEnv = {
  apiUrl: "http://localhost:5000",
  oidcProviderUrl: "http://keycloak.localhost:8080/realms/ise",
  oidcClientId: "ise-recorder",
  oidcMaxAge: MAX_AGE_SECONDS
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A signed-in user whose authentication happened `ageSeconds` ago. */
const userAged = (ageSeconds: number, overrides: Partial<{ access_token: string; expired: boolean; iat: number }> = {}) => ({
  access_token: overrides.access_token ?? "current-token",
  expired: overrides.expired ?? false,
  profile: {
    auth_time: nowSeconds() - ageSeconds,
    iat: overrides.iat ?? nowSeconds()
  }
});

function providerWrapper(serverEnv: ServerEnv) {
  const Wrapper = ({ children }: Readonly<{ children: ReactNode }>) =>
    <AppStoreProvider serverEnv={serverEnv}>
      <AccessTokenSourceProvider>
        {children}
      </AccessTokenSourceProvider>
    </AppStoreProvider>;

  Wrapper.displayName = "TokenSourceTestWrapper";
  return Wrapper;
}

async function renderTokenSource(serverEnv: ServerEnv) {
  const rendered = renderHook(() => ({
    source: useAccessTokenSource(),
    staleSession: useAppStore(state => state.staleSession)
  }), { wrapper: providerWrapper(serverEnv) });

  // The staleness watcher kicks off an async check on mount. Settle it inside act()
  // so its store write does not land mid-test and trip React's warning.
  await act(async () => {});

  return rendered;
}

/** The UserManager the authenticated provider just built. */
const userManager = () => {
  expect(oidc.instances.length).toBe(1);
  return oidc.instances[0];
};

beforeEach(() => {
  oidc.instances.length = 0;
  localStorage.clear();
});

afterEach(() => {
  oidc.instances.length = 0;
  localStorage.clear();
});

test("useAccessTokenSource refuses to work outside a provider", () => {
  // React logs the render failure; the throw itself is what we are asserting on.
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    expect(() => renderHook(() => useAccessTokenSource()))
      .toThrow("useAccessTokenSource must be used within AccessTokenSourceProvider");
  } finally {
    consoleError.mockRestore();
  }
});

// --- unauthenticated deployments -------------------------------------------

test("an unconfigured deployment yields an anonymous token source", async () => {
  const { result } = await renderTokenSource({ apiUrl: "http://localhost:5000" });

  expect(result.current.source.authRequired).toBe(false);
  expect(await result.current.source.getAccessToken()).toBeUndefined();
  expect(await result.current.source.expandSessionHeadroom()).toBe("still-fresh");
  // no OpenID provider means no UserManager at all
  expect(oidc.instances.length).toBe(0);
});

test("a provider URL without a client ID is a configuration error", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    const wrapper = providerWrapper({
      oidcProviderUrl: "http://keycloak.localhost:8080/realms/ise",
      oidcClientId: undefined
    });

    expect(() => renderHook(() => useAccessTokenSource(), { wrapper }))
      .toThrow("OpenID provider configured but no client ID supplied");
  } finally {
    consoleError.mockRestore();
  }
});

// --- authenticated deployments ---------------------------------------------

test("a configured deployment yields an authenticated token source", async () => {
  const { result } = await renderTokenSource(authenticatedEnv);

  expect(result.current.source.authRequired).toBe(true);
});

test("the UserManager is configured from the server environment", async () => {
  await renderTokenSource(authenticatedEnv);

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
  await renderTokenSource({ ...authenticatedEnv, oidcMaxAge: undefined });

  expect(userManager().settings.max_age).toBeUndefined();
});

// --- getAccessToken --------------------------------------------------------

test("getAccessToken returns the token of a signed-in user", async () => {
  const { result } = await renderTokenSource(authenticatedEnv);
  userManager().user = userAged(60, { access_token: "current-token" });

  expect(await result.current.source.getAccessToken()).toBe("current-token");
});

test("getAccessToken returns nothing when nobody is signed in", async () => {
  const { result } = await renderTokenSource(authenticatedEnv);
  userManager().user = null;

  expect(await result.current.source.getAccessToken()).toBeUndefined();
});

test("getAccessToken returns nothing for an expired user", async () => {
  const { result } = await renderTokenSource(authenticatedEnv);
  userManager().user = userAged(60, { access_token: "stale-token", expired: true });

  expect(await result.current.source.getAccessToken()).toBeUndefined();
});

test("auth_time survives whatever claim filtering the UserManager is configured with", () => {
  renderTokenSource(authenticatedEnv);

  // oidc-client-ts filters auth_time out of user.profile by default, which silently
  // disables staleness detection entirely: no notice, and expandSessionHeadroom always
  // takes the silent-refresh branch instead of the popup. This asserts the setting
  // keeps it, whatever form the setting takes.
  const filtered = oidc.applyClaimFilter(
    { auth_time: 1, iat: 2 },
    userManager().settings.filterProtocolClaims
  );

  expect(filtered).toHaveProperty("auth_time");
});

// --- how staleness is decided ----------------------------------------------
//
// sessionIsStale is no longer part of the interface, so the decision is observed
// through the branch expandSessionHeadroom takes: a stale session goes to the popup,
// a fresh one to the silent refresh. The plain younger/older cases live in the
// expandSessionHeadroom section below; these are the edge cases.

test("no session at all is treated as stale", async () => {
  const { result } = await renderTokenSource(authenticatedEnv);
  const mgr = userManager();

  mgr.user = null;
  mgr.signinPopupResult = userAged(0);

  await result.current.source.expandSessionHeadroom();

  expect(mgr.signinPopupCalls).toBe(1);
  expect(mgr.signinSilentCalls).toBe(0);
});

test("a deployment without max_age never treats a session as stale", async () => {
  const { result } = await renderTokenSource({ ...authenticatedEnv, oidcMaxAge: undefined });
  const mgr = userManager();

  mgr.user = userAged(10 * MAX_AGE_SECONDS);
  mgr.signinSilentResult = userAged(0);

  await result.current.source.expandSessionHeadroom();

  expect(mgr.signinSilentCalls).toBe(1);
  expect(mgr.signinPopupCalls).toBe(0);
});

test("a provider that omits auth_time never treats a session as stale", async () => {
  const { result } = await renderTokenSource(authenticatedEnv);
  const mgr = userManager();

  const aged = userAged(10 * MAX_AGE_SECONDS);
  mgr.user = { ...aged, profile: { iat: aged.profile.iat } };
  mgr.signinSilentResult = userAged(0);

  await result.current.source.expandSessionHeadroom();

  expect(mgr.signinSilentCalls).toBe(1);
  expect(mgr.signinPopupCalls).toBe(0);
});

test("the token's own issue time wins when the local clock lags behind the provider", async () => {
  const { result } = await renderTokenSource(authenticatedEnv);
  const mgr = userManager();

  // Wall clock says the session is a minute old, but the provider issued the current
  // token far later than our clock believes. Trusting the wall clock would mean
  // starting a lecture on a session that is really long past max_age, so the more
  // pessimistic of the two has to win.
  mgr.user = userAged(60, { iat: nowSeconds() + 10 * MAX_AGE_SECONDS });
  mgr.signinPopupResult = userAged(0);

  await result.current.source.expandSessionHeadroom();

  expect(mgr.signinPopupCalls).toBe(1);
  expect(mgr.signinSilentCalls).toBe(0);
});

// --- expandSessionHeadroom -------------------------------------------------

test("a fresh session is refreshed silently rather than through a popup", async () => {
  const { result } = await renderTokenSource(authenticatedEnv);
  const mgr = userManager();

  mgr.user = userAged(60);
  mgr.signinSilentResult = userAged(0, { access_token: "fresh-token" });

  expect(await result.current.source.expandSessionHeadroom()).toBe("still-fresh");
  expect(mgr.signinSilentCalls).toBe(1);
  expect(mgr.signinPopupCalls).toBe(0);
});

test("a stale session is renewed through a popup rather than silently", async () => {
  const { result } = await renderTokenSource(authenticatedEnv);
  const mgr = userManager();

  mgr.user = userAged(MAX_AGE_SECONDS + 600);
  mgr.signinPopupResult = userAged(0);

  expect(await result.current.source.expandSessionHeadroom()).toBe("renewed");
  expect(mgr.signinPopupCalls).toBe(1);
  expect(mgr.signinSilentCalls).toBe(0);
});

test("a declined popup leaves a still-usable token reported as still-stale", async () => {
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    const { result } = await renderTokenSource(authenticatedEnv);
    const mgr = userManager();

    mgr.user = userAged(MAX_AGE_SECONDS + 600);
    mgr.signinPopupResult = new Error("popup closed by user");

    expect(await result.current.source.expandSessionHeadroom()).toBe("still-stale");
    expect(consoleWarn).toHaveBeenCalled();
  } finally {
    consoleWarn.mockRestore();
  }
});

test("a declined popup on an expired token is reported as expired", async () => {
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    const { result } = await renderTokenSource(authenticatedEnv);
    const mgr = userManager();

    mgr.user = { ...userAged(MAX_AGE_SECONDS + 600), expired: true };
    mgr.signinPopupResult = new Error("popup closed by user");

    expect(await result.current.source.expandSessionHeadroom()).toBe("expired");
  } finally {
    consoleWarn.mockRestore();
  }
});

test("a failed popup with nobody signed in is reported as expired", async () => {
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    const { result } = await renderTokenSource(authenticatedEnv);
    const mgr = userManager();

    mgr.user = null;
    mgr.signinPopupResult = new Error("provider unreachable");

    expect(await result.current.source.expandSessionHeadroom()).toBe("expired");
  } finally {
    consoleWarn.mockRestore();
  }
});

test("a hiccup refreshing a fresh session does not make it look stale", async () => {
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    const { result } = await renderTokenSource(authenticatedEnv);
    const mgr = userManager();

    // The session is well within max_age; only the token refresh failed.
    mgr.user = userAged(60);
    mgr.signinSilentResult = new Error("token endpoint hiccup");

    // The refresh is advisory -- failing it says nothing about how old the session is,
    // so it must not be reported as staleness. Sharing one catch across both branches
    // is what would break this.
    expect(await result.current.source.expandSessionHeadroom()).toBe("still-fresh");
  } finally {
    consoleWarn.mockRestore();
  }
});

// --- the staleness watcher -------------------------------------------------

test("the watcher publishes session staleness to the store on mount", async () => {
  const { result } = await renderTokenSource(authenticatedEnv);
  userManager().user = userAged(MAX_AGE_SECONDS + 600);

  await waitFor(() => {
    expect(result.current.staleSession).toBe(true);
  });
});

test("the watcher republishes when the provider raises userLoaded", async () => {
  const { result } = await renderTokenSource(authenticatedEnv);
  const mgr = userManager();

  mgr.user = userAged(MAX_AGE_SECONDS + 600);
  await waitFor(() => expect(result.current.staleSession).toBe(true));

  // a re-auth elsewhere establishes a new session; the banner must clear without
  // waiting out the poll interval
  mgr.user = userAged(0);
  mgr.emitUserLoaded();

  await waitFor(() => {
    expect(result.current.staleSession).toBe(false);
  });
});

test("the silent renewal timer is stopped on unmount", async () => {
  const { unmount } = await renderTokenSource(authenticatedEnv);
  const mgr = userManager();

  expect(mgr.stopSilentRenewCalls).toBe(0);

  unmount();

  // automaticSilentRenew starts a timer that nothing else would ever stop
  expect(mgr.stopSilentRenewCalls).toBe(1);
});

test("the watcher flips the session to stale exactly when it ages out", async () => {
  vi.useFakeTimers({ toFake: [ "setTimeout", "clearTimeout", "Date" ] });

  try {
    const remainingSeconds = 120;
    const { result } = await renderTokenSource(authenticatedEnv);
    userManager().user = userAged(MAX_AGE_SECONDS - remainingSeconds);

    // re-evaluate now that there is a user, so the timer is armed
    userManager().emitUserLoaded();
    await act(async () => {});
    expect(result.current.staleSession).toBe(false);

    // one second short of the deadline, nothing has changed
    await act(async () => {
      await vi.advanceTimersByTimeAsync((remainingSeconds - 1) * 1000);
    });
    expect(result.current.staleSession).toBe(false);

    // and then it flips, without waiting out any polling interval
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.staleSession).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("a session that can never age out arms no timer at all", async () => {
  vi.useFakeTimers({ toFake: [ "setTimeout", "clearTimeout", "Date" ] });

  try {
    // no max_age configured, so only an event can ever change the verdict
    const { result } = await renderTokenSource({ ...authenticatedEnv, oidcMaxAge: undefined });
    userManager().user = userAged(60);
    userManager().emitUserLoaded();
    await act(async () => {});

    expect(vi.getTimerCount()).toBe(0);
    expect(result.current.staleSession).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("the watcher unsubscribes from the provider on unmount", async () => {
  const { unmount } = await renderTokenSource(authenticatedEnv);
  const mgr = userManager();

  await waitFor(() => expect(mgr.listenerCount).toBeGreaterThan(0));

  unmount();

  expect(mgr.listenerCount).toBe(0);
});

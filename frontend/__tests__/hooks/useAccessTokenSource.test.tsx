import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { ReactNode } from "react";
import { AccessTokenSourceProvider, useAccessTokenSource } from "@/lib/hooks/useAccessTokenSource";
import { ServerEnv } from "@/lib/utils/serverEnv";

/**
 * The authenticated provider builds a real UserManager, which would talk to an OpenID
 * provider. Fake the class so the tests can hand it users, make signinSilent fail on
 * demand, and inspect both the settings it was constructed with and the arguments it
 * was called with.
 */
const oidc = vi.hoisted(() => {
  interface FakeUser {
    access_token: string
    expired: boolean
  }

  interface SigninSilentArgs {
    max_age?: number
    forceIframeAuth?: boolean
    silentRequestTimeoutInSeconds?: number
  }

  class FakeUserManager {
    readonly settings: Record<string, unknown>;
    user: FakeUser | null = null;
    signinSilentArgs: SigninSilentArgs[] = [];
    signinSilentResult: FakeUser | Error | null = null;

    constructor(settings: Record<string, unknown>) {
      this.settings = settings;
      instances.push(this);
    }

    getUser = async (): Promise<FakeUser | null> => this.user;

    signinSilent = async (args: SigninSilentArgs): Promise<FakeUser | null> => {
      this.signinSilentArgs.push(args);

      if(this.signinSilentResult instanceof Error) {
        throw this.signinSilentResult;
      }

      return this.signinSilentResult;
    };
  }

  const instances: FakeUserManager[] = [];
  return { FakeUserManager, instances };
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

const authenticatedEnv: ServerEnv = {
  apiUrl: "http://localhost:5000",
  oidcProviderUrl: "http://keycloak.localhost:8080/realms/ise",
  oidcClientId: "ise-recorder",
  oidcMaxAge: 25200
};

function renderTokenSource(serverEnv: ServerEnv) {
  const wrapper = ({ children }: Readonly<{ children: ReactNode }>) =>
    <AccessTokenSourceProvider serverEnv={serverEnv}>
      {children}
    </AccessTokenSourceProvider>;

  return renderHook(() => useAccessTokenSource(), { wrapper });
}

/** The UserManager the authenticated provider just built. */
const userManager = () => {
  expect(oidc.instances.length).toBe(1);
  return oidc.instances[0];
};

beforeEach(() => {
  oidc.instances.length = 0;
});

afterEach(() => {
  oidc.instances.length = 0;
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
  const { result } = renderTokenSource({ apiUrl: "http://localhost:5000" });

  expect(result.current.authRequired).toBe(false);
  expect(await result.current.getAccessToken()).toBeUndefined();
  expect(await result.current.refreshAccessToken()).toBeUndefined();
  // no OpenID provider means no UserManager at all
  expect(oidc.instances.length).toBe(0);
});

test("a provider URL without a client ID is a configuration error", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    expect(() => renderTokenSource({
      oidcProviderUrl: "http://keycloak.localhost:8080/realms/ise",
      oidcClientId: undefined
    })).toThrow("OpenID provider configured but no client ID supplied");
  } finally {
    consoleError.mockRestore();
  }
});

// --- authenticated deployments ---------------------------------------------

test("a configured deployment yields an authenticated token source", () => {
  const { result } = renderTokenSource(authenticatedEnv);

  expect(result.current.authRequired).toBe(true);
});

test("the UserManager is configured from the server environment", () => {
  renderTokenSource(authenticatedEnv);

  expect(userManager().settings).toMatchObject({
    authority: "http://keycloak.localhost:8080/realms/ise",
    client_id: "ise-recorder",
    redirect_uri: `${window.location.origin}/auth/callback`,
    scope: "openid profile email",
    automaticSilentRenew: true,
    max_age: 25200
  });
});

test("max_age is left unset when the deployment does not configure one", () => {
  renderTokenSource({ ...authenticatedEnv, oidcMaxAge: undefined });

  expect(userManager().settings.max_age).toBeUndefined();
});

// --- getAccessToken --------------------------------------------------------

test("getAccessToken returns the token of a signed-in user", async () => {
  const { result } = renderTokenSource(authenticatedEnv);
  userManager().user = { access_token: "current-token", expired: false };

  expect(await result.current.getAccessToken()).toBe("current-token");
});

test("getAccessToken returns nothing when nobody is signed in", async () => {
  const { result } = renderTokenSource(authenticatedEnv);
  userManager().user = null;

  expect(await result.current.getAccessToken()).toBeUndefined();
});

test("getAccessToken returns nothing for an expired user", async () => {
  const { result } = renderTokenSource(authenticatedEnv);
  userManager().user = { access_token: "stale-token", expired: true };

  expect(await result.current.getAccessToken()).toBeUndefined();
});

// --- refreshAccessToken ----------------------------------------------------

test("refreshAccessToken mints a new token through the authorization endpoint", async () => {
  const { result } = renderTokenSource(authenticatedEnv);
  const mgr = userManager();

  mgr.user = { access_token: "old-token", expired: false };
  mgr.signinSilentResult = { access_token: "fresh-token", expired: false };

  expect(await result.current.refreshAccessToken()).toBe("fresh-token");

  expect(mgr.signinSilentArgs.length).toBe(1);
  // forceIframeAuth is what makes max_age apply at all: without it signinSilent takes
  // the refresh-token path to the token endpoint, where max_age does not exist.
  expect(mgr.signinSilentArgs[0]).toStrictEqual({
    max_age: 25200,
    forceIframeAuth: true,
    silentRequestTimeoutInSeconds: 15
  });
});

test("a failed refresh falls back to the existing valid token", async () => {
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    const { result } = renderTokenSource(authenticatedEnv);
    const mgr = userManager();

    mgr.user = { access_token: "still-valid-token", expired: false };
    mgr.signinSilentResult = new Error("login_required");

    expect(await result.current.refreshAccessToken()).toBe("still-valid-token");
    expect(consoleWarn).toHaveBeenCalled();
  } finally {
    consoleWarn.mockRestore();
  }
});

test("a failed refresh yields nothing when the existing token has expired", async () => {
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    const { result } = renderTokenSource(authenticatedEnv);
    const mgr = userManager();

    mgr.user = { access_token: "stale-token", expired: true };
    mgr.signinSilentResult = new Error("login_required");

    expect(await result.current.refreshAccessToken()).toBeUndefined();
  } finally {
    consoleWarn.mockRestore();
  }
});

test("a failed refresh yields nothing when nobody is signed in", async () => {
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    const { result } = renderTokenSource(authenticatedEnv);
    const mgr = userManager();

    mgr.user = null;
    mgr.signinSilentResult = new Error("provider unreachable");

    expect(await result.current.refreshAccessToken()).toBeUndefined();
  } finally {
    consoleWarn.mockRestore();
  }
});

test("refreshAccessToken yields nothing when signinSilent resolves without a user", async () => {
  const { result } = renderTokenSource(authenticatedEnv);
  const mgr = userManager();

  mgr.user = null;
  mgr.signinSilentResult = null;

  expect(await result.current.refreshAccessToken()).toBeUndefined();
});

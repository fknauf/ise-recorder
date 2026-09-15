import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Provider } from "@react-spectrum/s2";
import { AppStoreProvider } from "@/lib/hooks/useAppStore";
import { AccessTokenSourceProvider } from "@/lib/hooks/useAccessTokenSource";
import Home from "@/app/page";

/**
 * This file deliberately does NOT mock react-oidc-context.
 *
 * Every other suite stubs it, which makes the mocks more forgiving than the library:
 * useAuth() really returns undefined outside an AuthProvider, and useAutoSignin()
 * dereferences that immediately. An unauthenticated deployment renders no AuthProvider
 * at all, so any hook from that library reachable on this path takes the whole page
 * down -- and the stubbed suites cannot see it.
 *
 * No OpenID provider is contacted: with no oidcProviderUrl configured the anonymous
 * branch is taken and no UserManager is ever built.
 */

afterEach(cleanup);

test("an unauthenticated deployment renders with the real react-oidc-context", async () => {
  render(
    <Provider>
      <AppStoreProvider serverEnv={{ apiUrl: "http://localhost:5000" }}>
        <AccessTokenSourceProvider>
          <Home/>
        </AccessTokenSourceProvider>
      </AppStoreProvider>
    </Provider>
  );

  // If a react-oidc-context hook runs on the anonymous path, this render throws and the
  // page never appears.
  expect(await screen.findByText("Start Recording")).toBeInTheDocument();
});

test("an unauthenticated deployment shows no authentication UI", async () => {
  render(
    <Provider>
      <AppStoreProvider serverEnv={{ apiUrl: "http://localhost:5000" }}>
        <AccessTokenSourceProvider>
          <Home/>
        </AccessTokenSourceProvider>
      </AppStoreProvider>
    </Provider>
  );

  await screen.findByText("Start Recording");

  expect(screen.queryByText(/Authenticating/i)).toBeNull();
  expect(screen.queryByText(/Authentication Error/i)).toBeNull();
  expect(screen.queryByText(/Session is Stale/i)).toBeNull();
});

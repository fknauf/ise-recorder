import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ReactNode, useEffect } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { AppStoreProvider, useAppStore } from "@/lib/hooks/useAppStore";
import { AccessTokenSourceContext, SessionExpansionResult } from "@/lib/hooks/useAccessTokenSource";
import { AuthStatusMessage } from "@/lib/components/AuthStatusMessage";
import { ActiveRecording } from "@/lib/store/store";

/**
 * The banners above the recorder: what the user is told about their session, and when.
 *
 * Everything here is about which message appears for a given state rather than how it
 * looks, so the assertions are on the text the user reads and on the one thing that
 * actually does something -- the reauthenticate button.
 */

// react-oidc-context is stubbed because AuthProvider is not mounted here. The stub is a
// mutable box rather than a fixed value so each test can set the auth state it needs, and
// it counts calls so the anonymous case can assert the library is never consulted at all.
const oidc = vi.hoisted(() => ({
  calls: 0,
  auth: { isAuthenticated: false, isLoading: false, error: undefined as Error | undefined }
}));

vi.mock("react-oidc-context", () => ({
  useAuth: () => {
    oidc.calls += 1;
    return oidc.auth;
  },
  AuthProvider: ({ children }: { children: ReactNode }) => children
}));

let setStaleSession: (stale: boolean) => void;
let setActiveRecording: (recording: ActiveRecording) => void;

/**
 * Hands the store's setters out so a test can put the app into the state it needs.
 * Published from an effect rather than during render: assigning to a variable outside the
 * component is a side effect, and doing it in the render body is a lint error.
 */
function StoreHandles() {
  const stale = useAppStore(state => state.setStaleSession);
  const active = useAppStore(state => state.setActiveRecording);

  useEffect(() => {
    setStaleSession = stale;
    setActiveRecording = active;
  }, [ stale, active ]);

  return null;
}

function renderMessage(
  {
    authRequired = true,
    expandSessionHeadroom = vi.fn(async (): Promise<SessionExpansionResult> => "still-fresh")
  } = {}
) {
  render(
    <Provider theme={defaultTheme}>
      <AppStoreProvider serverEnv={{}}>
        <AccessTokenSourceContext.Provider
          value={{ authRequired, getAccessToken: async () => "token", expandSessionHeadroom }}
        >
          <StoreHandles/>
          <AuthStatusMessage/>
        </AccessTokenSourceContext.Provider>
      </AppStoreProvider>
    </Provider>
  );

  return { expandSessionHeadroom };
}

const recording = (streamingImpeded: boolean): ActiveRecording =>
  ({ state: "recording", name: "GVS", stop: () => {}, streamingImpeded });

beforeEach(() => {
  oidc.calls = 0;
  oidc.auth = { isAuthenticated: false, isLoading: false, error: undefined };
});

afterEach(cleanup);

// --- the anonymous deployment ----------------------------------------------

test("an anonymous deployment shows nothing and never consults the OIDC library", () => {
  // even with auth in a state that would otherwise render an error
  oidc.auth = { isAuthenticated: false, isLoading: false, error: new Error("boom") };

  renderMessage({ authRequired: false });

  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/Authentication/i)).toBeNull();

  // the guard is load-bearing: with no AuthProvider mounted, useAuth() really returns
  // undefined and dereferencing it takes the whole page down. Reaching it at all is the bug.
  expect(oidc.calls).toBe(0);
});

// --- the authenticated states ----------------------------------------------

test("a healthy session shows no banner", () => {
  oidc.auth = { isAuthenticated: true, isLoading: false, error: undefined };

  renderMessage();

  expect(screen.queryByText(/Stale/i)).toBeNull();
  expect(screen.queryByText(/Authentication Error/i)).toBeNull();
});

test("a stale session warns and offers reauthentication", async () => {
  oidc.auth = { isAuthenticated: true, isLoading: false, error: undefined };

  renderMessage();
  act(() => setStaleSession(true));

  expect(screen.getByText("Authentication Session is Stale")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Reauthenticate/i })).toBeInTheDocument();
});

test("the reauthenticate button asks for more session headroom", async () => {
  oidc.auth = { isAuthenticated: true, isLoading: false, error: undefined };

  const { expandSessionHeadroom } = renderMessage();
  act(() => setStaleSession(true));

  await userEvent.click(screen.getByRole("button", { name: /Reauthenticate/i }));

  // the only thing on this banner that does anything; everything else is prose
  expect(expandSessionHeadroom).toHaveBeenCalled();
});

test("the warning clears once the session is fresh again", async () => {
  oidc.auth = { isAuthenticated: true, isLoading: false, error: undefined };

  renderMessage();
  act(() => setStaleSession(true));
  expect(screen.getByText("Authentication Session is Stale")).toBeInTheDocument();

  act(() => setStaleSession(false));

  expect(screen.queryByText("Authentication Session is Stale")).toBeNull();
});

// --- signing in and failing to ---------------------------------------------

test("a sign-in in progress is shown as loading rather than as a failure", () => {
  oidc.auth = { isAuthenticated: false, isLoading: true, error: undefined };

  renderMessage();

  expect(screen.getByText(/Authenticating/i)).toBeInTheDocument();
  // the not-yet-signed-in state must not be reported as an error while it is still working
  expect(screen.queryByText(/Authentication Error/i)).toBeNull();
});

test("a failed sign-in shows the reason", () => {
  oidc.auth = { isAuthenticated: false, isLoading: false, error: new Error("invalid_client") };

  renderMessage();

  expect(screen.getByText(/invalid_client/)).toBeInTheDocument();
});

test("a failed sign-in with no message still says something", () => {
  // not signed in, not loading and no error object: the provider never answered. The user
  // needs a banner rather than a silently empty page.
  renderMessage();

  expect(screen.getByText(/Unknown Error/)).toBeInTheDocument();
});

// --- the streaming warning -------------------------------------------------

test("an impeded recording warns that manual postprocessing is needed", () => {
  oidc.auth = { isAuthenticated: true, isLoading: false, error: undefined };

  renderMessage();
  act(() => setActiveRecording(recording(true)));

  expect(screen.getByText(/not being streamed/i)).toBeInTheDocument();
});

test("a recording that is streaming fine warns about nothing", () => {
  oidc.auth = { isAuthenticated: true, isLoading: false, error: undefined };

  renderMessage();
  act(() => setActiveRecording(recording(false)));

  expect(screen.queryByText(/not being streamed/i)).toBeNull();
});

test("the streaming warning is not shown while idle", () => {
  oidc.auth = { isAuthenticated: true, isLoading: false, error: undefined };

  renderMessage();

  expect(screen.queryByText(/not being streamed/i)).toBeNull();
});

test("a stale session and an impeded recording are both shown", () => {
  // they are independent: whichever combination holds, the user sees all of it
  oidc.auth = { isAuthenticated: true, isLoading: false, error: undefined };

  renderMessage();
  act(() => {
    setStaleSession(true);
    setActiveRecording(recording(true));
  });

  expect(screen.getByText("Authentication Session is Stale")).toBeInTheDocument();
  expect(screen.getByText(/not being streamed/i)).toBeInTheDocument();
});

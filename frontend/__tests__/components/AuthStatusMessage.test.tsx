import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ReactNode, useEffect } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { AppStoreProvider, useAppStore } from "@/lib/hooks/useAppStore";
import { AccessTokenSourceContext, SessionTransition } from "@/lib/hooks/useAccessTokenSource";
import { AuthStatusMessage } from "@/lib/components/AuthStatusMessage";
import { ActiveRecording } from "@/lib/store/store";
import { ServerEnv } from "@/lib/utils/serverEnv";

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

// Typed rather than inferred: with the literal inline, the parameter's type narrows to
// { apiUrl: string } and the no-backend test below cannot pass {}.
const DEFAULT_SERVER_ENV: ServerEnv = { apiUrl: "https://record.example.edu/api" };

function renderMessage(
  {
    authRequired = true,
    // The sign-in banner only makes sense where there is a backend to stream to, so the
    // component reads apiUrl. Default it to configured: that is the deployment every
    // authentication state below is interesting in.
    serverEnv = DEFAULT_SERVER_ENV,
    interactiveLogin = vi.fn(async () => {}),
    expandSessionHeadroom = vi.fn(async (): Promise<SessionTransition> => "still-fresh")
  } = {}
) {
  render(
    <Provider theme={defaultTheme}>
      <AppStoreProvider serverEnv={serverEnv}>
        <AccessTokenSourceContext.Provider
          value={{ authRequired, getAccessToken: async () => "token", interactiveLogin, expandSessionHeadroom }}
        >
          <StoreHandles/>
          <AuthStatusMessage/>
        </AccessTokenSourceContext.Provider>
      </AppStoreProvider>
    </Provider>
  );

  return { expandSessionHeadroom, interactiveLogin };
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
  // an error object with nothing in it still has to produce a banner rather than an empty
  // one, or the user is left staring at a heading and no reason
  oidc.auth = { isAuthenticated: false, isLoading: false, error: new Error("") };

  renderMessage();

  expect(screen.getByText(/Unknown Error/)).toBeInTheDocument();
});


// --- not signed in, which is not an error ----------------------------------

test("merely not being signed in is offered a way in rather than reported as a failure", () => {
  // Not signed in, not loading, no error: nothing has gone wrong, the user simply has not
  // authenticated yet. Reporting that as "Authentication Error" -- which is what this did
  // before sign-in stopped happening automatically on load -- tells them something broke.
  renderMessage();

  expect(screen.getByText("You are not authenticated")).toBeInTheDocument();
  expect(screen.queryByText(/Authentication Error/i)).toBeNull();
});


test("the sign-in banner says what is lost by staying signed out", () => {
  // The recording still works unauthenticated; it is only the upload that does not. Saying
  // so is what stops the banner from reading as "you cannot use this yet".
  renderMessage();

  expect(screen.getByText(/Streaming to backend is disabled/i)).toBeInTheDocument();
});


test("the sign-in button starts an interactive login", async () => {
  const { interactiveLogin } = renderMessage();

  await userEvent.click(screen.getByRole("button", { name: /Authenticate/i }));

  // the only control on this banner; everything else is prose
  expect(interactiveLogin).toHaveBeenCalled();
});


test.each([
  [ "signed out", { isAuthenticated: false, isLoading: false, error: undefined } ],
  [ "signing in", { isAuthenticated: false, isLoading: true, error: undefined } ],
  [ "failed to sign in", { isAuthenticated: false, isLoading: false, error: new Error("boom") } ],
  [ "signed in", { isAuthenticated: true, isLoading: false, error: undefined } ]
])("a deployment with no backend says nothing at all -- %s", (_label, authState) => {
  // Authentication only exists here to let the recorder stream to a backend. Without an
  // apiUrl nothing streams, so none of these states is the user's problem to solve and
  // every one of them would be asking about something they cannot act on. Whatever OIDC
  // is doing is the admin's business at that point, and it stays in the console.
  oidc.auth = authState;

  renderMessage({ serverEnv: {} });

  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/Authenticat/i)).toBeNull();
  expect(screen.queryByText(/not authenticated/i)).toBeNull();
});


test("a deployment with no backend keeps quiet about a stale session too", async () => {
  oidc.auth = { isAuthenticated: true, isLoading: false, error: undefined };

  renderMessage({ serverEnv: {} });
  act(() => setStaleSession(true));

  expect(screen.queryByText(/Stale/i)).toBeNull();
});


test("a real error outranks the invitation to sign in", () => {
  // Both branches match "not authenticated"; an error the provider actually reported is
  // the more useful thing to show.
  oidc.auth = { isAuthenticated: false, isLoading: false, error: new Error("invalid_client") };

  renderMessage();

  expect(screen.getByText(/invalid_client/)).toBeInTheDocument();
  expect(screen.queryByText("You are not authenticated")).toBeNull();
});

test("a sign-in that has not happened yet outranks a stale flag left in the store", () => {
  // staleSession is published by a watcher that runs independently of this component, so
  // it can still say "stale" for a session that is now gone. Offering "Reauthenticate" for
  // a session the user does not have sends them to the wrong button.
  oidc.auth = { isAuthenticated: false, isLoading: false, error: undefined };

  renderMessage();
  act(() => setStaleSession(true));

  expect(screen.getByText("You are not authenticated")).toBeInTheDocument();
  expect(screen.queryByText(/Stale/i)).toBeNull();
});


test("a retry in flight is shown as loading rather than as the error being retried", () => {
  // The error stays in state until the retry resolves, so both are set at once. Showing
  // the error the user just pressed a button about reads as if the retry had already
  // failed.
  oidc.auth = { isAuthenticated: false, isLoading: true, error: new Error("invalid_client") };

  renderMessage();

  expect(screen.getByText(/Authenticating/i)).toBeInTheDocument();
  expect(screen.queryByText(/invalid_client/)).toBeNull();
});


// --- errors from the background renewal -------------------------------------

test("a failed background renewal is surfaced while the user still counts as signed in", () => {
  // automaticSilentRenew failing raises silentRenewError, which the provider turns into an
  // auth error -- but it never re-dispatches the user, so isAuthenticated stays true until
  // something else happens to. If the banner only looks at errors while signed out, a
  // refresh token that died under the user is invisible until they try to record.
  oidc.auth = {
    isAuthenticated: true,
    isLoading: false,
    error: new Error("Token is not active")
  };

  renderMessage();

  expect(screen.getByText(/Token is not active/)).toBeInTheDocument();
});


test("the retry button on the error banner starts an interactive login", async () => {
  oidc.auth = {
    isAuthenticated: false,
    isLoading: false,
    error: new Error("invalid_client")
  };

  const { interactiveLogin } = renderMessage();

  await userEvent.click(screen.getByRole("button", { name: /Retry authentication/i }));

  expect(interactiveLogin).toHaveBeenCalled();
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

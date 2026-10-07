import { expect, test, vi } from "vitest";
import { anAppSession } from "../helpers/session";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { AppStoreProvider } from "@/lib/hooks/useAppStore";
import type { AppSession } from "@/lib/components/SessionProvider";
import { AuthStatusMessage } from "@/lib/components/AuthStatusMessage";
import { ServerEnv } from "@/lib/utils/serverEnv";

const mockUseAppSession = vi.fn();
vi.mock("@/lib/components/SessionProvider", () => ({
  useAppSession: () => mockUseAppSession()
}));

/**
 * An error the way react-oidc-context reports one: an Error that also says which of its
 * methods it came from. A failed popup sign-in unless the test says otherwise.
 */
const authError = (message: string, source = "signinPopup") => Object.assign(new Error(message), { source });

const DEFAULT_SERVER_ENV: ServerEnv = {
  apiUrl: "https://record.example.edu/api"
};

function renderMessage(
  {
    authRequired = true,
    serverEnv = DEFAULT_SERVER_ENV,
    isAuthenticated = false,
    isLoading = false,
    isStale = false,
    error = undefined as ReturnType<typeof authError> | undefined,
    interactiveSignin = vi.fn(async () => {}),
    reauthenticate = vi.fn(async () => {})
  } = {}
) {
  mockUseAppSession.mockReturnValue(anAppSession({
    authRequired,
    isAuthenticated,
    isLoading,
    isStale,
    // react-oidc-context's ErrorContext, of which the component reads the message and source
    error: error as AppSession["error"],
    interactiveSignin,
    reauthenticate
  }));

  render(
    <Provider theme={defaultTheme}>
      <AppStoreProvider serverEnv={serverEnv}>
        <AuthStatusMessage/>
      </AppStoreProvider>
    </Provider>
  );

  return { interactiveSignin, reauthenticate };
}

// --- the anonymous deployment ----------------------------------------------

test("an anonymous deployment shows nothing, whatever the session says", () => {
  // even with auth in a state that would otherwise render an error
  renderMessage({
    authRequired: false,
    isAuthenticated: false,
    isLoading: false,
    error: authError("boom")
  });

  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/Authentication/i)).toBeNull();
});

// --- the authenticated states ----------------------------------------------

test("a healthy session shows no banner", () => {
  renderMessage({
    isAuthenticated: true,
    isLoading: false
  });

  expect(screen.queryByText(/Stale/i)).toBeNull();
  expect(screen.queryByText(/Authentication Error/i)).toBeNull();
});

test("a stale session warns and offers reauthentication", async () => {
  const { reauthenticate } = renderMessage({
    isAuthenticated: true,
    isLoading: false,
    isStale: true
  });

  expect(screen.getByText("Authentication Session is Stale")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Reauthenticate/i })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /Reauthenticate/i }));
  expect(reauthenticate).toHaveBeenCalledOnce();
});

// --- signing in and failing to ---------------------------------------------

test("a sign-in in progress is shown as loading rather than as a failure", () => {
  renderMessage({ isLoading: true });

  expect(screen.getByText(/Authenticating/i)).toBeInTheDocument();
  expect(screen.queryByText(/Authentication Error/i)).toBeNull();
});

test("a failed sign-in with no message still says something", () => {
  renderMessage({
    isAuthenticated: false,
    isLoading: false,
    error: authError("")
  });

  expect(screen.getByText(/Unknown Error/)).toBeInTheDocument();
});


test("merely not being signed in is offered a way in rather than reported as a failure", async () => {
  const { interactiveSignin } = renderMessage();

  expect(screen.getByText("You are not authenticated")).toBeInTheDocument();
  expect(screen.queryByText(/Authentication Error/i)).toBeNull();
  expect(screen.getByText(/Streaming to backend is disabled/i)).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /Sign in/i }));

  expect(interactiveSignin).toHaveBeenCalled();
});

test.each([
  [ "signed out", { isAuthenticated: false, isLoading: false } ],
  [ "signing in", { isAuthenticated: false, isLoading: true } ],
  [ "failed to sign in", { isAuthenticated: false, isLoading: false, error: authError("boom") } ],
  [ "signed in", { isAuthenticated: true, isLoading: false } ],
  [ "stale", { isAuthenticated: true, isLoading: false, isStale: true }]
])("a deployment with no backend says nothing at all -- %s", (_label, authState) => {
  renderMessage({ serverEnv: {}, ...authState });

  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/Authenticat/i)).toBeNull();
  expect(screen.queryByText(/not authenticated/i)).toBeNull();
  expect(screen.queryByText(/Stale/i)).toBeNull();
});

// A silent refresh is the session looking after itself -- at every start of a recording, and
// whenever a token has run out -- and its failure leaves the session no worse off than before.
// The lecturer did not ask for it, and can do nothing about it that the page does not already
// offer: a dead session shows as not signed in anyway.

test("a failed silent refresh is not reported as an authentication error", () => {
  renderMessage({ isAuthenticated: true, error: authError("login_required", "signinSilent") });

  expect(screen.queryByText(/Authentication Error/i)).toBeNull();
  expect(screen.queryByText(/login_required/)).toBeNull();
});

test("a failed silent refresh on a dead session still offers the way back in", () => {
  renderMessage({ isAuthenticated: false, error: authError("invalid_grant", "signinSilent") });

  expect(screen.queryByText(/Authentication Error/i)).toBeNull();
  expect(screen.getByText("You are not authenticated")).toBeInTheDocument();
});

test("a failed background renewal is still reported", () => {
  // the library's own timed renewal, as opposed to the refreshes this app asks for
  renderMessage({ isAuthenticated: true, error: authError("provider unreachable", "renewSilent") });

  expect(screen.getByText(/provider unreachable/)).toBeInTheDocument();
});

test("a real error outranks the invitation to sign in", () => {
  renderMessage({ isAuthenticated: false, isLoading: false, error: authError("invalid_client") });

  expect(screen.getByText(/invalid_client/)).toBeInTheDocument();
  expect(screen.queryByText("You are not authenticated")).toBeNull();
});

test("a sign-in that has not happened yet outranks a stale flag left in the store", () => {
  renderMessage({ isAuthenticated: false, isStale: true });

  expect(screen.getByText("You are not authenticated")).toBeInTheDocument();
  expect(screen.queryByText(/Stale/i)).toBeNull();
});


test("a retry in flight is shown as loading rather than as the error being retried", () => {
  renderMessage({ isAuthenticated: false, isLoading: true, error: authError("invalid_client") });

  expect(screen.getByText(/Authenticating/i)).toBeInTheDocument();
  expect(screen.queryByText(/invalid_client/)).toBeNull();
});


test("the retry button on the error banner starts an interactive login", async () => {
  const { interactiveSignin } = renderMessage({
    isAuthenticated: false,
    isLoading: false,
    error: authError("invalid_client")
  });

  await userEvent.click(screen.getByRole("button", { name: /Retry authentication/i }));

  expect(interactiveSignin).toHaveBeenCalled();
});

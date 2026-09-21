import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { AppStoreProvider } from "@/lib/hooks/useAppStore";
import { SessionTransition } from "@/lib/components/SessionProvider";
import { AuthStatusMessage } from "@/lib/components/AuthStatusMessage";
import { ServerEnv } from "@/lib/utils/serverEnv";

const mockUseAppSession = vi.fn();
vi.mock("@/lib/components/SessionProvider", () => ({
  useAppSession: () => mockUseAppSession()
}));

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
    error = undefined as Error | undefined,
    interactiveSignin = vi.fn(async () => {}),
    expandSession = vi.fn(async (): Promise<SessionTransition> => "not-signed-in")
  } = {}
) {
  mockUseAppSession.mockReturnValue(
    {
      authRequired,
      autoSignin: false,
      isAuthenticated,
      isLoading,
      isStale,
      error,
      userName: "user-1",
      getAccessToken: async () => "token",
      signout: async () => {},
      interactiveSignin,
      expandSession
    }
  );

  render(
    <Provider theme={defaultTheme}>
      <AppStoreProvider serverEnv={serverEnv}>
        <AuthStatusMessage/>
      </AppStoreProvider>
    </Provider>
  );

  return { expandSession, interactiveSignin };
}

// --- the anonymous deployment ----------------------------------------------

test("an anonymous deployment shows nothing and never consults the OIDC library", () => {
  // even with auth in a state that would otherwise render an error
  renderMessage({
    authRequired: false,
    isAuthenticated: false,
    isLoading: false,
    error: new Error("boom")
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
  const { expandSession } = renderMessage({
    isAuthenticated: true,
    isLoading: false,
    isStale: true
  });

  expect(screen.getByText("Authentication Session is Stale")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Reauthenticate/i })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /Reauthenticate/i }));
  expect(expandSession).toHaveBeenCalled();
});

// --- signing in and failing to ---------------------------------------------

test("a sign-in in progress is shown as loading rather than as a failure", () => {
  renderMessage({ isLoading: true });

  expect(screen.getByText(/Authenticating/i)).toBeInTheDocument();
  expect(screen.queryByText(/Authentication Error/i)).toBeNull();
});

test("a failed sign-in shows the reason", () => {
  renderMessage({
    isAuthenticated: false,
    isLoading: false,
    error: new Error("invalid_client")
  });

  expect(screen.getByText(/invalid_client/)).toBeInTheDocument();
});

test("a failed sign-in with no message still says something", () => {
  renderMessage({
    isAuthenticated: false,
    isLoading: false,
    error: new Error("")
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
  [ "signed out", { isAuthenticated: false, isLoading: false, isError: false } ],
  [ "signing in", { isAuthenticated: false, isLoading: true, isError: false } ],
  [ "failed to sign in", { isAuthenticated: false, isLoading: false, error: new Error("boom") } ],
  [ "signed in", { isAuthenticated: true, isLoading: false, isError: false } ],
  [ "stale", { isAuthenticated: true, isLoading: false, isStale: true, isError: false }]
])("a deployment with no backend says nothing at all -- %s", (_label, authState) => {
  renderMessage({ serverEnv: {}, ...authState });

  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/Authenticat/i)).toBeNull();
  expect(screen.queryByText(/not authenticated/i)).toBeNull();
  expect(screen.queryByText(/Stale/i)).toBeNull();
});

test("a real error outranks the invitation to sign in", () => {
  renderMessage({ isAuthenticated: false, isLoading: false, error: new Error("invalid_client") });

  expect(screen.getByText(/invalid_client/)).toBeInTheDocument();
  expect(screen.queryByText("You are not authenticated")).toBeNull();
});

test("a sign-in that has not happened yet outranks a stale flag left in the store", () => {
  renderMessage({ isAuthenticated: false, isStale: true });

  expect(screen.getByText("You are not authenticated")).toBeInTheDocument();
  expect(screen.queryByText(/Stale/i)).toBeNull();
});


test("a retry in flight is shown as loading rather than as the error being retried", () => {
  renderMessage({ isAuthenticated: false, isLoading: true, error: new Error("invalid_client") });

  expect(screen.getByText(/Authenticating/i)).toBeInTheDocument();
  expect(screen.queryByText(/invalid_client/)).toBeNull();
});


// --- errors from the background renewal -------------------------------------

test("a failed background renewal is surfaced while the user still counts as signed in", () => {
  renderMessage({
    isAuthenticated: true,
    isLoading: false,
    error: new Error("Token is not active")
  });

  expect(screen.getByText(/Token is not active/)).toBeInTheDocument();
});

test("the retry button on the error banner starts an interactive login", async () => {
  const { interactiveSignin } = renderMessage({
    isAuthenticated: false,
    isLoading: false,
    error: new Error("invalid_client")
  });

  await userEvent.click(screen.getByRole("button", { name: /Retry authentication/i }));

  expect(interactiveSignin).toHaveBeenCalled();
});

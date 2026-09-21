import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { ReactNode } from "react";
import { UserMenu } from "@/lib/components/UserMenu";
import { AccessTokenSourceContext, useAccessTokenSource } from "@/lib/hooks/useAccessTokenSource";
import type { IdTokenClaims, User } from "oidc-client-ts";

/**
 * The user menu: who the app says you are, and the two ways out of that identity.
 *
 * Both of those ways are deliberate choices rather than the obvious ones, and the point
 * of this suite is to pin down why:
 *
 *  - Signing out is local only (removeUser). The end-session endpoint would end the SSO
 *    session for every app in the realm, which is not what a per-app sign-out button
 *    should do -- and it also cannot leave useAuth() in a clean state without a
 *    post-logout callback route.
 *  - Switching user is a sign-in with max_age: 0, which forces the provider to
 *    re-authenticate rather than silently handing back the account the SSO cookie
 *    already names.
 *
 * react-oidc-context is stubbed because no AuthProvider is mounted here. The stub is a
 * mutable box so each test can set the auth state it needs, and its methods are the real
 * subject of most assertions: what this component does is call them with the right
 * arguments and react to what they return.
 *
 * The stub has to export AuthProvider as well: mocking a module replaces all of it, and
 * useAccessTokenSource -- which the menu now reads signOut from -- imports AuthProvider
 * at module scope. Nothing here renders it.
 */

interface FakeAuth {
  isAuthenticated: boolean
  user?: User
  signinPopup: ReturnType<typeof vi.fn>
  events: { load: ReturnType<typeof vi.fn> }
}

const oidc = vi.hoisted(() => ({ auth: undefined as unknown as FakeAuth }));

vi.mock("react-oidc-context", () => ({
  useAuth: () => oidc.auth,
  AuthProvider: ({ children }: { children: ReactNode }) => children
}));

const mockUseAccessTokenSource = vi.fn();
vi.mock("@/lib/hooks/useAccessTokenSource", () => ({
  useAccessTokenSource: () => mockUseAccessTokenSource()
}));

/** Only the claims the menu reads; the rest of User never comes up here. */
const aUser = (profile: Partial<IdTokenClaims>) => ({ profile }) as unknown as User;

const LECTURER = aUser({ preferred_username: "lecturer" });

/**
 * Renders the menu and opens the popover, which is where everything lives.
 *
 * The mocks are built here rather than in a beforeEach so that each test gets fresh ones
 * regardless of when the suite-wide mockReset runs.
 */
async function renderMenu(state: { isAuthenticated?: boolean; user?: User } = {}) {
  const { isAuthenticated = true } = state;
  // not a default parameter: those fire on an explicitly passed undefined too, and a
  // couple of tests below are specifically about there being no user
  const user = "user" in state ? state.user : LECTURER;

  const signinPopup = vi.fn(async () => null as User | null);
  const load = vi.fn(async () => {});
  const signOut = vi.fn(async () => {});

  oidc.auth = { isAuthenticated, user, signinPopup, events: { load } };

  const tokenSource: ReturnType<typeof useAccessTokenSource> = {
    authRequired: true,
    autoSignin: false,
    getAccessToken: async () => "token",
    signOut,
    expandSessionHeadroom: async () => "still-fresh"
  };

  mockUseAccessTokenSource.mockReturnValue(tokenSource);

  render(
    <Provider theme={defaultTheme}>
      <UserMenu/>
    </Provider>
  );

  await userEvent.click(screen.getByRole("button", { name: "User menu" }));
  await screen.findByRole("dialog");

  return { signinPopup, load, signOut };
}

afterEach(cleanup);

// --- who you are -----------------------------------------------------------

test("the trigger says what it opens", async () => {
  // the trigger is an icon and nothing else, so without an explicit label it announces
  // nothing at all -- and every lookup in this file goes through that name
  await renderMenu();

  expect(screen.getByRole("button", { name: "User menu" })).toBeInTheDocument();
});

test("the menu names the account you are signed in as", async () => {
  await renderMenu();

  expect(screen.getByText(/Signed in as lecturer/)).toBeInTheDocument();
});

test.each([
  [ "preferred_username wins, because it is what the provider calls the account", { preferred_username: "lecturer", name: "Dr. Lecturer", email: "lecturer@example.edu" }, "lecturer" ],
  [ "the display name is next", { name: "Dr. Lecturer", email: "lecturer@example.edu" }, "Dr. Lecturer" ],
  [ "the address is better than nothing", { email: "lecturer@example.edu" }, "lecturer@example.edu" ],
  [ "and an ID token with none of them still names something", {}, "The Nameless" ]
])("%s", async (_label, profile, expected) => {
  // Every one of these claims is optional in the ID token -- scope "profile" asks for
  // name, it does not guarantee it, and an IdM with no first/last name set on the account
  // simply omits it. Falling off the end of the chain must not render "Signed in as".
  await renderMenu({ user: aUser(profile) });

  expect(screen.getByText(`Signed in as ${expected}`)).toBeInTheDocument();
});

test("a session with no user at all still renders rather than blanking out", async () => {
  // isAuthenticated and user are separate fields on the reducer state; nothing stops them
  // from disagreeing for a render or two.
  await renderMenu({ user: undefined });

  expect(screen.getByText("Signed in as The Nameless")).toBeInTheDocument();
});

// --- signing out -----------------------------------------------------------

test("signing out goes through the token source", async () => {
  // not auth.removeUser directly: signing out also has to inhibit auto sign-in for the
  // rest of the session, and that flag lives in the token source. Dropping the user here
  // instead would leave useAutoSignin to redirect straight back in.
  const { signinPopup, signOut } = await renderMenu();

  await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

  await waitFor(() => expect(signOut).toHaveBeenCalled());
  // no navigator method may be involved: signoutPopup/signoutSilent would end the SSO
  // session for every other app in the realm, and without a post-logout callback route
  // they leave useAuth() stuck on isLoading or holding an error
  expect(signinPopup).not.toHaveBeenCalled();
});

// --- switching user --------------------------------------------------------

test("switching user forces the provider to re-authenticate", async () => {
  const { signinPopup } = await renderMenu();

  await userEvent.click(screen.getByRole("button", { name: "Reauthenticate" }));

  // max_age: 0 is the whole feature. Without it the SSO cookie still names the current
  // account and the provider hands the same user straight back, so the button appears to
  // do nothing. It overrides the UserManager's configured max_age because an explicit 0
  // is not undefined, which is the only way a default parameter is skipped.
  //
  // popupAbortOnClose turns a closed popup into a rejection; without it the promise
  // never settles and the app sits on isLoading forever.
  expect(signinPopup).toHaveBeenCalledWith({ max_age: 0, popupAbortOnClose: true });
});

test("a cancelled switch puts the previous session back", async () => {
  // The wrapped navigator methods never reject: they swallow the error, record it in
  // auth.error and resolve with null. So cancelling leaves a signed-in user staring at an
  // authentication error banner. Re-raising userLoaded reduces to USER_LOADED, which
  // clears both the error and the loading flag in one dispatch.
  const { signinPopup, load } = await renderMenu();
  signinPopup.mockResolvedValue(null);

  await userEvent.click(screen.getByRole("button", { name: "Reauthenticate" }));

  await waitFor(() => expect(load).toHaveBeenCalledWith(LECTURER));
});

test("a switch that goes through is left alone", async () => {
  // The library has already dispatched the new user by then; re-raising the old one would
  // put the previous account back on screen.
  const { signinPopup, load } = await renderMenu();
  signinPopup.mockResolvedValue(aUser({ preferred_username: "assistant" }));

  await userEvent.click(screen.getByRole("button", { name: "Reauthenticate" }));

  await waitFor(() => expect(signinPopup).toHaveBeenCalled());
  expect(load).not.toHaveBeenCalled();
});

test("a cancelled switch with nothing to restore stays quiet", async () => {
  const { signinPopup, load } = await renderMenu({ user: undefined });
  signinPopup.mockResolvedValue(null);

  await userEvent.click(screen.getByRole("button", { name: "Reauthenticate" }));

  await waitFor(() => expect(signinPopup).toHaveBeenCalled());
  // there is no previous user to re-raise, and load(undefined) would throw inside the
  // library rather than restore anything
  expect(load).not.toHaveBeenCalled();
});

// --- signed out ------------------------------------------------------------

test("a signed-out menu offers a way in", async () => {
  await renderMenu({ isAuthenticated: false, user: undefined });

  expect(screen.getByText("Not signed in")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Reauthenticate" })).toBeNull();
});

test("signing in asks for an ordinary sign-in", async () => {
  const { signinPopup } = await renderMenu({ isAuthenticated: false, user: undefined });

  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

  // no max_age override here: signing in from scratch has nothing to re-authenticate
  // past, and forcing a password prompt on someone with a valid SSO session would be
  // gratuitous
  expect(signinPopup).toHaveBeenCalledWith();
});

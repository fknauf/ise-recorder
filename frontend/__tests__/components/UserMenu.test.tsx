import { expect, test, vi } from "vitest";
import { anAppSession } from "../helpers/session";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { UserMenu } from "@/lib/components/UserMenu";

const mockUseAppSession = vi.fn();
vi.mock("@/lib/components/SessionProvider", () => ({
  useAppSession: () => mockUseAppSession()
}));

/**
 * Renders the menu and opens the popover, which is where everything lives.
 *
 * The mocks are built here rather than in a beforeEach so that each test gets fresh ones
 * regardless of when the suite-wide mockReset runs.
 */
async function renderMenu(
  {
    isAuthenticated = false,
    userName = undefined as string | undefined
  } = {}
) {
  const interactiveSignin = vi.fn(async () => {});
  const reauthenticate = vi.fn(async () => {});
  const signout = vi.fn(async () => {});

  mockUseAppSession.mockReturnValue(anAppSession({ isAuthenticated, userName, signout, interactiveSignin, reauthenticate }));

  render(
    <Provider theme={defaultTheme}>
      <UserMenu/>
    </Provider>
  );

  await userEvent.click(screen.getByRole("button", { name: "User menu" }));
  await screen.findByRole("dialog");

  return { signout, interactiveSignin, reauthenticate };
}

// --- who you are -----------------------------------------------------------

test("the menu names the account you are signed in as", async () => {
  await renderMenu({ isAuthenticated: true, userName: "lecturer" });

  expect(screen.getByText(/Signed in as lecturer/)).toBeInTheDocument();
});

test("signing out goes through the token source", async () => {
  const { signout } = await renderMenu({ isAuthenticated: true, userName: "lecturer" });

  await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(signout).toHaveBeenCalled());
});

// --- switching user --------------------------------------------------------

test("switching user forces the provider to re-authenticate", async () => {
  const { reauthenticate } = await renderMenu({ isAuthenticated: true, userName: "lecturer" });

  await userEvent.click(screen.getByRole("button", { name: "Reauthenticate" }));
  expect(reauthenticate).toHaveBeenCalled();
});

test("a signed-out menu offers a way in", async () => {
  const { interactiveSignin } = await renderMenu({ isAuthenticated: false });

  expect(screen.getByText("Not signed in")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Reauthenticate" })).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(interactiveSignin).toHaveBeenCalled();
});

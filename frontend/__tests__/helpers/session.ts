import type { AppSession } from "@/lib/components/SessionProvider";

/**
 * What useAppSession hands out: by default a healthy, signed-in session in a deployment that
 * requires authentication. A test overrides whatever it is about.
 */
export const anAppSession = (overrides: Partial<AppSession> = {}): AppSession => ({
  authRequired: true,
  autoSignin: false,
  isAuthenticated: true,
  isLoading: false,
  isExpired: false,
  isStale: false,
  error: undefined,
  userName: "lecturer",
  getAccessToken: async () => "test-token",
  signout: async () => {},
  interactiveSignin: async () => {},
  reauthenticate: async () => {},
  expandSession: async () => "can-stream",
  ...overrides
});

import type { ServerEnv } from "@/lib/utils/serverEnv";

/**
 * A deployment's configuration as getServerEnv reads it: by default one that configures nothing
 * beyond what getServerEnv always fills in. A test sets whatever it is about.
 */
export const aServerEnv = (overrides: Partial<ServerEnv> = {}): ServerEnv => ({
  smtpRecipientOverride: "default",
  ...overrides
});

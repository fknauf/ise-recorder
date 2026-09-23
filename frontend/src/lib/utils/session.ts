import { UserManager } from "oidc-client-ts";

export interface SessionStaleness {
  stale: boolean
  recheckMillis?: number
}

export async function determineSessionStaleness(
  userMgr: UserManager,
  maxAge: number | undefined): Promise<SessionStaleness> {
  const user = await userMgr.getUser().catch(() => null);

  if(user === null) {
    return { stale: true };
  }

  if(maxAge === undefined || user.profile.auth_time === undefined) {
    return { stale: false };
  }

  const staleAtMillis = (user.profile.auth_time + maxAge) * 1000;
  // adjust for clock drift: normally, Date.now() is after the current access token's iat. If not, then
  // the server clock and our clock are misaligned. Use iat then because it's closer to the server's now.
  const approxNowMillis = Math.max(user.profile.iat * 1000, Date.now());
  const remainingMillis = staleAtMillis - approxNowMillis;

  return remainingMillis > 0
    ? { stale: false, recheckMillis: remainingMillis }
    : { stale: true };
}

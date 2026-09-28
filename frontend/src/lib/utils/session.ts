import { UserManager } from "oidc-client-ts";

export interface SessionStaleness {
  stale: boolean
  recheckMillis?: number
}

// Narrow question: Is the session stale, and if not and the point in time when it turns stale is known,
// when does it turn stale?
//
// This is used to derive the isStale indicator in useAppSession. When there is no session or there is an
// error, this will report the session as not stale, so "not stale" does not carry any indication about
// the health or existence of the session. No one logged in -> not stale. oidc provider not reachable ->
// not stale. Etc.
export async function determineSessionStaleness(
  userMgr: UserManager,
  maxAge: number | undefined): Promise<SessionStaleness> {
  const user = await userMgr.getUser().catch(() => null);

  if(user === null || maxAge === undefined || user.profile.auth_time === undefined) {
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

/**
 * The response headers the proxy puts on every page.
 *
 * Here rather than with the browser suite because the proxy runs on the server: it uses
 * node's Buffer, and NextRequest/NextResponse are the server-side ones.
 */

import { afterEach, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../../src/proxy";

const headersFor = (path: string) =>
  proxy(new NextRequest(`http://localhost:3000${path}`)).headers;

afterEach(() => {
  vi.unstubAllEnvs();
});

// --- Cross-Origin-Opener-Policy ----------------------------------------------
//
// The sign-in popup reaches the callback page from the provider's pages, which send no COOP.
// A COOP on the callback page counts as a mismatch: the browser cuts the popup off from the
// app, window.opener is null in the popup and popup.closed is true in the app, and
// popupAbortOnClose then throws away sign-ins that just succeeded. Everywhere else, the app
// keeps its opener policy.

test.each([
  "/",
  "/?lecture=GVS",
  "/some/page",
  // exempting more than the callback itself would quietly weaken every page it matched
  "/auth",
  "/auth/callbacks",
  "/auth/callback/elsewhere"
])("%s keeps its opener policy", path => {
  expect(headersFor(path).get("Cross-Origin-Opener-Policy")).toBe("same-origin-allow-popups");
});

test.each([
  "/auth/callback",
  // how the popup actually arrives there: with the provider's response in the query
  "/auth/callback?code=abc&state=xyz",
  "/auth/callback?error=access_denied&state=xyz"
])("%s sends no opener policy", path => {
  expect(headersFor(path).has("Cross-Origin-Opener-Policy")).toBe(false);
});

test("the callback page keeps its content security policy", () => {
  // only COOP is lifted there; the page still runs script, and its CSP matters as much as
  // anywhere else's
  vi.stubEnv("ISE_RECORD_OIDC_PROVIDER_URL", "http://keycloak.localhost:8080/realms/ise");

  const csp = headersFor("/auth/callback?code=abc&state=xyz").get("Content-Security-Policy");

  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'nonce-");
});

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ServerEnv } from "@/lib/utils/serverEnv";

/**
 * Covers the deployment-configuration parsing in serverEnv.
 *
 * validateBackendUrl is not exported and getServerEnv memoizes its result in a module
 * level variable, so each case imports a fresh copy of the module. vi.resetModules()
 * is unavailable in browser mode -- it reloads the page -- so a cache-busting query
 * suffix is used instead, which Vite treats as a distinct module.
 *
 * next/server is stubbed: connection() marks the render dynamic, which is meaningless
 * outside a request and unavailable in a browser test.
 */

vi.mock("next/server", () => ({ connection: async () => {} }));

const ENV_KEYS = [
  "ISE_RECORD_API_URL",
  "ISE_RECORD_OIDC_PROVIDER_URL",
  "ISE_RECORD_OIDC_CLIENT_ID",
  "ISE_RECORD_OIDC_MAX_AGE",
  "ISE_RECORD_OIDC_AUTO_SIGNIN",
  "ISE_RECORD_SHOW_VERSION"
] as const;

let moduleCounter = 0;

/** A copy of the module with a fresh memo, loaded with exactly this environment set. */
async function freshModule() {
  return import(/* @vite-ignore */ `../../src/lib/utils/serverEnv.ts?bust=${++moduleCounter}`);
}

async function envFor(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>): Promise<ServerEnv> {
  for(const key of ENV_KEYS) {
    delete process.env[key];
  }

  Object.assign(process.env, vars);

  const { getServerEnv } = await freshModule();
  return getServerEnv();
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // a malformed URL is reported on the console by design; keep it out of the suite output
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();

  for(const key of ENV_KEYS) {
    delete process.env[key];
  }
});

// --- accepted URLs ---------------------------------------------------------

test("a plain http backend URL is accepted", async () => {
  expect((await envFor({ ISE_RECORD_API_URL: "http://localhost:8000" })).apiUrl)
    .toBe("http://localhost:8000");
});

test("https and a path are accepted", async () => {
  expect((await envFor({ ISE_RECORD_API_URL: "https://recorder.example.com/api" })).apiUrl)
    .toBe("https://recorder.example.com/api");
});

test("a hostname without a TLD is accepted, for intranet deployments", async () => {
  // require_tld is off deliberately: localhost and short intranet names must work
  expect((await envFor({ ISE_RECORD_API_URL: "http://ise-recorder:8000" })).apiUrl)
    .toBe("http://ise-recorder:8000");
});

// --- rejected URLs ---------------------------------------------------------

test("an unset or empty URL yields undefined without complaint", async () => {
  expect((await envFor({})).apiUrl).toBeUndefined();
  expect((await envFor({ ISE_RECORD_API_URL: "" })).apiUrl).toBeUndefined();
  expect(consoleError).not.toHaveBeenCalled();
});

test("a URL without a protocol is rejected", async () => {
  expect((await envFor({ ISE_RECORD_API_URL: "localhost:8000" })).apiUrl).toBeUndefined();
});

test("a non-http protocol is rejected", async () => {
  expect((await envFor({ ISE_RECORD_API_URL: "ftp://example.com" })).apiUrl).toBeUndefined();
});

test("embedded credentials are rejected, so they cannot leak to the client", async () => {
  expect((await envFor({ ISE_RECORD_API_URL: "http://user:secret@example.com" })).apiUrl)
    .toBeUndefined();
});

test("query components and fragments are rejected", async () => {
  expect((await envFor({ ISE_RECORD_API_URL: "http://example.com/api?token=abc" })).apiUrl)
    .toBeUndefined();
  expect((await envFor({ ISE_RECORD_API_URL: "http://example.com/api#frag" })).apiUrl)
    .toBeUndefined();
});

test("a rejected API URL is reported to the admin", async () => {
  await envFor({ ISE_RECORD_API_URL: "not a url" });

  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining("API_URL"),
    "not a url"
  );
});

test("the OpenID provider URL is passed through unvalidated", async () => {
  // Validation here would only catch syntactically broken strings, while the mistakes
  // that actually happen -- wrong host, wrong realm -- are well formed and pass anyway.
  // Worse, rejecting it silently dropped the deployment to anonymous, which is the wrong
  // way for an authentication setting to fail. A bad value now surfaces where the user
  // can see it, as a failed sign-in.
  const env = await envFor({ ISE_RECORD_OIDC_PROVIDER_URL: "not a url" });

  expect(env.oidcProviderUrl).toBe("not a url");
  expect(consoleError).not.toHaveBeenCalled();
});

// --- the other fields ------------------------------------------------------

test("the OIDC settings are passed through", async () => {
  const env = await envFor({
    ISE_RECORD_OIDC_PROVIDER_URL: "http://keycloak.localhost:8080/realms/ise",
    ISE_RECORD_OIDC_CLIENT_ID: "ise-recorder",
    ISE_RECORD_OIDC_MAX_AGE: "25200"
  });

  expect(env.oidcProviderUrl).toBe("http://keycloak.localhost:8080/realms/ise");
  expect(env.oidcClientId).toBe("ise-recorder");
  expect(env.oidcMaxAge).toBe(25200);
});

// --- automatic sign-in ------------------------------------------------------

test("automatic sign-in is off unless it is asked for", async () => {
  // The default decides what an existing deployment does after an upgrade, so it is worth
  // stating outright: nothing set means no redirect on load, and the user signs in from
  // the banner when they want to.
  expect((await envFor({})).oidcAutoSignin).toBe(false);
});


test("automatic sign-in is on when it is asked for", async () => {
  expect((await envFor({ ISE_RECORD_OIDC_AUTO_SIGNIN: "true" })).oidcAutoSignin).toBe(true);
});


test.each([ "TRUE", "True", "1", "yes", "on", "" ])(
  "%s does not turn automatic sign-in on",
  async (value: string) => {
    // Matches ISE_RECORD_SHOW_VERSION: an exact "true" and nothing else. Recorded because
    // the failure is silent -- the admin gets no redirect and no complaint about the typo.
    expect((await envFor({ ISE_RECORD_OIDC_AUTO_SIGNIN: value })).oidcAutoSignin).toBe(false);
  }
);


test("an empty or unset max age stays undefined rather than becoming NaN", async () => {
  expect((await envFor({})).oidcMaxAge).toBeUndefined();
  expect((await envFor({ ISE_RECORD_OIDC_MAX_AGE: "" })).oidcMaxAge).toBeUndefined();
  expect(consoleError).not.toHaveBeenCalled();
});

// --- max age validation ----------------------------------------------------

/**
 * The value is a whole number of seconds. Parsing it leniently is the dangerous option
 * here: parseInt("29d") is 29, so a plausible-looking "29d" would silently become 29
 * seconds and demand a fresh login roughly every half minute. Number() is no better --
 * Number("") is 0, and a max_age of 0 means re-authenticate on every single request.
 */

test("a plain number of seconds is accepted", async () => {
  expect((await envFor({ ISE_RECORD_OIDC_MAX_AGE: "25200" })).oidcMaxAge).toBe(25200);
  expect(consoleError).not.toHaveBeenCalled();
});

test("surrounding whitespace is tolerated", async () => {
  // a stray space in a .env or compose file should not disable staleness checking
  expect((await envFor({ ISE_RECORD_OIDC_MAX_AGE: " 25200 " })).oidcMaxAge).toBe(25200);
  expect(consoleError).not.toHaveBeenCalled();
});

test("a duration suffix is rejected rather than silently truncated", async () => {
  // the motivating case: "29d" must not quietly become 29 seconds
  expect((await envFor({ ISE_RECORD_OIDC_MAX_AGE: "29d" })).oidcMaxAge).toBeUndefined();

  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining("max_age"),
    "29d"
  );
});

test("a fractional value is rejected", async () => {
  expect((await envFor({ ISE_RECORD_OIDC_MAX_AGE: "29.5" })).oidcMaxAge).toBeUndefined();
});

test("notations that are numbers to JavaScript but not to an admin are rejected", async () => {
  // Number() would read these as 1000 and 31; neither is what anyone typed on purpose
  expect((await envFor({ ISE_RECORD_OIDC_MAX_AGE: "1e3" })).oidcMaxAge).toBeUndefined();
  expect((await envFor({ ISE_RECORD_OIDC_MAX_AGE: "0x1F" })).oidcMaxAge).toBeUndefined();
});

test("zero and negative values are rejected", async () => {
  // max_age=0 is legal OIDC and means "re-authenticate on every request", which would
  // make the app unusable. Far more likely a mistake than an intention.
  expect((await envFor({ ISE_RECORD_OIDC_MAX_AGE: "0" })).oidcMaxAge).toBeUndefined();
  expect((await envFor({ ISE_RECORD_OIDC_MAX_AGE: "-300" })).oidcMaxAge).toBeUndefined();
});

test("a non-numeric value is rejected", async () => {
  expect((await envFor({ ISE_RECORD_OIDC_MAX_AGE: "seven hours" })).oidcMaxAge)
    .toBeUndefined();
});

test("a rejected max age disables staleness checking rather than failing the boot", async () => {
  // the fallback is indistinguishable from "no max age configured" once the process is
  // running, so the console message is the only signal the admin gets
  const env = await envFor({
    ISE_RECORD_OIDC_PROVIDER_URL: "http://keycloak.localhost:8080/realms/ise",
    ISE_RECORD_OIDC_MAX_AGE: "29d"
  });

  expect(env.oidcProviderUrl).toBe("http://keycloak.localhost:8080/realms/ise");
  expect(env.oidcMaxAge).toBeUndefined();
});

test("the version is only exposed when explicitly enabled", async () => {
  expect((await envFor({})).version).toBeUndefined();
  expect((await envFor({ ISE_RECORD_SHOW_VERSION: "false" })).version).toBeUndefined();
  expect((await envFor({ ISE_RECORD_SHOW_VERSION: "true" })).version).toBeDefined();
});

// --- caching ---------------------------------------------------------------

test("the environment is read once and then cached", async () => {
  process.env.ISE_RECORD_API_URL = "http://first.example.com";
  const { getServerEnv } = await freshModule();

  const first = await getServerEnv();
  process.env.ISE_RECORD_API_URL = "http://second.example.com";
  const second = await getServerEnv();

  expect(first.apiUrl).toBe("http://first.example.com");
  // a later change to the environment must not be picked up mid-process
  expect(second.apiUrl).toBe("http://first.example.com");
  expect(second).toBe(first);
});

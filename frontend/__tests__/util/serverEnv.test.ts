import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ServerEnv } from "@/lib/utils/serverEnv";

/**
 * Covers the deployment-configuration parsing in serverEnv.
 *
 * validateBackendUrl is not exported and getServerEnv memoises its result in a module
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
  "ISE_RECORD_OIDC_URL",
  "ISE_RECORD_OIDC_CLIENT_ID",
  "ISE_RECORD_OIDC_MAX_AGE",
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

test("a rejected URL names the variable it came from", async () => {
  await envFor({ ISE_RECORD_OIDC_URL: "not a url" });

  // the message used to say API_URL whatever the source, which sent people looking in
  // the wrong place
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining("OIDC_URL"),
    "not a url"
  );
  expect(consoleError).not.toHaveBeenCalledWith(
    expect.stringContaining("API_URL"),
    expect.anything()
  );
});

// --- the other fields ------------------------------------------------------

test("the OIDC settings are passed through", async () => {
  const env = await envFor({
    ISE_RECORD_OIDC_URL: "http://keycloak.localhost:8080/realms/ise",
    ISE_RECORD_OIDC_CLIENT_ID: "ise-recorder",
    ISE_RECORD_OIDC_MAX_AGE: "25200"
  });

  expect(env.oidcProviderUrl).toBe("http://keycloak.localhost:8080/realms/ise");
  expect(env.oidcClientId).toBe("ise-recorder");
  expect(env.oidcMaxAge).toBe(25200);
});

test("an unset max age stays undefined rather than becoming NaN", async () => {
  expect((await envFor({})).oidcMaxAge).toBeUndefined();
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

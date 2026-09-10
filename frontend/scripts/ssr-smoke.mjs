#!/usr/bin/env node

/**
 * Server-side rendering smoke test.
 *
 * `next build` cannot catch SSR failures here: getServerEnv() calls connection(), which
 * opts every page out of static prerendering, so the build never renders them. Only a
 * real request does. This has already mattered twice -- useAutoSignin reading
 * window.location during render, and useAuth() returning undefined outside an
 * AuthProvider -- both of which left the page rendering as an empty shell while the
 * browser-mode test suite stayed green.
 *
 * No OpenID provider is required. Rendering only reads environment variables; the
 * UserManager fetches provider metadata lazily and AuthProvider does its work in
 * effects, so nothing here talks to Keycloak.
 *
 * Scope: this checks server-side rendering only. A component that renders fine on the
 * server but throws after hydration is not covered -- Next's route-segment error
 * boundaries absorb it, and the HTML looks correct. Guarding that needs an end-to-end
 * test that renders the app without mocking react-oidc-context.
 *
 * Usage: node scripts/ssr-smoke.mjs [--dev]
 *   default   run against `next start` (requires a prior `next build`)
 *   --dev     run against `next dev` instead, for a quick local check
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.SMOKE_PORT ?? 3100);
const BASE = `http://127.0.0.1:${PORT}`;
const USE_DEV = process.argv.includes("--dev");

// Both branches of AccessTokenSourceProvider need covering: the anonymous one renders
// no AuthProvider at all, which is its own class of SSR failure.
const DEPLOYMENTS = [
  {
    name: "unauthenticated",
    env: { ISE_RECORD_API_URL: "http://localhost:8000" }
  },
  {
    name: "openid-connect",
    env: {
      ISE_RECORD_API_URL: "http://localhost:8000",
      ISE_RECORD_OIDC_URL: "http://keycloak.invalid/realms/ise",
      ISE_RECORD_OIDC_CLIENT_ID: "ise-recorder",
      ISE_RECORD_OIDC_MAX_AGE: "25200"
    }
  }
];

const CHECKS = [
  {
    path: "/",
    // Proves the component tree actually rendered on the server rather than the page
    // falling back to an empty client-only shell.
    mustContain: [ "Start Recording" ]
  },
  {
    path: "/auth/callback",
    mustContain: []
  }
];

const ERROR_MARKERS = [ "window is not defined", "ReferenceError", "TypeError", "Internal Server Error" ];


function startServer(env) {
  const args = USE_DEV
    ? [ "next", "dev", "--port", String(PORT) ]
    : [ "next", "start", "--port", String(PORT) ];

  const server = spawn("npx", args, {
    env: { ...process.env, ...env },
    stdio: [ "ignore", "pipe", "pipe" ]
  });

  const output = [];
  server.stdout.on("data", d => output.push(String(d)));
  server.stderr.on("data", d => output.push(String(d)));

  return { server, output };
}

async function waitForReady() {
  for(let attempt = 0; attempt < 120; ++attempt) {
    try {
      const response = await fetch(BASE, { signal: AbortSignal.timeout(2000) });
      if(response.status < 500) {
        return true;
      }
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  return false;
}

async function checkDeployment({ name, env }) {
  const failures = [];
  const { server, output } = startServer(env);

  try {
    if(!await waitForReady()) {
      failures.push(`${name}: server never became ready\n${output.join("").slice(-600)}`);
      return failures;
    }

    for(const { path, mustContain } of CHECKS) {
      const response = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(15000) });
      const html = await response.text();

      if(response.status !== 200) {
        failures.push(`${name} ${path}: expected 200, got ${response.status}`);
      }

      for(const needle of mustContain) {
        if(!html.includes(needle)) {
          failures.push(`${name} ${path}: server-rendered HTML is missing ${JSON.stringify(needle)} ` +
            "-- the page most likely threw during SSR and fell back to a client-only shell");
        }
      }

      for(const marker of ERROR_MARKERS) {
        if(html.includes(marker)) {
          failures.push(`${name} ${path}: server-rendered HTML contains ${JSON.stringify(marker)}`);
        }
      }

      console.log(`  ${failures.length ? "✗" : "✓"} ${name} ${path} (${response.status}, ${html.length} bytes)`);
    }

    // A page can render fine and still have logged an SSR error that React recovered from.
    const logged = output.join("");
    for(const marker of ERROR_MARKERS) {
      if(logged.includes(marker)) {
        failures.push(`${name}: server log contains ${JSON.stringify(marker)}\n${logged.slice(-600)}`);
        break;
      }
    }
  } finally {
    server.kill("SIGTERM");
    await sleep(500);
    server.kill("SIGKILL");
  }

  return failures;
}

console.log(`SSR smoke test (${USE_DEV ? "next dev" : "next start"}, port ${PORT})`);

const failures = [];
for(const deployment of DEPLOYMENTS) {
  failures.push(...await checkDeployment(deployment));
}

if(failures.length > 0) {
  console.error("\nSSR smoke test FAILED:");
  for(const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log("\nSSR smoke test passed.");

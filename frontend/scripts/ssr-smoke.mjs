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
 * It also checks the CSP that proxy.ts sets. proxy.ts cannot be unit tested in the
 * browser-mode suite -- importing NextRequest pulls in Next's server runtime, which
 * needs __dirname -- but it runs on every request, so its output is right here in the
 * response headers, unmocked and in the real runtime.
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

const BASE_PORT = Number(process.env.SMOKE_PORT ?? 3100);
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

/** Split a CSP header into directive -> sources, so nothing depends on ordering. */
function parseCsp(header) {
  return new Map(
    header.split(";")
      .map(directive => directive.trim())
      .filter(directive => directive.length > 0)
      .map(directive => {
        const [ name, ...sources ] = directive.split(/\s+/);
        return [ name, sources ];
      })
  );
}

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

const CONTROL_TAG = /<(button|input|select|textarea|fieldset|optgroup|option)\b[^>]*>/gi;
// A preceding space is what keeps this off data-disabled and aria-disabled, which react-spectrum
// emits freely and which are not the problem.
const DISABLED_ATTR = /\sdisabled(?=[\s=>/])/i;

/**
 * Find form controls that the server rendered in a disabled state.
 *
 * Firefox restores form-control state across soft reloads, before any script runs, and that
 * restore is one-directional: it will remove a `disabled` the markup carries, never add one.
 * So a control shipped as disabled in the SSR'd HTML can arrive at hydration already enabled,
 * React reports an attribute mismatch, and -- because React does not patch those up -- the
 * control stays wrongly interactive until something else re-renders it. Measured against a
 * standalone page: markup-disabled buttons came back enabled, markup-enabled ones were left
 * alone, and `autocomplete="off"` opted out of the restore entirely. See the comment on
 * RecordButton, which is the control this was found on.
 *
 * Rendering a control as enabled is always safe, so the rule is simply to never assert
 * "disabled" from the server. Where the reason is client-only state the server cannot know
 * anyway -- tracks, OPFS, quota -- gating on useHydrated() is the fix, and it is the more
 * honest rendering regardless of Firefox.
 *
 * If a genuinely always-disabled control ever needs to ship that way, this is the place to
 * record the exception rather than delete the check.
 */
function findServerDisabledControls(html) {
  return [ ...html.matchAll(CONTROL_TAG) ]
    .map(match => match[0])
    .filter(tag => DISABLED_ATTR.test(tag));
}

function startServer(env, port) {
  const args = USE_DEV
    ? [ "next", "dev", "--port", String(port) ]
    : [ "next", "start", "--port", String(port) ];

  // detached so the whole process group can be killed: signalling npx alone leaves the
  // actual Next server holding the port, and the next deployment then either fails to
  // bind or -- worse -- gets checked against the previous deployment's environment.
  const server = spawn("npx", args, {
    env: { ...process.env, ...env },
    stdio: [ "ignore", "pipe", "pipe" ],
    detached: true
  });

  const output = [];
  server.stdout.on("data", d => output.push(String(d)));
  server.stderr.on("data", d => output.push(String(d)));

  return { server, output };
}

async function waitForReady(base) {
  for(let attempt = 0; attempt < 120; ++attempt) {
    try {
      const response = await fetch(base, { signal: AbortSignal.timeout(2000) });
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

async function checkDeployment({ name, env }, port) {
  const base = `http://127.0.0.1:${port}`;
  const failures = [];
  const { server, output } = startServer(env, port);

  try {
    if(!await waitForReady(base)) {
      failures.push(`${name}: server never became ready\n${output.join("").slice(-600)}`);
      return failures;
    }

    for(const { path, mustContain } of CHECKS) {
      let response;
      let html;

      try {
        response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15000) });
        html = await response.text();
      } catch(e) {
        failures.push(`${name} ${path}: request failed: ${String(e).slice(0, 120)}`);
        continue;
      }

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

      for(const tag of findServerDisabledControls(html)) {
        failures.push(`${name} ${path}: control is server-rendered as disabled, which Firefox ` +
          "un-disables on a soft reload and React then refuses to patch up: " +
          `${tag.length > 200 ? `${tag.slice(0, 200)}...` : tag}`);
      }

      console.log(`  ${failures.length ? "✗" : "✓"} ${name} ${path} (${response.status}, ${html.length} bytes)`);
    }

    failures.push(...await checkContentSecurityPolicy(name, env, base));

    // A page can render fine and still have logged an SSR error that React recovered from.
    const logged = output.join("");
    for(const marker of ERROR_MARKERS) {
      if(logged.includes(marker)) {
        failures.push(`${name}: server log contains ${JSON.stringify(marker)}\n${logged.slice(-600)}`);
        break;
      }
    }
  } finally {
    try {
      process.kill(-server.pid, "SIGTERM");
      await sleep(500);
      process.kill(-server.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }

  return failures;
}

/** The CSP proxy.ts attaches to every response. */
async function checkContentSecurityPolicy(name, env, base) {
  const failures = [];
  const note = message => failures.push(`${name} csp: ${message}`);

  let first;

  try {
    first = await fetch(base, { signal: AbortSignal.timeout(15000) });
  } catch(e) {
    note(`request failed: ${String(e).slice(0, 120)}`);
    return failures;
  }

  const header = first.headers.get("content-security-policy");

  if(header === null) {
    note("no Content-Security-Policy header on the response");
    return failures;
  }

  const csp = parseCsp(header);
  const connectSrc = csp.get("connect-src") ?? [];
  const scriptSrc = csp.get("script-src") ?? [];

  // the app must be allowed to reach its own backend, or every upload is blocked
  if(env.ISE_RECORD_API_URL !== undefined &&
    !connectSrc.some(source => source.startsWith(env.ISE_RECORD_API_URL))) {
    note(`connect-src does not admit the configured API URL: ${connectSrc.join(" ")}`);
  }

  // only the provider's origin belongs here, not the realm path
  if(env.ISE_RECORD_OIDC_URL === undefined) {
    if(connectSrc.some(source => source.includes("keycloak"))) {
      note(`connect-src admits an OpenID provider that is not configured: ${connectSrc.join(" ")}`);
    }
  } else {
    const { origin, href } = new URL(env.ISE_RECORD_OIDC_URL);

    if(!connectSrc.includes(origin)) {
      note(`connect-src does not admit the OpenID provider origin ${origin}: ${connectSrc.join(" ")}`);
    }

    if(connectSrc.includes(href) || connectSrc.some(source => source.includes("/realms/"))) {
      note(`connect-src carries the provider path rather than just its origin: ${connectSrc.join(" ")}`);
    }
  }

  // silent renew redirects back into an iframe on our own origin
  const frameAncestors = (csp.get("frame-ancestors") ?? []).join(" ");
  if(frameAncestors !== "'self'") {
    note(`frame-ancestors should be 'self', got: ${frameAncestors || "(absent)"}`);
  }

  const nonces = scriptSrc.filter(source => source.startsWith("'nonce-"));
  if(nonces.length !== 1) {
    note(`script-src should carry exactly one nonce, got: ${scriptSrc.join(" ")}`);
  }

  // a reused nonce is no better than no nonce
  const second = await fetch(base, { signal: AbortSignal.timeout(15000) });
  const secondNonces = (parseCsp(second.headers.get("content-security-policy") ?? "")
    .get("script-src") ?? []).filter(source => source.startsWith("'nonce-"));

  if(nonces[0] !== undefined && nonces[0] === secondNonces[0]) {
    note(`the same nonce was reused across two requests: ${nonces[0]}`);
  }

  console.log(`  ${failures.length ? "✗" : "✓"} ${name} csp (${csp.size} directives)`);
  return failures;
}

console.log(`SSR smoke test (${USE_DEV ? "next dev" : "next start"}, from port ${BASE_PORT})`);

const failures = [];
// a port per deployment, so a lingering server can never be mistaken for the next one
for(const [ index, deployment ] of DEPLOYMENTS.entries()) {
  failures.push(...await checkDeployment(deployment, BASE_PORT + index));
}

if(failures.length > 0) {
  console.error("\nSSR smoke test FAILED:");
  for(const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log("\nSSR smoke test passed.");

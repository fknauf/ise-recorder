/**
 * Stands in for the `server-only` package in the test suite.
 *
 * `server-only` is a marker: its default entry point throws on import, and bundlers
 * resolve it to an empty module under the `react-server` condition. That makes importing
 * a server module from a client component a build error, which is exactly what it is for
 * -- but the browser-mode suite is neither, so the real package just throws and takes
 * every test in the file down with it.
 *
 * Neutralising it here does not weaken anything: the guarantee is enforced by
 * `next build`, and `npm run smoke` builds for real, so a client component that started
 * importing serverEnv would fail there.
 */

export {};

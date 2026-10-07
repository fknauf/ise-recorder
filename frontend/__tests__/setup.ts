import { afterEach, vi } from "vitest";
// Imported for their side effects. With globals on, @testing-library/react registers its
// cleanup after every test, so no test file needs to unmount by hand; jest-dom adds its
// matchers to expect.
import "@testing-library/dom";
import "@testing-library/react";
import "@testing-library/jest-dom";

// next/navigation reads process.env at import time. Browser-mode tests have no node
// globals, so importing anything that reaches useRouter fails with "process is not
// defined" before a single test runs.
globalThis.process ??= { env: {} } as NodeJS.Process;

// Tests stand in for the backend by assigning window.fetch, pin the clock with fake timers
// or vi.setSystemTime, and watch globals with vi.spyOn. Each of these outlives the test that
// did it unless it is undone, so it is undone here, after every test in every file.
const realFetch = window.fetch;

afterEach(() => {
  window.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

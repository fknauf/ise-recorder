import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useHydrated } from "@/lib/hooks/useHydrated";

/**
 * useHydrated is four lines of useSyncExternalStore and the mechanism is not obvious, so
 * this pins what it actually promises rather than how it is written.
 *
 * The trick is the third argument. useSyncExternalStore uses getServerSnapshot both when
 * rendering on the server *and* for the hydration pass in the browser, and only switches
 * to getSnapshot once hydration has committed. That is what makes the value go false ->
 * true at exactly the right moment: the browser's first pass produces the same markup the
 * server sent, so there is no mismatch, and everything gated on it appears immediately
 * afterwards. Returning true from getServerSnapshot would render client-only content
 * during hydration and trip React's mismatch check.
 *
 * The subscribe function is deliberately a no-op returning a no-op: the value never
 * changes again after hydration, so there is nothing to notify.
 */

/** Records the value seen on every render, so the transition can be inspected. */
const seen: boolean[] = [];

function Probe() {
  const hydrated = useHydrated();
  seen.push(hydrated);
  return <span data-testid="hydrated">{String(hydrated)}</span>;
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  seen.length = 0;
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  cleanup();
});

test("server rendering reports not hydrated", () => {
  // on the server there is no hydration yet by definition, and anything gated on this
  // must stay out of the HTML
  expect(renderToString(<Probe/>)).toContain("false");
});

test("a client-only render reports hydrated straight away", () => {
  render(<Probe/>);

  expect(screen.getByTestId("hydrated")).toHaveTextContent("true");
});

test("hydration starts from the server value and then flips", async () => {
  const container = document.createElement("div");
  container.innerHTML = renderToString(<Probe/>);
  document.body.appendChild(container);

  seen.length = 0;

  await act(async () => {
    hydrateRoot(container, <Probe/>);
  });

  try {
    // the hydration pass has to agree with the server, or React throws the tree away
    expect(seen[0]).toBe(false);
    // and by the time hydration has committed, the gate is open
    expect(seen.at(-1)).toBe(true);
    expect(container.textContent).toBe("true");

    // React complains loudly about a bad useSyncExternalStore -- a missing
    // getServerSnapshot throws during hydration -- so silence here is part of the contract
    expect(consoleError).not.toHaveBeenCalled();
  } finally {
    container.remove();
  }
});

test("the value stays true once hydrated", async () => {
  const container = document.createElement("div");
  container.innerHTML = renderToString(<Probe/>);
  document.body.appendChild(container);

  let root: ReturnType<typeof hydrateRoot>;

  await act(async () => {
    root = hydrateRoot(container, <Probe/>);
  });

  seen.length = 0;

  // a later re-render must not fall back to the server snapshot, or anything gated on
  // this would flicker away again
  await act(async () => {
    root.render(<Probe/>);
  });

  try {
    expect(seen).not.toContain(false);
    expect(container.textContent).toBe("true");
  } finally {
    container.remove();
  }
});

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, Root } from "react-dom/client";
import { AppStoreProvider, useAppStore } from "@/lib/hooks/useAppStore";
import { ActiveRecording, AppStoreState } from "@/lib/store/store";
import { ReactNode, useEffect } from "react";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { StreamingImpededWarning } from "@/lib/components/StreamingImpededWarning";
import { gatherRecordingsList } from "@/lib/utils/browserStorage";

// The store only keeps unstreamed recordings that are still saved in the browser, so the
// browser's list of recordings is part of every test's setup.
vi.mock("@/lib/utils/browserStorage");

let store: AppStoreState;

/**
 * Hands the store out so a test can put the app into the state it needs. Published from an
 * effect rather than during render: assigning to a variable outside the component is a side
 * effect, and doing it in the render body is a lint error.
 */
function StoreHandle() {
  const state = useAppStore(s => s);

  useEffect(() => {
    store = state;
  }, [ state ]);

  return null;
}

const recording = (name: string): ActiveRecording =>
  ({ state: "recording", name, stop: () => {} });

const providers = (children: ReactNode) =>
  <Provider theme={defaultTheme}>
    <AppStoreProvider serverEnv={{ apiUrl: "http://localhost:8000" }}>
      <StoreHandle/>
      {children}
    </AppStoreProvider>
  </Provider>;

/** Render the warning with these recordings saved in the browser, once storage has been looked at. */
async function renderWarning(saved: string[]) {
  vi.mocked(gatherRecordingsList).mockResolvedValue(saved.map(name => ({ name, files: [] })));

  render(providers(<StreamingImpededWarning/>));

  await act(() => store.updateBrowserStorage());
}

beforeEach(() => {
  // the list of unstreamed recordings is persisted
  localStorage.clear();
  navigator.storage.estimate = vi.fn().mockResolvedValue({ quota: 10 * 2 ** 30, usage: 0 });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("nothing is shown while every recording made it to the backend", async () => {
  await renderWarning([ "GVS_1" ]);

  expect(screen.queryByRole("alert")).toBeNull();
});

test("recordings that were not streamed are listed by name", async () => {
  await renderWarning([ "GVS_1", "GVS_2", "PSU_3" ]);

  act(() => {
    store.markUnstreamed("PSU_3");
    store.markUnstreamed("GVS_1");
  });

  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("GVS_1");
  expect(alert).toHaveTextContent("PSU_3");
  expect(alert).not.toHaveTextContent("GVS_2");
});

test("a lecture that is not being streamed gets the warning to itself", async () => {
  // the lecturer is mid-lecture; older recordings to re-upload are not what needs their
  // attention right now
  await renderWarning([ "OLD_1", "LIVE" ]);

  act(() => {
    store.markUnstreamed("OLD_1");
    store.setActiveRecording(recording("LIVE"));
    store.markUnstreamed("LIVE");
  });

  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(screen.queryByText("OLD_1")).toBeNull();
});

test("older recordings are still listed while a lecture streams fine", async () => {
  await renderWarning([ "OLD_1", "LIVE" ]);

  act(() => {
    store.markUnstreamed("OLD_1");
    store.setActiveRecording(recording("LIVE"));
  });

  expect(screen.getByRole("alert")).toHaveTextContent("OLD_1");
});

test("a re-uploaded recording drops off the list", async () => {
  await renderWarning([ "GVS_1", "GVS_2" ]);

  act(() => {
    store.markUnstreamed("GVS_1");
    store.markUnstreamed("GVS_2");
  });
  act(() => store.signalManualUploadFinished("GVS_1", true));

  expect(screen.getByRole("alert")).not.toHaveTextContent("GVS_1");
  expect(screen.getByRole("alert")).toHaveTextContent("GVS_2");
});

test("the list survives a reload", async () => {
  // A lecture whose stream broke off is typically followed by closing the laptop; the
  // re-upload happens later, from wherever there is a network.
  await renderWarning([ "GVS_1" ]);
  act(() => store.markUnstreamed("GVS_1"));
  cleanup();

  await renderWarning([ "GVS_1" ]);

  expect(screen.getByRole("alert")).toHaveTextContent("GVS_1");
});

test("a persisted recording that has since been deleted from the browser is not listed", async () => {
  await renderWarning([ "GVS_1", "GVS_2" ]);
  act(() => {
    store.markUnstreamed("GVS_1");
    store.markUnstreamed("GVS_2");
  });
  cleanup();

  // deleted in the meantime, from this page or another tab
  await renderWarning([ "GVS_2" ]);

  expect(screen.getByRole("alert")).not.toHaveTextContent("GVS_1");
  expect(screen.getByRole("alert")).toHaveTextContent("GVS_2");
});

test("a persisted list shows up without upsetting hydration", async () => {
  // The server has no localStorage, so its HTML never carries the list, while the browser's
  // store has it from the moment it is created. The first render in the browser still has
  // to match the server's HTML -- or React throws it away and renders the page from
  // scratch -- and the list has to appear right after.
  vi.mocked(gatherRecordingsList).mockResolvedValue([ { name: "GVS_1", files: [] } ]);

  // rendered the way the server does: with nothing persisted
  const container = document.createElement("div");
  document.body.appendChild(container);
  container.innerHTML = renderToString(providers(<StreamingImpededWarning/>));

  localStorage.setItem("app-store", JSON.stringify({ state: { unstreamedRecordings: [ "GVS_1" ] }, version: 0 }));

  const mismatches: unknown[] = [];
  let root: Root | undefined;
  await act(async () => {
    root = hydrateRoot(container, providers(<StreamingImpededWarning/>), {
      onRecoverableError: error => mismatches.push(error)
    });
  });

  try {
    expect(mismatches).toStrictEqual([]);
    await waitFor(() => expect(container).toHaveTextContent("GVS_1"));
  } finally {
    act(() => root?.unmount());
    container.remove();
  }
});

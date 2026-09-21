import { afterEach, expect, test } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { AppStoreProvider, useAppStore } from "@/lib/hooks/useAppStore";
import { ActiveRecording } from "@/lib/store/store";
import { useEffect } from "react";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { StreamingImpededWarning } from "@/lib/components/StreamingImpededWarning";
import { ServerEnv } from "@/lib/utils/serverEnv";

let setActiveRecording: (recording: ActiveRecording) => void;

/**
 * Hands the store's setters out so a test can put the app into the state it needs.
 * Published from an effect rather than during render: assigning to a variable outside the
 * component is a side effect, and doing it in the render body is a lint error.
 */
function StoreHandles() {
  const active = useAppStore(state => state.setActiveRecording);

  useEffect(() => {
    setActiveRecording = active;
  }, [ active ]);

  return null;
}

const recording = (streamingImpeded: boolean): ActiveRecording =>
  ({ state: "recording", name: "GVS", stop: () => {}, streamingImpeded });


afterEach(cleanup);

function renderMessage({
  apiUrl = undefined as string | undefined
} = {}) {
  const serverEnv: ServerEnv = { apiUrl };

  render(
    <Provider theme={defaultTheme}>
      <AppStoreProvider serverEnv={serverEnv}>
        <StoreHandles/>
        <StreamingImpededWarning/>
      </AppStoreProvider>
    </Provider>
  );
}


// --- the streaming warning -------------------------------------------------

test("an impeded recording warns that manual postprocessing is needed", () => {
  renderMessage({ apiUrl: "http://localhost:8000" });
  act(() => setActiveRecording(recording(true)));

  expect(screen.getByText(/not being streamed/i)).toBeInTheDocument();
});

test("a recording that is streaming fine warns about nothing", () => {
  renderMessage({ apiUrl: "http://localhost:8000" });
  act(() => setActiveRecording(recording(false)));

  expect(screen.queryByText(/not being streamed/i)).toBeNull();
});

test("the streaming warning is not shown while idle", () => {
  renderMessage({ apiUrl: "http://localhost:8000" });
  expect(screen.queryByText(/not being streamed/i)).toBeNull();
});

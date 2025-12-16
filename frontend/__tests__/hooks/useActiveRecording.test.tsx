import { expect, test } from "vitest";
import { renderHook } from "@testing-library/react";
import { AppStoreProvider, useAppStore } from "@/app/lib/hooks/useAppStore";
import { useActiveRecording } from "@/app/lib/hooks/useActiveRecording";
import { ReactNode, useEffect } from "react";

const wrapper = ({ children }: Readonly<{ children: ReactNode }>) =>
  <AppStoreProvider serverEnv={{ apiUrl: "http://localhost:5000" }}>
    {children}
  </AppStoreProvider>;

test("useActiveRecording starts idle", async () => {
  const { result } = renderHook(() => useActiveRecording(), { wrapper });

  expect(result.current.state).toBe("idle");
});

test("useActiveRecording responds to store actions", async () => {
  const renderResult = renderHook(() => {
    const activeRecording = useActiveRecording();
    const setActiveRecording = useAppStore(state => state.setActiveRecording);

    useEffect(() => {
      setActiveRecording({ state: "starting", name: "FOO" });
    }, [ setActiveRecording ]);

    return activeRecording;
  }, { wrapper });

  expect(renderResult.result.current.state).toBe("starting");
  expect(renderResult.result.current.name).toBe("FOO");
});

import { ReactNode } from "react";
import { AppStoreProvider } from "@/lib/hooks/useAppStore";
import { ServerEnv } from "@/lib/utils/serverEnv";

/** A wrapper for renderHook that gives the hook a fresh app store, behind the given deployment. */
export const appStoreWrapper = (serverEnv: ServerEnv = { apiUrl: "http://localhost:5000" }) =>
  function AppStoreWrapper({ children }: Readonly<{ children: ReactNode }>) {
    return (
      <AppStoreProvider serverEnv={serverEnv}>
        {children}
      </AppStoreProvider>
    );
  };

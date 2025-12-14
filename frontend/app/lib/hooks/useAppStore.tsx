"use client";

import { StoreApi, useStore } from "zustand";
import { createContext, ReactNode, useContext, useState } from "react";
import { AppStoreState, createAppStore } from "../store/store";
import { ServerEnv } from "../utils/serverEnv";

// See https://zustand.docs.pmnd.rs/guides/nextjs for why this is the way it is.
// Long story short: This prevents the Zustand store from being created on the server side during SSR.

export const AppStoreContext = createContext<StoreApi<AppStoreState> | undefined>(undefined);

interface AppStoreProviderProps {
  serverEnv: ServerEnv
  children: ReactNode
}

export function AppStoreProvider({ serverEnv, children }: Readonly<AppStoreProviderProps>) {
  const [ store ] = useState(() => createAppStore(serverEnv));

  return (
    <AppStoreContext.Provider value={store}>
      {children}
    </AppStoreContext.Provider>
  );
}

export function useAppStore<T>(
  selector: (store: AppStoreState) => T
) {
  const appStoreContext = useContext(AppStoreContext);

  if(appStoreContext === undefined) {
    throw new Error("useAppStore must be used within AppStoreProvider");
  }

  return useStore(appStoreContext, selector);
}

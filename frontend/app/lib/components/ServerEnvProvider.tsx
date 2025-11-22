'use client';

import { createContext, ReactNode, useContext } from "react";
import { ServerEnv } from "../utils/serverEnv";

const ServerEnvContext = createContext<ServerEnv>({});

export interface ServerEnvProviderProps {
    env: ServerEnv,
    children: ReactNode
};

export function ServerEnvProvider(
    { env, children }: ServerEnvProviderProps
) {
    return (
        <ServerEnvContext.Provider value={env}>
            {children}
        </ServerEnvContext.Provider>
    );
}

export const useServerEnv = () => useContext(ServerEnvContext);

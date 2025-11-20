'use client';

import { createContext, ReactNode, useContext } from 'react';
import { ServerEnv } from "./ServerEnv";

const ServerEnvContext = createContext<ServerEnv>({});

export const useServerEnv = () => useContext(ServerEnvContext);

export default function ServerEnvProvider(
    { env, children }: { env: ServerEnv, children: ReactNode }
) {
    return (
        <ServerEnvContext.Provider value={env}>
            {children}
        </ServerEnvContext.Provider>
    );
}

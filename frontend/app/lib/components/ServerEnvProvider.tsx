'use client';

import { createContext, ReactNode, useContext } from "react";
import { ServerEnv } from "../utils/serverEnv";

const ServerEnvContext = createContext<ServerEnv>({});

export interface ServerEnvProviderProps {
    env: ServerEnv,
    children: ReactNode
};

/**
 * Client-side component to make the server-side environment available on the client side.
 * 
 * This requires the main page to be dynamically rendered, which we have to do anyway to
 * attach the nonce for the Content-Security-Policy header.
 */
export function ServerEnvProvider(
    { env, children }: Readonly<ServerEnvProviderProps>
) {
    return (
        <ServerEnvContext.Provider value={env}>
            {children}
        </ServerEnvContext.Provider>
    );
}

/**
 * custom hook to use the server environment in client components
 */
export const useServerEnv = () => useContext(ServerEnvContext);

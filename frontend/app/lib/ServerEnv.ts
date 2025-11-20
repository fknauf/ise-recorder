'use server';

import { connection } from "next/server";

export interface ServerEnv {
    apiUrl?: string
}

export async function getServerEnv(): Promise<ServerEnv> {
    // force dynamic rendering. Without this, the build-time environment
    // would be exported rather than the runtime environment.
    await connection();

    return {
        apiUrl: process.env.ISE_RECORD_API_URL
    }
}

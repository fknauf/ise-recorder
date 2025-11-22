'use server';

import { connection } from "next/server";

export interface ServerEnv {
    apiUrl?: string
}

export async function getServerEnv(): Promise<ServerEnv> {
    await connection();

    return {
        apiUrl: process.env.ISE_RECORD_API_URL
    };
}

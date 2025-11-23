'use server';

import { connection } from "next/server";
import isURL, { IsURLOptions } from "validator/es/lib/isURL";

function validateApiUrl(apiUrl: string | undefined): string | undefined {
  if(apiUrl === undefined) {
    return undefined;
  }

  const urlOptions: IsURLOptions = {
    protocols: [ 'http', 'https' ],
    require_protocol: true,
    require_tld: false, // allow localhost and enable intranet deployments
    allow_fragments: false,
    allow_query_components: false,
    disallow_auth: true // prevent credentials leakage
  };

  if(isURL(apiUrl, urlOptions)) {
    return apiUrl;
  } else {
    console.log(`Malformed API_URL: ${apiUrl}`);
    return undefined;
  }
}

export interface ServerEnv {
  apiUrl?: string
}

let runtimeEnvironment: ServerEnv | undefined;

export async function getServerEnv(): Promise<ServerEnv> {
  await connection();

  if(runtimeEnvironment === undefined) {
    runtimeEnvironment = {
      apiUrl: validateApiUrl(process.env.ISE_RECORD_API_URL)
    };
  }

  return runtimeEnvironment;
}

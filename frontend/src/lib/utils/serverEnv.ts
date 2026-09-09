"use server";

import { connection } from "next/server";
import isURL, { IsURLOptions } from "validator/es/lib/isURL";
import pkg from "../../../package.json" with { type: "json" };

function validateBackendUrl(url: string | undefined, name: string): string | undefined {
  if(url === undefined || url === "") {
    return undefined;
  }

  const urlOptions: IsURLOptions = {
    protocols: [ "http", "https" ],
    require_protocol: true,
    require_tld: false, // allow localhost and enable intranet deployments
    allow_fragments: false,
    allow_query_components: false,
    disallow_auth: true // prevent credentials leakage
  };

  if(isURL(url, urlOptions)) {
    return url;
  } else {
    console.error(`Malformed ${name}:`, url);
    return undefined;
  }
}

export interface ServerEnv {
  version?: string
  apiUrl?: string
  oidcProviderUrl?: string
  oidcClientId?: string
  oidcMaxAge?: number
}

let runtimeEnvironment: ServerEnv | undefined;

export async function getServerEnv(): Promise<ServerEnv> {
  // ensure dynamic rendering whenever the server environment is requested,
  // so that the runtime environment is used rather than the build environment.
  await connection();

  if(runtimeEnvironment === undefined) {
    runtimeEnvironment = {
      version: process.env.ISE_RECORD_SHOW_VERSION === "true" ? pkg.version : undefined,
      apiUrl: validateBackendUrl(process.env.ISE_RECORD_API_URL, "API_URL"),
      oidcProviderUrl: validateBackendUrl(process.env.ISE_RECORD_OIDC_URL, "OIDC_URL"),
      oidcClientId: process.env.ISE_RECORD_OIDC_CLIENT_ID,
      oidcMaxAge: process.env.ISE_RECORD_OIDC_MAX_AGE !== undefined ? parseInt(process.env.ISE_RECORD_OIDC_MAX_AGE) : undefined
    };
  }

  return runtimeEnvironment;
}

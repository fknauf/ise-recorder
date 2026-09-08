"use server";

import { connection } from "next/server";
import isURL, { IsURLOptions } from "validator/es/lib/isURL";
import pkg from "../../../package.json" with { type: "json" };

function validateApiUrl(apiUrl: string | undefined): string | undefined {
  if(apiUrl === undefined || apiUrl === "") {
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

  if(isURL(apiUrl, urlOptions)) {
    return apiUrl;
  } else {
    console.error("Malformed API_URL:", apiUrl);
    return undefined;
  }
}

export interface ServerEnv {
  version?: string
  apiUrl?: string
  oidc_provider_url?: string
  oidc_client_id?: string
}

let runtimeEnvironment: ServerEnv | undefined;

export async function getServerEnv(): Promise<ServerEnv> {
  // ensure dynamic rendering whenever the server environment is requested,
  // so that the runtime environment is used rather than the build environment.
  await connection();

  if(runtimeEnvironment === undefined) {
    runtimeEnvironment = {
      version: process.env.ISE_RECORD_SHOW_VERSION === "true" ? pkg.version : undefined,
      apiUrl: validateApiUrl(process.env.ISE_RECORD_API_URL),
      oidc_provider_url: validateApiUrl(process.env.ISE_RECORD_OIDC_URL),
      oidc_client_id: process.env.ISE_RECORD_OIDC_CLIENT_ID
    };
  }

  return runtimeEnvironment;
}

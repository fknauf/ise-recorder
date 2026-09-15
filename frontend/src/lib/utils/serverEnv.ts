import "server-only";

import { connection } from "next/server";
import isURL, { IsURLOptions } from "validator/es/lib/isURL";
import isInt from "validator/es/lib/isInt";
import pkg from "../../../package.json" with { type: "json" };

function validateApiUrl(url: string | undefined): string | undefined {
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
    console.error("Malformed API_URL:", url);
    return undefined;
  }
}

function validateMaxAge(envMaxAge: string | undefined): number | undefined {
  if(envMaxAge === undefined || envMaxAge === "") {
    return undefined;
  }

  if(isInt(envMaxAge.trim(), { min: 1 })) {
    return parseInt(envMaxAge);
  }

  console.error("Malformed OIDC max_age, proceeding without it:", envMaxAge);
  return undefined;
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
      apiUrl: validateApiUrl(process.env.ISE_RECORD_API_URL),
      oidcProviderUrl: process.env.ISE_RECORD_OIDC_PROVIDER_URL,
      oidcClientId: process.env.ISE_RECORD_OIDC_CLIENT_ID,
      oidcMaxAge: validateMaxAge(process.env.ISE_RECORD_OIDC_MAX_AGE)
    };
  }

  return runtimeEnvironment;
}

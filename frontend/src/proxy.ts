import { NextRequest, NextResponse } from "next/server";

// Adapted from https://nextjs.org/docs/app/guides/content-security-policy

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  const isDev = process.env.NODE_ENV === "development";
  const apiUrl = process.env.ISE_RECORD_API_URL;
  const apiSrc = apiUrl ? apiUrl + (apiUrl.endsWith("/") ? "" : "/") : "";
  const oidcSrc = process.env.ISE_RECORD_OIDC_URL !== undefined
    ? new URL(process.env.ISE_RECORD_OIDC_URL).origin
    : "";


  // would like to use ${isDev ? "'unsafe-eval'" : `nonce-${nonce}`}; instead of unsafe-inline for
  // style-src, but react spectrum requires inline styles and doesn't apply nonces at the moment.
  // Perhaps after https://github.com/adobe/react-spectrum/issues/8273 is resolved.
  const cspHeader = `
    default-src 'self';
    script-src 'nonce-${nonce}' 'strict-dynamic' 'self' ${isDev ? "'unsafe-eval'" : ""};
    style-src 'self' 'unsafe-inline';
    img-src 'self' blob: data:;
    font-src 'self';
    object-src 'none';
    base-uri 'self';
    form-action 'self';
    frame-ancestors 'self';
    connect-src 'self' ${apiSrc} ${oidcSrc};
    upgrade-insecure-requests;
`;
  // Replace newline characters and spaces
  const contentSecurityPolicyHeaderValue = cspHeader
    .replace(/\s{2,}/g, " ")
    .trim();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicyHeaderValue);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders
    }
  });
  response.headers.set("Content-Security-Policy", contentSecurityPolicyHeaderValue);

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" }
      ]
    }
  ]
};

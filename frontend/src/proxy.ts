import { NextRequest, NextResponse } from "next/server";

// Adapted from https://nextjs.org/docs/app/guides/content-security-policy

export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  requestHeaders.set("x-nonce", nonce);

  const isDev = process.env.NODE_ENV === "development";
  const apiUrl = process.env.ISE_RECORD_API_URL;
  const apiSrc = apiUrl ? apiUrl + (apiUrl.endsWith("/") ? "" : "/") : "";

  let oidcSrc = "";

  if(process.env.ISE_RECORD_OIDC_PROVIDER_URL !== undefined) {
    try {
      oidcSrc = new URL(process.env.ISE_RECORD_OIDC_PROVIDER_URL).origin;
    } catch(e) {
      console.error("Malformed OIDC provider URL", e);
    }
  }

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
    frame-src 'self' ${oidcSrc};
    connect-src 'self' ${apiSrc} ${oidcSrc};
    upgrade-insecure-requests;
`;
  // Replace newline characters and spaces
  const contentSecurityPolicyHeaderValue = cspHeader
    .replace(/\s{2,}/g, " ")
    .trim();

  requestHeaders.set("Content-Security-Policy", contentSecurityPolicyHeaderValue);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders
    }
  });
  response.headers.set("Content-Security-Policy", contentSecurityPolicyHeaderValue);

  // Every page except the OIDC callback. The sign-in popup arrives there from the provider's
  // pages, which send no COOP; a COOP here would count as a mismatch, cut the popup off from
  // the app (window.opener null in the popup, popup.closed true in the app), and make
  // popupAbortOnClose throw away sign-ins that just succeeded.
  if(request.nextUrl.pathname !== "/auth/callback") {
    response.headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  }

  if(process.env.ISE_RECORD_OIDC_PROVIDER_URL === undefined) {
    // No need to embed the OIDC provider -> might as well be strict.
    response.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  }
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

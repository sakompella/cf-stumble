/// <reference types="@cloudflare/workers-types" />

/**
 * Cloudflare Access presents the same signed token two ways: the `cf-access-jwt-assertion`
 * header on proxied requests, and the `CF_Authorization` cookie a browser sends when the person
 * is already signed in. A browser navigation cannot set a header, so the owner page needs the
 * cookie. Both carry one token, so this module only locates it; every cryptographic, issuer,
 * audience, expiry, and identity check stays in one place. Neither value is ever logged: this
 * module returns the token to the verifier and removes both forms before anything else runs.
 */

const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";

const ACCESS_COOKIE_NAME = "CF_Authorization";

function isAccessCookie(pair: string): boolean {
  const separator = pair.indexOf("=");
  const name = separator === -1 ? pair : pair.slice(0, separator);

  return name.trim() === ACCESS_COOKIE_NAME;
}

function accessCookieToken(cookieHeader: string | null): string | undefined {
  if (cookieHeader === null) {
    return undefined;
  }

  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");

    if (separator !== -1 && isAccessCookie(pair)) {
      // The value is a JWT, so it needs no cookie decoding; decoding it would change the token.
      return pair.slice(separator + 1).trim();
    }
  }

  return undefined;
}

/**
 * Returns the presented Access token, or `undefined` when the request carries none. The header
 * wins when both arrive, because Access sets it on the request it proxies right now while a
 * cookie may be older.
 */
export function presentedAccessToken(request: Request): string | undefined {
  const asserted = request.headers.get(ACCESS_ASSERTION_HEADER);

  if (asserted !== null && asserted.trim().length > 0) {
    return asserted;
  }

  return accessCookieToken(request.headers.get("cookie"));
}

function cookiesWithoutAccess(cookieHeader: string): string {
  return cookieHeader
    .split(";")
    .filter((cookie) => !isAccessCookie(cookie))
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.length > 0)
    .join("; ");
}

/**
 * Generation code is replaceable and may be broken, so it must never receive a credential it
 * could log or replay. The verified identity is already reduced to the Supervisor name.
 */
export function withoutAccessCredentials(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete(ACCESS_ASSERTION_HEADER);

  const cookieHeader = headers.get("cookie");

  if (cookieHeader !== null) {
    const remaining = cookiesWithoutAccess(cookieHeader);

    if (remaining.length === 0) {
      headers.delete("cookie");
    } else {
      headers.set("cookie", remaining);
    }
  }

  return new Request(request, { headers });
}

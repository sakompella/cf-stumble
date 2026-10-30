import { OWNER_PAGE_SCRIPT_FILE, ownerPageHtml } from "../page/index.js";

/**
 * Every other `GET /` is relayed to the active main facet, and the startup check sends the same
 * request. A browser navigation always sends an explicit `text/html` Accept; a wildcard alone is not
 * enough, so a machine client still gets the relayed response.
 */
function acceptsHtmlDocument(accept: string | null): boolean {
  if (accept === null) {
    return false;
  }

  return accept
    .split(",")
    .some((entry) => (entry.split(";")[0] ?? "").trim().toLowerCase() === "text/html");
}

export function isOwnerPageRequest(request: Request): boolean {
  return (
    request.method === "GET" &&
    new URL(request.url).pathname === "/" &&
    acceptsHtmlDocument(request.headers.get("accept"))
  );
}

/**
 * `script-src 'self'` refuses inline and evaluated code, and a fresh nonce admits only this
 * response's inline style. `no-store` keeps the page out of a shared cache.
 */
function ownerPage(nonce: string): Response {
  return new Response(ownerPageHtml(nonce), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        `default-src 'none'; connect-src 'self'; img-src 'self'; ` +
        `style-src 'nonce-${nonce}'; script-src 'self'; ` +
        `form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * The path names a hash of the bytes, so a browser may keep it for a year; the `no-store` page always
 * names the current one. Any other path goes on to the active generation.
 */
function ownerPageScript(): Response {
  return new Response(OWNER_PAGE_SCRIPT_FILE.source, {
    status: 200,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function isOwnerPageScriptRequest(request: Request): boolean {
  return request.method === "GET" && new URL(request.url).pathname === OWNER_PAGE_SCRIPT_FILE.path;
}

export function ownerPageResponse(
  request: Request,
  nonce = crypto.randomUUID(),
): Response | undefined {
  if (isOwnerPageScriptRequest(request)) {
    return ownerPageScript();
  }

  return isOwnerPageRequest(request) ? ownerPage(nonce) : undefined;
}

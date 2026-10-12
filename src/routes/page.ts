import { OWNER_PAGE_SCRIPT_FILE, ownerPageHtml } from "../page/index.js";

/**
 * The owner page is served for one path and one kind of request: a browser navigation to `GET /`.
 * Every other `GET /` keeps its current behavior, because the Supervisor relays that path to the
 * active main facet and ADR-0029 makes the same request the generation startup check.
 *
 * The test is an explicit `text/html` in the Accept header. A browser navigation always sends it;
 * `curl`, the startup check, and a JSON client do not. `* /*` alone is not enough, so a machine
 * client that accepts anything still receives the relayed response rather than a page.
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
 * The page and the policy that bounds it. `connect-src 'self'` keeps the page's own requests on
 * this origin. `script-src 'self'` admits the page's script file and refuses inline and evaluated
 * code, and a fresh nonce admits only the inline style this response carries. `no-store` keeps a
 * page rendered for one Access session out of a shared cache, and the page itself holds no
 * credential and no identity.
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
 * The page's script. Its path names a hash of its bytes, so a browser may keep it for a year: a
 * changed script gets a new path, and the `no-store` page always names the current one. It holds
 * no identity or credential, which is what makes a shared cache harmless. Only the current path is
 * served here; any other path goes on to the active generation like every other request.
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

/**
 * The owner page or its script for a browser request, and `undefined` for everything else so the
 * caller keeps its current behavior. The Worker calls this only after Cloudflare Access verified
 * the owner, so the script is refused to everyone the page is refused to.
 */
export function ownerPageResponse(
  request: Request,
  nonce = crypto.randomUUID(),
): Response | undefined {
  if (isOwnerPageScriptRequest(request)) {
    return ownerPageScript();
  }

  return isOwnerPageRequest(request) ? ownerPage(nonce) : undefined;
}

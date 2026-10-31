import { OWNER_PAGE_SCRIPT_FILE, ownerPageHtml } from "../page/index.js";

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

  return request.method === "GET" && new URL(request.url).pathname === "/"
    ? ownerPage(nonce)
    : undefined;
}

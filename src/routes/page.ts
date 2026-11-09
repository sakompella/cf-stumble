import {
  OWNER_PAGE_FAVICON,
  OWNER_PAGE_SCRIPT_FILE,
  ownerPageHtml,
  ownerPagePolicy,
} from "../page/index.js";

function ownerPage(nonce: string): Response {
  return new Response(ownerPageHtml(nonce), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": ownerPagePolicy(nonce),
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

function ownerPageFavicon(): Response {
  return new Response(OWNER_PAGE_FAVICON.source, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=86400",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}

function isOwnerPageScriptRequest(request: Request): boolean {
  return request.method === "GET" && new URL(request.url).pathname === OWNER_PAGE_SCRIPT_FILE.path;
}

export function ownerPageResponse(request: Request): Response | undefined {
  if (isOwnerPageScriptRequest(request)) {
    return ownerPageScript();
  }

  if (request.method !== "GET") {
    return undefined;
  }

  switch (new URL(request.url).pathname) {
    case "/":
      return ownerPage(crypto.randomUUID());
    case OWNER_PAGE_FAVICON.path:
      return ownerPageFavicon();
    default:
      return undefined;
  }
}

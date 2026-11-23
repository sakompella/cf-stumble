import {
  OWNER_PAGE_FAVICON,
  OWNER_PAGE_SCRIPT_FILE,
  ownerPageHtml,
  ownerPagePolicy,
  PIERRE_SCRIPT_FILE,
} from "../page/index.js";

const SCRIPT_FILES: ReadonlyMap<string, string> = new Map(
  [OWNER_PAGE_SCRIPT_FILE, PIERRE_SCRIPT_FILE].map(({ path, source }) => [path, source]),
);

const STATIC_ASSET_SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
} as const;

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

function scriptFile(source: string): Response {
  return new Response(source, {
    status: 200,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
      "referrer-policy": "no-referrer",
      ...STATIC_ASSET_SECURITY_HEADERS,
    },
  });
}

function ownerPageFavicon(): Response {
  return new Response(OWNER_PAGE_FAVICON.source, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=86400",
      ...STATIC_ASSET_SECURITY_HEADERS,
    },
  });
}

export function ownerPageResponse(request: Request): Response | undefined {
  if (request.method !== "GET") {
    return undefined;
  }

  const { pathname } = new URL(request.url);
  const script = SCRIPT_FILES.get(pathname);

  if (script !== undefined) {
    return scriptFile(script);
  }

  switch (pathname) {
    case "/":
      return ownerPage(crypto.randomUUID());
    case OWNER_PAGE_FAVICON.path:
      return ownerPageFavicon();
    default:
      return undefined;
  }
}

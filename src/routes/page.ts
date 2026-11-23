import {
  OWNER_PAGE_FAVICON,
  OWNER_PAGE_SCRIPT_FILE,
  ownerPageHtml,
  ownerPagePolicy,
  PIERRE_SCRIPT_PATH,
} from "../page/index.js";

export type PageAssets = Readonly<{ fetch: (request: Request) => Promise<Response> }>;

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

function scriptFile(source: string | ReadableStream<Uint8Array> | null): Response {
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

async function pierreScript(request: Request, assets: PageAssets): Promise<Response> {
  const stored = await assets.fetch(new Request(request.url));

  return stored.ok ? scriptFile(stored.body) : new Response(null, { status: 404 });
}

export function ownerPageResponse(
  request: Request,
  assets: PageAssets,
): Promise<Response> | undefined {
  if (request.method !== "GET") {
    return undefined;
  }

  switch (new URL(request.url).pathname) {
    case "/":
      return Promise.resolve(ownerPage(crypto.randomUUID()));
    case OWNER_PAGE_SCRIPT_FILE.path:
      return Promise.resolve(scriptFile(OWNER_PAGE_SCRIPT_FILE.source));
    case PIERRE_SCRIPT_PATH:
      return pierreScript(request, assets);
    case OWNER_PAGE_FAVICON.path:
      return Promise.resolve(ownerPageFavicon());
    default:
      return undefined;
  }
}

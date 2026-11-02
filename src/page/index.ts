import { OWNER_PAGE_IDS } from "./element-ids.js";
import { OWNER_PAGE_SCRIPT_PATH, OWNER_PAGE_SCRIPT_SOURCE } from "./owner-script.generated.js";
import { OWNER_PAGE_STYLES } from "./styles.js";

export { AgentEvent, AssistantMessage } from "./client/agent-event.js";

export const OWNER_PAGE_SCRIPT_FILE = {
  path: OWNER_PAGE_SCRIPT_PATH,
  source: OWNER_PAGE_SCRIPT_SOURCE,
} as const;

export const OWNER_PAGE_FAVICON = {
  path: "/favicon.svg",
  source:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    '<rect width="32" height="32" rx="6" fill="#5a8cdc"/>' +
    '<path d="M21 10h-8a3 3 0 0 0 0 6h6a3 3 0 0 1 0 6H10" fill="none" stroke="#fff" ' +
    'stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
} as const;

export function ownerPagePolicy(nonce: string): string {
  return [
    "default-src 'none'",
    "connect-src 'self'",
    "img-src 'self'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'self' 'nonce-${nonce}' https://static.cloudflareinsights.com/beacon.min.js/`,
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function ownerPageHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>cf-stumble</title>
<link rel="icon" type="image/svg+xml" href="${OWNER_PAGE_FAVICON.path}" />
<style nonce="${nonce}">${OWNER_PAGE_STYLES}</style>
</head>
<body>
<main id="${OWNER_PAGE_IDS.root}"></main>
<script src="${OWNER_PAGE_SCRIPT_FILE.path}"></script>
</body>
</html>
`;
}

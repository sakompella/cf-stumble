import { OWNER_PAGE_IDS } from "./element-ids.js";
import { OWNER_PAGE_SCRIPT_PATH, OWNER_PAGE_SCRIPT_SOURCE } from "./owner-script.generated.js";
import { OWNER_PAGE_STYLES } from "./styles.js";

export { OWNER_PAGE_ELEMENT_IDS, OWNER_PAGE_IDS } from "./element-ids.js";

/** The path names a hash of the source, so one path always means the same bytes. */
export const OWNER_PAGE_SCRIPT_FILE = {
  path: OWNER_PAGE_SCRIPT_PATH,
  source: OWNER_PAGE_SCRIPT_SOURCE,
} as const;

/**
 * One inline stylesheet and one same-origin script, so the Content Security Policy can refuse every
 * other origin and all inline code. The nonce comes from the route, one per response.
 */
export function ownerPageHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>cf-stumble</title>
<style nonce="${nonce}">${OWNER_PAGE_STYLES}</style>
</head>
<body>
<main id="${OWNER_PAGE_IDS.root}"></main>
<script src="${OWNER_PAGE_SCRIPT_FILE.path}"></script>
</body>
</html>
`;
}

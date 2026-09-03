import { OWNER_PAGE_BODY } from "./markup.js";
import { OWNER_PAGE_SCRIPT } from "./script.js";
import { OWNER_PAGE_STYLES } from "./styles.js";

export {
  commandElementIds,
  COMMAND_ID_PREFIX,
  COMMAND_ID_SUFFIXES,
  OWNER_PAGE_ELEMENT_IDS,
  OWNER_PAGE_IDS,
} from "./element-ids.js";
export type { CommandElementIds, OwnerPageId } from "./element-ids.js";

/**
 * The whole owner page: one HTML document with an inline stylesheet and an inline script and no
 * external asset, so the Content Security Policy the route sends can refuse every other origin.
 * The nonce comes from the route, which makes one per response.
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
${OWNER_PAGE_BODY}
<script nonce="${nonce}">${OWNER_PAGE_SCRIPT}</script>
</body>
</html>
`;
}

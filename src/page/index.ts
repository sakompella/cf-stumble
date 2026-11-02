import { OWNER_PAGE_IDS } from "./element-ids.js";
import { OWNER_PAGE_SCRIPT_PATH, OWNER_PAGE_SCRIPT_SOURCE } from "./owner-script.generated.js";
import { OWNER_PAGE_STYLES } from "./styles.js";

export { AgentEvent, AssistantMessage } from "./client/agent-event.js";

export const OWNER_PAGE_SCRIPT_FILE = {
  path: OWNER_PAGE_SCRIPT_PATH,
  source: OWNER_PAGE_SCRIPT_SOURCE,
} as const;

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

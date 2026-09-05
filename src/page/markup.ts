import { OWNER_PAGE_IDS as ID } from "./element-ids.js";
import { OWNER_PAGE_CONVERSATION } from "./markup-conversation.js";
import { OWNER_PAGE_GENERATION_DRAWER } from "./markup-drawer.js";
import { OWNER_PAGE_SIDEBAR } from "./markup-sidebar.js";

/**
 * The whole document body: a sidebar of connected projects, the conversation, and the generation
 * drawer above it (goal criterion 4, Q4).
 *
 * There is no free-text project field. A project is something the tenant connected, so the page
 * reads `GET /api/projects` and the reader picks from that list; a typed id could only name a
 * project the catalog does not have. There is no raw-JSON panel either: what the page shows is
 * what a reader needs, and a developer reading a payload has the browser's own network tools.
 */
export const OWNER_PAGE_BODY = `  <main id="${ID.root}">
    <header>
      <h1>cf-stumble</h1>
      <p class="note">
        Cloudflare Access already signed you in. This page asks for no credential, stores none, and
        calls only this origin.
      </p>
      <p id="${ID.pageError}"></p>
    </header>${OWNER_PAGE_GENERATION_DRAWER}
    <div id="${ID.layout}">${OWNER_PAGE_SIDEBAR}${OWNER_PAGE_CONVERSATION}
    </div>
  </main>`;

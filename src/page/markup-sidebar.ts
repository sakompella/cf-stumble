import { OWNER_PAGE_IDS as ID } from "./element-ids.js";
import { control, value } from "./markup-fields.js";

/**
 * The left sidebar: what the owner can work in — the connected repositories and the harness
 * checkout — whether the workspace's GitHub authorization works, and how to connect another
 * repository.
 *
 * It collapses because a narrow window has room for one column, and the conversation is the column
 * that matters. The toggle is a button with `aria-expanded`, so the state a sighted reader sees is
 * the state a screen reader and a keyboard reach.
 *
 * No field here takes a token. The owner authorizes at GitHub's own page: this panel shows the
 * verification link and the short code, and the credential goes from GitHub into the workspace
 * without passing through the browser (ADR-0039).
 */
export const OWNER_PAGE_SIDEBAR = `
    <aside id="${ID.sidebar}" aria-label="Projects">
      <div class="sidebar-head">
        <h2>Projects</h2>
        <button id="${ID.sidebarToggle}" type="button" aria-expanded="true" aria-controls="${ID.sidebar}">Hide</button>
      </div>
      <p class="note" id="${ID.projectListStatus}">reading</p>
      <ul id="${ID.projectList}"></ul>
      <div class="sidebar-panel">
        <h3>GitHub</h3>
        ${value("connection", ID.githubState)}
        ${value("detail", ID.githubDetail)}
        <p class="row"><a id="${ID.githubVerificationLink}" href="" rel="noreferrer noopener" target="_blank"></a></p>
        <div class="row">
          <button id="${ID.authorizeButton}" type="button">Authorize GitHub</button>
          <button id="${ID.completeAuthorizationButton}" type="button">I authorized it</button>
        </div>
        <p class="note">
          cf-stumble never asks for a token here. Open the verification link, enter the code at
          GitHub, then use the second button.
        </p>
      </div>
      <div class="sidebar-panel">
        <h3>Connect a repository</h3>
        ${control({
          label: "repository url",
          inputId: ID.connectRepositoryInput,
          inputType: "text",
          buttonId: ID.connectButton,
          buttonText: "Connect",
        })}
        ${value("result", ID.connectStatus)}
      </div>
    </aside>`;

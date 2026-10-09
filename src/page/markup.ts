import { OWNER_PAGE_IDS as ID } from "./element-ids.js";

/*
 * The two shapes every panel on this page is built from: a labelled value a reader observes, and a
 * labelled control row. The sidebar, the conversation, and the generation drawer all use them, so
 * they render the same way without a template engine or a build step.
 */

/** A labelled read-only value. The element with `id` holds only the value a test must read. */
function value(label: string, id: string): string {
  return `<div class="row"><span class="field-label">${label}</span><span class="value" id="${id}"></span></div>`;
}

/** A labelled single-line input followed by the button that acts on it. */
function control(input: {
  readonly label: string;
  readonly inputId: string;
  readonly inputType: string;
  readonly buttonId: string;
  readonly buttonText: string;
}): string {
  const attributes =
    input.inputType === "number"
      ? `type="number" min="0" step="1"`
      : `type="text" autocomplete="off" spellcheck="false"`;

  return `<div class="row">
        <label class="field-label" for="${input.inputId}">${input.label}</label>
        <input id="${input.inputId}" ${attributes} />
        <button id="${input.buttonId}" type="button">${input.buttonText}</button>
      </div>`;
}

/**
 * The conversation column, which is the page's main work.
 *
 * The transcript is an ordered list the turn appends to while it runs (ADR-0037): text as the model
 * produces it, one collapsible block per tool call, and the Supervisor's terminal frame last. The
 * composer sits below it, and the thread facts a reader needs to trust what they see — which
 * project, which revision, whether a turn holds the project — sit above it.
 *
 * Starting a fresh thread is two clicks, never one. It replaces the conversation, and a reader who
 * meant to press "send" should not lose it to a slip. Every repository file survives it (ADR-0038).
 */
const OWNER_PAGE_CONVERSATION = `
    <section id="${ID.conversation}" aria-label="Conversation">
      <div class="conversation-head">
        <h2 id="${ID.conversationProject}">No project selected</h2>
        ${value("thread", ID.conversationState)}
        ${value("revision", ID.threadRevision)}
        ${value("turn active", ID.threadTurnActive)}
        ${value("messages", ID.threadMessageCount)}
      </div>
      <ol id="${ID.messageList}" class="messages"></ol>
      <div class="composer">
        <label class="field-label" for="${ID.promptInput}">prompt</label>
        <textarea id="${ID.promptInput}" rows="3" placeholder="Ask this project's agent to do something. Control-Enter sends."></textarea>
        <div class="row">
          <button id="${ID.sendTurnButton}" type="button">Send turn</button>
          <button id="${ID.cancelTurnButton}" type="button" disabled>Cancel turn</button>
          <button id="${ID.freshThreadButton}" type="button">Start fresh thread</button>
        </div>
        ${value("turn", ID.turnState)}
        ${value("fresh thread", ID.freshThreadStatus)}
        <p class="note">
          A fresh thread replaces this project's conversation and its compacted context. It leaves
          every repository file exactly as it is.
        </p>
      </div>
    </section>`;

/**
 * The left sidebar: what the owner can work in — the connected repositories and the harness
 * checkout — whether the workspace's GitHub authorization works, and how to connect another
 * repository.
 *
 * It collapses because a narrow window has room for one column, and the conversation is the column
 * that matters. The toggle is a button with `aria-expanded`, so the state a sighted reader sees is
 * the state a screen reader and a keyboard reach. It sits above the panel it controls rather than
 * inside it, because a control inside the panel disappears with the panel and leaves no way back.
 *
 * No field here takes a token. The owner authorizes at GitHub's own page: this panel shows the
 * verification link and the short code, and the credential goes from GitHub into the workspace
 * without passing through the browser (ADR-0039).
 */
const OWNER_PAGE_SIDEBAR = `
    <div class="sidebar-column">
      <button id="${ID.sidebarToggle}" type="button" aria-expanded="true" aria-controls="${ID.sidebar}">Hide</button>
      <aside id="${ID.sidebar}" aria-label="Projects">
        <h2>Projects</h2>
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
      </aside>
    </div>`;

/**
 * The generation drawer. The active label and the observed epoch stay visible beside the
 * conversation; submission, activation, and rollback live inside a `<details>` element that is
 * closed by default, so the controls are one click away without taking the reader's attention
 * from the turn (Q4).
 *
 * `<details>` is the whole mechanism: the browser gives it keyboard focus, an accessible expanded
 * state, and no script. Activation and rollback send the epoch this page rendered from
 * `GET /api/status`, so the value a reader sees is the value the request carries (ADR-0033).
 */
const submissionPanel = `
        <div class="drawer-panel">
          <h3>Submit a candidate</h3>
          ${control({
            label: "harness commit",
            inputId: ID.candidateCommitInput,
            inputType: "text",
            buttonId: ID.submitCandidateButton,
            buttonText: "Submit candidate",
          })}
          ${value("result", ID.submitStatus)}
          ${value("labeled generation", ID.submitGenerationLabel)}
          ${value("epoch after labeling", ID.submitEpoch)}
          ${value("preparation check", ID.submitPreparation)}
          <details id="${ID.submitDiagnostics}" hidden>
            <summary>build output</summary>
            <pre class="build-output" tabindex="0" id="${ID.submitDiagnosticsText}"></pre>
          </details>
        </div>`;

function controlPanel(panel: {
  readonly title: string;
  readonly buttonText: string;
  readonly labelInput: string;
  readonly button: string;
  readonly status: string;
  readonly sentEpoch: string;
  readonly effect: string;
}): string {
  return `
        <div class="drawer-panel">
          <h3>${panel.title}</h3>
          ${control({
            label: "generation label",
            inputId: panel.labelInput,
            inputType: "number",
            buttonId: panel.button,
            buttonText: panel.buttonText,
          })}
          ${value("result", panel.status)}
          ${value("epoch sent", panel.sentEpoch)}
          ${value("effect", panel.effect)}
        </div>`;
}

const OWNER_PAGE_GENERATION_DRAWER = `
    <section class="generation-bar" aria-label="Active generation">
      <div class="row">
        ${value("generation", ID.activeGenerationLabel)}
        ${value("epoch", ID.generationEpoch)}
        ${value("status", ID.activeGenerationStatus)}
        <button id="${ID.refreshStatusButton}" type="button">Refresh status</button>
      </div>
      ${value("harness commit", ID.activeGenerationCommit)}
      ${value("last read", ID.statusStatus)}
      <details id="${ID.generationDrawer}">
        <summary>Generation controls</summary>
        ${submissionPanel}
        ${controlPanel({
          title: "Activate a generation",
          buttonText: "Activate",
          labelInput: ID.activateLabelInput,
          button: ID.activateButton,
          status: ID.activateStatus,
          sentEpoch: ID.activateSentEpoch,
          effect: ID.activateEffect,
        })}
        ${controlPanel({
          title: "Roll back to an earlier generation",
          buttonText: "Roll back",
          labelInput: ID.rollbackLabelInput,
          button: ID.rollbackButton,
          status: ID.rollbackStatus,
          sentEpoch: ID.rollbackSentEpoch,
          effect: ID.rollbackEffect,
        })}
      </details>
    </section>`;

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

import { OWNER_PAGE_IDS as ID } from "./element-ids.js";

/** A labelled read-only value. The element with `id` holds only the value a test must read. */
function value(label: string, id: string): string {
  return `<div class="row"><span class="field-label">${label}</span><span class="value" id="${id}"></span></div>`;
}

/** A labelled block for text that may contain newlines, such as a diff or a JSON result. */
function block(label: string, id: string): string {
  return `<div><span class="field-label">${label}</span><pre id="${id}"></pre></div>`;
}

const statusSection = `
    <section>
      <h2>Active generation</h2>
      ${value("generation label", ID.activeGenerationLabel)}
      ${value("harness commit", ID.activeGenerationCommit)}
      ${value("generation status", ID.activeGenerationStatus)}
      ${value("epoch", ID.generationEpoch)}
      ${value("last read", ID.statusStatus)}
      <div class="row"><button id="${ID.refreshStatusButton}" type="button">Refresh status</button></div>
      ${block("status response", ID.statusRaw)}
    </section>`;

const chatSection = `
    <section>
      <h2>Chat</h2>
      <div class="row">
        <label class="field-label" for="${ID.sessionIdInput}">session id</label>
        <input id="${ID.sessionIdInput}" type="text" value="owner-session" autocomplete="off" />
        <button id="${ID.loadSessionButton}" type="button">Load session</button>
      </div>
      ${value("session read", ID.sessionStatus)}
      ${value("session revision", ID.sessionRevision)}
      ${value("turn active", ID.sessionTurnActive)}
      ${block("saved session document", ID.sessionDocument)}
      <div class="row">
        <label class="field-label" for="${ID.chatPromptInput}">message</label>
      </div>
      <textarea id="${ID.chatPromptInput}" autocomplete="off"></textarea>
      <div class="row"><button id="${ID.chatSendButton}" type="button">Send message</button></div>
      ${value("turn result", ID.turnStatus)}
      ${block("assistant reply", ID.chatReply)}
      ${block("diff", ID.turnDiff)}
      <div>
        <span class="field-label">executed commands</span>
        <p class="note" id="${ID.commandsEmpty}">No command ran in the last turn.</p>
        <ol id="${ID.commandList}"></ol>
      </div>
      ${block("turn response", ID.turnRaw)}
    </section>`;

const submissionSection = `
    <section>
      <h2>Submit a generation candidate</h2>
      <div class="row">
        <label class="field-label" for="${ID.candidateCommitInput}">harness commit</label>
        <input id="${ID.candidateCommitInput}" type="text" autocomplete="off" spellcheck="false" />
        <button id="${ID.submitCandidateButton}" type="button">Submit candidate</button>
      </div>
      ${value("submission result", ID.submitStatus)}
      ${value("request id", ID.submitRequestId)}
      ${value("labeled generation", ID.submitGenerationLabel)}
      ${value("epoch after labeling", ID.submitEpoch)}
      ${value("preparation check", ID.submitPreparation)}
      ${block("submission response", ID.submitRaw)}
    </section>`;

/** Activation and rollback read the epoch from the status section, so the sent value is visible. */
type ControlSection = {
  readonly title: string;
  readonly buttonText: string;
  readonly labelInput: string;
  readonly button: string;
  readonly status: string;
  readonly requestId: string;
  readonly sentEpoch: string;
  readonly effect: string;
  readonly raw: string;
};

function controlSection(section: ControlSection): string {
  return `
    <section>
      <h2>${section.title}</h2>
      <div class="row">
        <label class="field-label" for="${section.labelInput}">generation label</label>
        <input id="${section.labelInput}" type="number" min="0" step="1" autocomplete="off" />
        <button id="${section.button}" type="button">${section.buttonText}</button>
      </div>
      ${value("result", section.status)}
      ${value("request id", section.requestId)}
      ${value("epoch sent", section.sentEpoch)}
      ${value("effect", section.effect)}
      ${block("response", section.raw)}
    </section>`;
}

const activateSection = controlSection({
  title: "Activate a generation",
  buttonText: "Activate",
  labelInput: ID.activateLabelInput,
  button: ID.activateButton,
  status: ID.activateStatus,
  requestId: ID.activateRequestId,
  sentEpoch: ID.activateSentEpoch,
  effect: ID.activateEffect,
  raw: ID.activateRaw,
});

const rollbackSection = controlSection({
  title: "Roll back to an earlier generation",
  buttonText: "Roll back",
  labelInput: ID.rollbackLabelInput,
  button: ID.rollbackButton,
  status: ID.rollbackStatus,
  requestId: ID.rollbackRequestId,
  sentEpoch: ID.rollbackSentEpoch,
  effect: ID.rollbackEffect,
  raw: ID.rollbackRaw,
});

const recoverySection = `
    <section>
      <h2>Latest recovery report</h2>
      <p class="note" id="${ID.recoveryNotice}">
        These are recorded facts about the last recovery episode. cf-stumble does not repair a
        generation by itself. Nothing here runs now, and returning to working code is the manual
        rollback above.
      </p>
      <div class="row"><button id="${ID.refreshRecoveryButton}" type="button">Refresh recovery report</button></div>
      ${value("report", ID.recoveryPresence)}
      ${value("report id", ID.recoveryId)}
      ${value("phase", ID.recoveryPhase)}
      ${value("result", ID.recoveryResult)}
      ${value("failed generation", ID.recoveryFailedLabel)}
      ${value("fallback generation", ID.recoveryFallbackLabel)}
      ${value("attempts used", ID.recoveryAttempts)}
      ${value("recorded errors", ID.recoveryErrorCount)}
      ${value("started at", ID.recoveryStartedAt)}
      ${value("awaiting external report", ID.recoveryAwaiting)}
      ${block("recovery response", ID.recoveryRaw)}
    </section>`;

export const OWNER_PAGE_BODY = `  <main id="${ID.root}">
    <h1>cf-stumble</h1>
    <p class="note">
      Cloudflare Access already signed you in. This page asks for no credential, stores none, and
      calls only this origin.
    </p>
    <p id="${ID.pageError}"></p>${statusSection}${chatSection}${submissionSection}${activateSection}${rollbackSection}${recoverySection}
  </main>`;

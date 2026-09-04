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

const threadSection = `
    <section>
      <h2>Project thread</h2>
      <div class="row">
        <label class="field-label" for="${ID.projectIdInput}">project id</label>
        <input id="${ID.projectIdInput}" type="text" value="project-one" autocomplete="off" />
        <button id="${ID.loadThreadButton}" type="button">Load thread</button>
        <button id="${ID.freshThreadButton}" type="button">Start fresh thread</button>
      </div>
      <p class="note">
        A fresh thread replaces this project's conversation. It leaves the project's workspace and
        its files exactly as they are.
      </p>
      ${value("thread read", ID.threadStatus)}
      ${value("project", ID.threadProject)}
      ${value("thread revision", ID.threadRevision)}
      ${value("turn active", ID.threadTurnActive)}
      ${value("messages", ID.threadMessageCount)}
      ${block("thread response", ID.threadRaw)}
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
    <p id="${ID.pageError}"></p>${statusSection}${threadSection}${submissionSection}${activateSection}${rollbackSection}${recoverySection}
  </main>`;

import { OWNER_PAGE_IDS as ID } from "./element-ids.js";
import { control, value } from "./markup-fields.js";

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

export const OWNER_PAGE_GENERATION_DRAWER = `
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

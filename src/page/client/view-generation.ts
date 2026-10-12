import * as Option from "effect/Option";
import type { Html, HtmlBuilder } from "foldkit/html";
import { OWNER_PAGE_IDS as ID } from "../element-ids.js";
import { Message } from "./message.js";
import type { ControlKind, Model } from "./model.js";
import { controlRow, valueRow } from "./view-parts.js";

/**
 * The generation bar. The active label and the observed epoch stay visible beside the
 * conversation; submission, activation, and rollback live inside a `<details>` drawer that is
 * closed by default, so the controls are one click away without taking attention from the turn.
 */

function submissionPanel(model: Model, h: HtmlBuilder<Message>): Html {
  return h.div(
    [h.Class("drawer-panel")],
    [
      h.h3([], ["Submit a candidate"]),
      controlRow(
        {
          label: "harness commit",
          inputId: ID.candidateCommitInput,
          isNumber: false,
          value: model.candidateCommitInput,
          onInput: (value) => Message.UpdatedCandidateCommitInput({ value }),
          buttonId: ID.submitCandidateButton,
          buttonText: "Submit candidate",
          onClick: Message.ClickedSubmitCandidate(),
        },
        h,
      ),
      valueRow("result", ID.submitStatus, model.submitStatus, h),
      valueRow("labeled generation", ID.submitGenerationLabel, model.submitGenerationLabel, h),
      valueRow("epoch after labeling", ID.submitEpoch, model.submitEpoch, h),
      valueRow("preparation check", ID.submitPreparation, model.submitPreparation, h),
      h.details(
        [
          h.Key(`diagnostics-${model.diagnosticsShown}`),
          h.Id(ID.submitDiagnostics),
          h.Hidden(Option.isNone(model.maybeDiagnostics)),
        ],
        [
          h.summary([], ["build output"]),
          h.pre(
            [h.Class("build-output"), h.Tabindex(0), h.Id(ID.submitDiagnosticsText)],
            [Option.getOrElse(model.maybeDiagnostics, () => "")],
          ),
        ],
      ),
    ],
  );
}

const CONTROL_PANELS = {
  activate: {
    title: "Activate a generation",
    buttonText: "Activate",
    labelInput: ID.activateLabelInput,
    button: ID.activateButton,
    status: ID.activateStatus,
    sentEpoch: ID.activateSentEpoch,
    effect: ID.activateEffect,
  },
  rollback: {
    title: "Roll back to an earlier generation",
    buttonText: "Roll back",
    labelInput: ID.rollbackLabelInput,
    button: ID.rollbackButton,
    status: ID.rollbackStatus,
    sentEpoch: ID.rollbackSentEpoch,
    effect: ID.rollbackEffect,
  },
} as const;

function controlPanel(model: Model, kind: ControlKind, h: HtmlBuilder<Message>): Html {
  const ids = CONTROL_PANELS[kind];
  const panel = model[kind];

  return h.div(
    [h.Class("drawer-panel")],
    [
      h.h3([], [ids.title]),
      controlRow(
        {
          label: "generation label",
          inputId: ids.labelInput,
          isNumber: true,
          value: panel.labelInput,
          onInput: (value) => Message.UpdatedControlLabelInput({ kind, value }),
          buttonId: ids.button,
          buttonText: ids.buttonText,
          onClick: Message.ClickedControl({ kind }),
        },
        h,
      ),
      valueRow("result", ids.status, panel.status, h),
      valueRow("epoch sent", ids.sentEpoch, panel.sentEpoch, h),
      valueRow("effect", ids.effect, panel.effect, h),
    ],
  );
}

export function generationBarView(model: Model, h: HtmlBuilder<Message>): Html {
  return h.section(
    [h.Class("generation-bar"), h.AriaLabel("Active generation")],
    [
      h.div(
        [h.Class("row")],
        [
          valueRow("generation", ID.activeGenerationLabel, model.activeGenerationLabel, h),
          valueRow("epoch", ID.generationEpoch, model.generationEpoch, h),
          valueRow("status", ID.activeGenerationStatus, model.activeGenerationStatus, h),
          h.button(
            [
              h.Id(ID.refreshStatusButton),
              h.Type("button"),
              h.OnClick(Message.ClickedRefreshStatus()),
            ],
            ["Refresh status"],
          ),
        ],
      ),
      valueRow("harness commit", ID.activeGenerationCommit, model.activeGenerationCommit, h),
      valueRow("last read", ID.statusStatus, model.statusStatus, h),
      h.details(
        [
          // The reader opens and closes the drawer; the browser owns that state.
          h.Id(ID.generationDrawer),
        ],
        [
          h.summary([], ["Generation controls"]),
          submissionPanel(model, h),
          controlPanel(model, "activate", h),
          controlPanel(model, "rollback", h),
        ],
      ),
    ],
  );
}

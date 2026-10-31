import * as Option from "effect/Option";
import type { Html, HtmlBuilder } from "foldkit/html";
import { OWNER_PAGE_IDS as ID } from "../element-ids.js";
import { Message } from "./message.js";
import {
  ControlRequest,
  StatusRead,
  SubmitRequest,
  type ControlKind,
  type GenerationReading,
  type Model,
} from "./model.js";
import { controlRow, valueRow } from "./view-parts.js";

const NO_SUBMISSION = {
  label: "",
  epoch: "",
  preparation: "",
  maybeDiagnostics: Option.none<string>(),
};

function submissionShown(request: SubmitRequest) {
  return SubmitRequest.match(request, {
    Idle: () => ({ result: "", ...NO_SUBMISSION }),
    Running: () => ({ result: "running", ...NO_SUBMISSION }),
    Succeeded: ({ label, epoch, preparation, maybeDiagnostics }) => ({
      result: "ok",
      label: String(label),
      epoch: String(epoch),
      preparation,
      maybeDiagnostics,
    }),
    Failed: ({ wording }) => ({ result: wording, ...NO_SUBMISSION }),
  });
}

function controlShown(request: ControlRequest) {
  return ControlRequest.match(request, {
    Idle: () => ({ result: "", sentEpoch: "", effect: "" }),
    Running: ({ sentEpoch }) => ({ result: "running", sentEpoch: String(sentEpoch), effect: "" }),
    Succeeded: ({ sentEpoch, effect }) => ({ result: "ok", sentEpoch: String(sentEpoch), effect }),
    Failed: ({ maybeSentEpoch, wording }) => ({
      result: wording,
      sentEpoch: Option.match(maybeSentEpoch, { onNone: () => "", onSome: String }),
      effect: "",
    }),
  });
}

function readingShown(maybeReading: Option.Option<GenerationReading>) {
  return Option.match(maybeReading, {
    onNone: () => ({ label: "", commit: "", status: "", epoch: "" }),
    onSome: ({ maybeActive, epoch }) =>
      Option.match(maybeActive, {
        onNone: () => ({
          label: "none",
          commit: "none",
          status: "none active",
          epoch: String(epoch),
        }),
        onSome: (active) => ({
          label: String(active.label),
          commit: active.harnessCommit,
          status: active.status,
          epoch: String(epoch),
        }),
      }),
  });
}

function statusReadWording(read: StatusRead): string {
  return StatusRead.match(read, {
    Running: () => "reading",
    Succeeded: () => "ok",
    Failed: ({ wording }) => wording,
  });
}

function submissionPanel(model: Model, h: HtmlBuilder<Message>): Html {
  const shown = submissionShown(model.submit);

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
      valueRow("result", ID.submitStatus, shown.result, h),
      valueRow("labeled generation", ID.submitGenerationLabel, shown.label, h),
      valueRow("epoch after labeling", ID.submitEpoch, shown.epoch, h),
      valueRow("preparation check", ID.submitPreparation, shown.preparation, h),
      h.details(
        [
          h.Key(`diagnostics-${model.diagnosticsShown}`),
          h.Id(ID.submitDiagnostics),
          h.Hidden(Option.isNone(shown.maybeDiagnostics)),
        ],
        [
          h.summary([], ["build output"]),
          h.pre(
            [h.Class("build-output"), h.Tabindex(0), h.Id(ID.submitDiagnosticsText)],
            [Option.getOrElse(shown.maybeDiagnostics, () => "")],
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
  const shown = controlShown(panel.request);

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
      valueRow("result", ids.status, shown.result, h),
      valueRow("epoch sent", ids.sentEpoch, shown.sentEpoch, h),
      valueRow("effect", ids.effect, shown.effect, h),
    ],
  );
}

function detailsView(model: Model, h: HtmlBuilder<Message>): Html {
  const reading = readingShown(model.maybeReading);

  return h.details(
    [h.Class("details")],
    [
      h.summary([], ["Details"]),
      valueRow("epoch", ID.generationEpoch, reading.epoch, h),
      valueRow("harness commit", ID.activeGenerationCommit, reading.commit, h),
      valueRow("last read", ID.statusStatus, statusReadWording(model.statusRead), h),
      valueRow("run active", ID.threadRunActive, model.conversation.isRunning ? "yes" : "no", h),
      valueRow("queued", ID.threadQueued, String(model.conversation.inbox.length), h),
      valueRow("entries", ID.threadMessageCount, String(model.conversation.entries.length), h),
    ],
  );
}

export function generationBarView(model: Model, h: HtmlBuilder<Message>): Html {
  const reading = readingShown(model.maybeReading);

  return h.section(
    [h.Class("generation-bar"), h.AriaLabel("Active generation")],
    [
      h.p(
        [h.Class("status-line")],
        [
          "generation ",
          h.span([h.Class("value"), h.Id(ID.activeGenerationLabel)], [reading.label]),
          " · ",
          h.span([h.Class("value"), h.Id(ID.activeGenerationStatus)], [reading.status]),
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
      detailsView(model, h),
      h.details(
        [h.Id(ID.generationDrawer)],
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

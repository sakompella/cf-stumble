import * as Option from "effect/Option";
import { RunControl, SubmitCandidate } from "./commands.js";
import type { ControlKind, ControlPanel, Model } from "./model.js";
import {
  clearError,
  refreshStatus,
  withError,
  type Handlers,
  type UpdateReturn,
} from "./update-shared.js";

/**
 * The generation drawer: submit a harness commit, activate a generation, and roll back.
 * Activation and rollback send the epoch the status read reported and the page rendered, so the
 * value a reader sees is the value the request carries (ADR-0033).
 */

function wholeNumber(value: number): Option.Option<number> {
  return Number.isSafeInteger(value) && value >= 0 ? Option.some(value) : Option.none();
}

/**
 * A generation label names one whole generation. "1.5" names none, and `Number.parseInt` would
 * read it as 1 and send a command the reader never asked for.
 */
export function controlLabel(raw: string): Option.Option<number> {
  const trimmed = raw.trim();

  return trimmed === "" ? Option.none() : wholeNumber(Number(trimmed));
}

function withPanel(model: Model, kind: ControlKind, change: Partial<ControlPanel>): Model {
  return kind === "activate"
    ? { ...model, activate: { ...model.activate, ...change } }
    : { ...model, rollback: { ...model.rollback, ...change } };
}

function runControl(model: Model, kind: ControlKind): UpdateReturn {
  const cleared = clearError(model);
  const panel = kind === "activate" ? model.activate : model.rollback;
  // The epoch comes from what the page rendered, never a guess.
  const maybeEpoch = controlLabel(model.generationEpoch);

  if (Option.isNone(maybeEpoch)) {
    return { model: withPanel(cleared, kind, { status: "refresh the status first" }) };
  }

  const maybeLabel = controlLabel(panel.labelInput);

  if (Option.isNone(maybeLabel)) {
    return { model: withPanel(cleared, kind, { status: "enter a generation label" }) };
  }

  return {
    model: withPanel(cleared, kind, { sentEpoch: String(maybeEpoch.value), status: "running" }),
    commands: [RunControl({ kind, observedEpoch: maybeEpoch.value, label: maybeLabel.value })],
  };
}

function submit(model: Model): UpdateReturn {
  const cleared = clearError(model);
  const harnessCommit = model.candidateCommitInput.trim();

  if (harnessCommit === "") {
    return { model: { ...cleared, submitStatus: "enter a harness commit first" } };
  }

  return {
    model: {
      ...cleared,
      submitStatus: "running",
      maybeDiagnostics: Option.none(),
      diagnosticsShown: model.diagnosticsShown + 1,
    },
    commands: [SubmitCandidate({ harnessCommit })],
  };
}

export function statusHandlers(
  model: Model,
): Handlers<
  "ClickedRefreshStatus" | "SucceededFetchStatus" | "RejectedFetchStatus" | "FailedFetchStatus"
> {
  return {
    ClickedRefreshStatus: () => refreshStatus(model),
    SucceededFetchStatus: ({ label, commit, status, epoch }) => ({
      model: {
        ...model,
        activeGenerationLabel: label,
        activeGenerationCommit: commit,
        activeGenerationStatus: status,
        generationEpoch: epoch,
        statusStatus: "ok",
      },
    }),
    RejectedFetchStatus: ({ wording }) => ({ model: { ...model, statusStatus: wording } }),
    FailedFetchStatus: ({ detail }) => ({
      model: { ...withError(model, "the status request", detail), statusStatus: "request failed" },
    }),
  };
}

export function submitHandlers(
  model: Model,
): Handlers<
  | "UpdatedCandidateCommitInput"
  | "ClickedSubmitCandidate"
  | "SucceededSubmit"
  | "RejectedSubmit"
  | "FailedSubmit"
> {
  return {
    UpdatedCandidateCommitInput: ({ value }) => ({
      model: { ...model, candidateCommitInput: value },
    }),
    ClickedSubmitCandidate: () => submit(model),
    SucceededSubmit: ({ label, epoch, preparation, maybeDiagnostics }) =>
      refreshStatus({
        ...model,
        submitStatus: "ok",
        submitGenerationLabel: label,
        submitEpoch: epoch,
        submitPreparation: preparation,
        maybeDiagnostics,
        diagnosticsShown: model.diagnosticsShown + 1,
      }),
    RejectedSubmit: ({ wording }) =>
      refreshStatus({
        ...model,
        submitStatus: wording,
        maybeDiagnostics: Option.none(),
        diagnosticsShown: model.diagnosticsShown + 1,
      }),
    FailedSubmit: ({ detail }) => ({
      model: {
        ...withError(model, "the submission request", detail),
        submitStatus: "request failed",
        maybeDiagnostics: Option.none(),
        diagnosticsShown: model.diagnosticsShown + 1,
      },
    }),
  };
}

export function controlHandlers(
  model: Model,
): Handlers<
  | "UpdatedControlLabelInput"
  | "ClickedControl"
  | "SucceededControl"
  | "RejectedControl"
  | "FailedControl"
> {
  return {
    UpdatedControlLabelInput: ({ kind, value }) => ({
      model: withPanel(model, kind, { labelInput: value }),
    }),
    ClickedControl: ({ kind }) => runControl(model, kind),
    SucceededControl: ({ kind, effect }) =>
      refreshStatus(withPanel(model, kind, { status: "ok", effect })),
    RejectedControl: ({ kind, wording }) =>
      refreshStatus(withPanel(model, kind, { status: wording, effect: "" })),
    FailedControl: ({ kind, detail }) => ({
      model: withPanel(withError(model, `the ${kind} request`, detail), kind, {
        status: "request failed",
      }),
    }),
  };
}

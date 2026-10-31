import * as Option from "effect/Option";
import { RunControl, SubmitCandidate } from "./commands.js";
import {
  ControlRequest,
  StatusRead,
  SubmitRequest,
  type ControlKind,
  type ControlPanel,
  type Model,
} from "./model.js";
import {
  clearError,
  refreshStatus,
  withError,
  type Handlers,
  type UpdateReturn,
} from "./update-shared.js";

function wholeNumber(value: number): Option.Option<number> {
  return Number.isSafeInteger(value) && value >= 0 ? Option.some(value) : Option.none();
}

export function controlLabel(raw: string): Option.Option<number> {
  const trimmed = raw.trim();

  return trimmed === "" ? Option.none() : wholeNumber(Number(trimmed));
}

function withPanel(model: Model, kind: ControlKind, change: Partial<ControlPanel>): Model {
  return kind === "activate"
    ? { ...model, activate: { ...model.activate, ...change } }
    : { ...model, rollback: { ...model.rollback, ...change } };
}

function notSent(wording: string): ControlRequest {
  return ControlRequest.Failed({ maybeSentEpoch: Option.none(), wording });
}

function sentFailure(sentEpoch: number, wording: string): ControlRequest {
  return ControlRequest.Failed({ maybeSentEpoch: Option.some(sentEpoch), wording });
}

function runControl(model: Model, kind: ControlKind): UpdateReturn {
  const cleared = clearError(model);
  const panel = kind === "activate" ? model.activate : model.rollback;
  const maybeEpoch = Option.map(model.maybeReading, (reading) => reading.epoch);

  if (Option.isNone(maybeEpoch)) {
    return { model: withPanel(cleared, kind, { request: notSent("refresh the status first") }) };
  }

  const maybeLabel = controlLabel(panel.labelInput);

  if (Option.isNone(maybeLabel)) {
    return { model: withPanel(cleared, kind, { request: notSent("enter a generation label") }) };
  }

  return {
    model: withPanel(cleared, kind, {
      request: ControlRequest.Running({ sentEpoch: maybeEpoch.value }),
    }),
    commands: [RunControl({ kind, observedEpoch: maybeEpoch.value, label: maybeLabel.value })],
  };
}

function submit(model: Model): UpdateReturn {
  const cleared = clearError(model);
  const harnessCommit = model.candidateCommitInput.trim();

  if (harnessCommit === "") {
    return {
      model: {
        ...cleared,
        submit: SubmitRequest.Failed({ wording: "enter a harness commit first" }),
      },
    };
  }

  return {
    model: {
      ...cleared,
      submit: SubmitRequest.Running(),
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
    SucceededFetchStatus: ({ reading }) => ({
      model: { ...model, maybeReading: Option.some(reading), statusRead: StatusRead.Succeeded() },
    }),
    RejectedFetchStatus: ({ wording }) => ({
      model: { ...model, statusRead: StatusRead.Failed({ wording }) },
    }),
    FailedFetchStatus: ({ detail }) => ({
      model: {
        ...withError(model, "the status request", detail),
        statusRead: StatusRead.Failed({ wording: "request failed" }),
      },
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
        submit: SubmitRequest.Succeeded({ label, epoch, preparation, maybeDiagnostics }),
        diagnosticsShown: model.diagnosticsShown + 1,
      }),
    RejectedSubmit: ({ wording }) =>
      refreshStatus({
        ...model,
        submit: SubmitRequest.Failed({ wording }),
        diagnosticsShown: model.diagnosticsShown + 1,
      }),
    FailedSubmit: ({ detail }) => ({
      model: {
        ...withError(model, "the submission request", detail),
        submit: SubmitRequest.Failed({ wording: "request failed" }),
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
    SucceededControl: ({ kind, sentEpoch, effect }) =>
      refreshStatus(
        withPanel(model, kind, { request: ControlRequest.Succeeded({ sentEpoch, effect }) }),
      ),
    RejectedControl: ({ kind, sentEpoch, wording }) =>
      refreshStatus(withPanel(model, kind, { request: sentFailure(sentEpoch, wording) })),
    FailedControl: ({ kind, sentEpoch, detail }) => ({
      model: withPanel(withError(model, `the ${kind} request`, detail), kind, {
        request: sentFailure(sentEpoch, "request failed"),
      }),
    }),
  };
}

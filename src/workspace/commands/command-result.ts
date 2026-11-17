import * as Effect from "effect/Effect";
import { isRetryableFailure, isTimeoutFailure, logRedactedCause } from "../../diagnostics.js";
import {
  answerFailures,
  WorkspaceSyncIncomplete,
  type CommandOutput,
  type WorkspaceEffects,
  type WorkspaceFault,
} from "../operations.js";

export type WorkspacePlan = Readonly<{
  kind: "run-command";
  source: string;
  cwd: string;
  timeoutMs: number;
}>;

type WorkspaceFailureCode =
  | "invalid-request"
  | "path-outside-root"
  | "workspace-unavailable"
  | "workspace-restarted"
  | "workspace-busy"
  | "workspace-sync-incomplete";

export type WorkspaceFailure = Readonly<{
  ok: false;
  error: Readonly<{ code: WorkspaceFailureCode }>;
}>;

export type CommandAnswer = Readonly<{ ok: true; output: CommandOutput }> | WorkspaceFailure;

export type ModuleMapAnswer =
  | Readonly<{ ok: true; moduleMap: string }>
  | Readonly<{ ok: false; error: Readonly<{ code: "publish-failed"; output: CommandOutput }> }>
  | WorkspaceFailure;

export type InstructionsWriteResult =
  | Readonly<{ ok: true; result: Readonly<{ kind: "written" }> }>
  | WorkspaceFailure;

export function invalidRequest(): WorkspaceFailure {
  return { ok: false, error: { code: "invalid-request" } };
}

export function syncIncomplete(): WorkspaceFailure {
  return { ok: false, error: { code: "workspace-sync-incomplete" } };
}

function unavailable(): WorkspaceFailure {
  return { ok: false, error: { code: "workspace-unavailable" } };
}

function restarted(): WorkspaceFailure {
  return { ok: false, error: { code: "workspace-restarted" } };
}

export function commandAnswer(output: CommandOutput): CommandAnswer {
  return { ok: true, output };
}

export function executePlan(
  operations: WorkspaceEffects,
  plan: WorkspacePlan,
): Effect.Effect<CommandAnswer, WorkspaceFault> {
  return operations
    .runCommand(plan.source, plan.cwd, plan.timeoutMs)
    .pipe(Effect.map(commandAnswer));
}

export function timeoutOrUnavailable(cause: unknown): string {
  return isTimeoutFailure(cause) ? "timeout" : "workspace-unavailable";
}

type AnswerFailures = <Answer>(
  work: Effect.Effect<Answer | WorkspaceFailure, WorkspaceFault>,
) => Effect.Effect<Answer | WorkspaceFailure>;

function answerWith(failure: (cause: unknown) => WorkspaceFailure): AnswerFailures {
  return function answer<Answer>(work: Effect.Effect<Answer | WorkspaceFailure, WorkspaceFault>) {
    return answerFailures<Answer | WorkspaceFailure>(failure)(work);
  };
}

export function answerDurableFailures(
  context: string,
  unavailableLabel: (cause: unknown) => string,
): AnswerFailures {
  return answerWith((cause) => {
    if (cause instanceof WorkspaceSyncIncomplete) {
      logRedactedCause(`${context}: sync-incomplete`, cause);

      return syncIncomplete();
    }

    logRedactedCause(`${context}: ${unavailableLabel(cause)}`, cause);

    return unavailable();
  });
}

export function answerUnavailable(context: string): AnswerFailures {
  return answerWith((cause) => {
    if (isRetryableFailure(cause)) {
      logRedactedCause(`${context}: workspace-restarted`, cause);

      return restarted();
    }

    logRedactedCause(`${context}: ${timeoutOrUnavailable(cause)}`, cause);

    return unavailable();
  });
}

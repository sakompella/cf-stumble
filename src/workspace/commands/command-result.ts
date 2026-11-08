import * as Effect from "effect/Effect";
import { isTimeoutFailure, logRedactedCause } from "../../diagnostics.js";
import {
  answerFailures,
  runPlannedCommand,
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

export type WorkspaceFailure = Readonly<{
  ok: false;
  error: Readonly<{
    code:
      | "invalid-request"
      | "path-outside-root"
      | "unknown-command"
      | "workspace-unavailable"
      | "workspace-busy"
      | "workspace-sync-incomplete";
  }>;
}>;

export type WorkspaceCommandResult =
  | Readonly<{
      ok: true;
      result: Readonly<{
        kind: "command";
        stdout: string;
        stderr: string;
        exitCode: number;
      }>;
    }>
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

export function commandResult(output: CommandOutput): WorkspaceCommandResult {
  return {
    ok: true,
    result: {
      kind: "command",
      stdout: output.stdout,
      stderr: output.stderr,
      exitCode: output.exitCode,
    },
  };
}

export function executePlan(
  operations: WorkspaceEffects,
  plan: WorkspacePlan,
): Effect.Effect<WorkspaceCommandResult, WorkspaceFault> {
  return runPlannedCommand(operations, plan).pipe(Effect.map(commandResult));
}

export function timeoutOrUnavailable(cause: unknown): string {
  return isTimeoutFailure(cause) ? "timeout" : "workspace-unavailable";
}

export function answerDurableFailures(
  context: string,
  unavailableLabel: (cause: unknown) => string,
): (
  work: Effect.Effect<WorkspaceCommandResult, WorkspaceFault>,
) => Effect.Effect<WorkspaceCommandResult> {
  return answerFailures<WorkspaceCommandResult>((cause) => {
    if (cause instanceof WorkspaceSyncIncomplete) {
      logRedactedCause(`${context}: sync-incomplete`, cause);

      return syncIncomplete();
    }

    logRedactedCause(`${context}: ${unavailableLabel(cause)}`, cause);

    return unavailable();
  });
}

export function answerUnavailable(
  context: string,
): (
  work: Effect.Effect<WorkspaceCommandResult, WorkspaceFault>,
) => Effect.Effect<WorkspaceCommandResult> {
  return answerFailures<WorkspaceCommandResult>((cause) => {
    logRedactedCause(`${context}: ${timeoutOrUnavailable(cause)}`, cause);

    return unavailable();
  });
}

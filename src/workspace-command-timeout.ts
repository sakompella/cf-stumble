import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export const WORKSPACE_COMMAND_TIMEOUT_MS = 900_000;

export const WORKSPACE_SHORT_COMMAND_TIMEOUT_MS = 60_000;

const WORKSPACE_RPC_TIMEOUT_MARGIN_MS = 1_000;

export const WORKSPACE_RPC_TIMEOUT_MS =
  WORKSPACE_COMMAND_TIMEOUT_MS + WORKSPACE_RPC_TIMEOUT_MARGIN_MS;

export const WORKSPACE_SHORT_RPC_TIMEOUT_MS =
  WORKSPACE_SHORT_COMMAND_TIMEOUT_MS + WORKSPACE_RPC_TIMEOUT_MARGIN_MS;

export class WorkspaceRpcRejected extends Data.TaggedError("WorkspaceRpcRejected")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

export type WorkspaceRpcFailure = Cause.TimeoutError | WorkspaceRpcRejected;

export function isRpcTimeout(failure: WorkspaceRpcFailure): boolean {
  return Cause.isTimeoutError(failure);
}

export function boundedRpc<T>(
  run: () => Promise<T>,
  timeoutMs: number,
): Effect.Effect<T, WorkspaceRpcFailure> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new WorkspaceRpcRejected({ cause }),
  }).pipe(Effect.timeout(timeoutMs));
}

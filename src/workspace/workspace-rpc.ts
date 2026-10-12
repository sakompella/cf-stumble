import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { classifyWorkspaceAnswer, timedWorkspaceRpc, type LogFields } from "../diagnostics.js";

/** A Supervisor-side Workspace Host RPC rejected or timed out. `cause` is what it threw. */
export class WorkspaceRpcFailed extends Data.TaggedError("WorkspaceRpcFailed")<{
  readonly cause: unknown;
}> {}

type WorkspaceAnswer =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; error: Readonly<{ code: string }> }>;

/**
 * One measured Workspace Host RPC from the Supervisor, as an Effect. It is `timedWorkspaceRpc`
 * with its rejection typed: the timing, the waiting warnings, and the timeout are that function's.
 */
export function workspaceRpc<A extends WorkspaceAnswer>(
  fields: LogFields,
  call: () => Promise<A>,
  timeoutMs: number,
): Effect.Effect<A, WorkspaceRpcFailed> {
  return Effect.tryPromise({
    try: () => timedWorkspaceRpc(fields, call, classifyWorkspaceAnswer, timeoutMs),
    catch: (cause) => new WorkspaceRpcFailed({ cause }),
  });
}

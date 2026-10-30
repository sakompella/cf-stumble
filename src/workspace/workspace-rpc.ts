import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { boundedRpc } from "../workspace-command-timeout.js";

/** A Supervisor-side Workspace Host RPC rejected or timed out. `cause` is what it threw. */
export class WorkspaceRpcFailed extends Data.TaggedError("WorkspaceRpcFailed")<{
  readonly cause: unknown;
}> {}

/** {@link boundedRpc} as an Effect, with its rejection typed. */
export function workspaceRpc<A>(
  call: () => Promise<A>,
  timeoutMs: number,
): Effect.Effect<A, WorkspaceRpcFailed> {
  return Effect.tryPromise({
    try: () => boundedRpc(call, timeoutMs),
    catch: (cause) => new WorkspaceRpcFailed({ cause }),
  });
}

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { boundedRpc } from "../workspace-command-timeout.js";

export class WorkspaceRpcFailed extends Data.TaggedError("WorkspaceRpcFailed")<{
  readonly cause: unknown;
}> {}

export function workspaceRpc<A>(
  call: () => Promise<A>,
  timeoutMs: number,
): Effect.Effect<A, WorkspaceRpcFailed> {
  return Effect.tryPromise({
    try: () => boundedRpc(call, timeoutMs),
    catch: (cause) => new WorkspaceRpcFailed({ cause }),
  });
}

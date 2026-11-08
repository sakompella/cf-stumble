import * as Effect from "effect/Effect";

export const WORKSPACE_COMMAND_TIMEOUT_MS = 900_000;

export const WORKSPACE_SHORT_COMMAND_TIMEOUT_MS = 60_000;

const WORKSPACE_RPC_TIMEOUT_MARGIN_MS = 1_000;

export const WORKSPACE_RPC_TIMEOUT_MS =
  WORKSPACE_COMMAND_TIMEOUT_MS + WORKSPACE_RPC_TIMEOUT_MARGIN_MS;

export const WORKSPACE_SHORT_RPC_TIMEOUT_MS =
  WORKSPACE_SHORT_COMMAND_TIMEOUT_MS + WORKSPACE_RPC_TIMEOUT_MARGIN_MS;

export function boundedRpc<T>(run: () => Promise<T>, timeoutMs: number): Effect.Effect<T, unknown> {
  return Effect.tryPromise({ try: run, catch: (cause) => cause }).pipe(Effect.timeout(timeoutMs));
}

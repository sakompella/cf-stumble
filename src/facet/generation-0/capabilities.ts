import type { ModelRouteRequest, ValidationFailure } from "../../model-route.js";

/**
 * Resolves a Promise because this capability crosses a Worker RPC hop; the stream still yields
 * events as they arrive rather than after the whole turn.
 */
export type ModelCapability = Readonly<{
  runStream(request: ModelRouteRequest): Promise<ReadableStream<Uint8Array> | ValidationFailure>;
}>;

export type Generation0Capabilities = Readonly<{
  MODEL: ModelCapability;
}>;

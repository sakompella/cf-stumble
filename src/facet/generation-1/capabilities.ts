import type { ModelRouteRequest, ValidationFailure } from "../../model-route.js";

export type ModelCapability = Readonly<{
  runStream(request: ModelRouteRequest): Promise<ReadableStream<Uint8Array> | ValidationFailure>;
}>;

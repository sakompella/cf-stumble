import type { ModelRouteRequest, ValidationFailure } from "../../model-route-request.js";

export type ModelCapability = Readonly<{
  runStream(request: ModelRouteRequest): Promise<ReadableStream<Uint8Array> | ValidationFailure>;
}>;

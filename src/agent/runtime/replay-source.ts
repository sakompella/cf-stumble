import type { ReplayRuntime } from "../../replay/index.js";
import type { ModelResponseSource } from "./model.js";

/** Adapt the replay runner's no-network tape to the runtime's source interface. */
export function recordedSourceFromReplayRuntime(
  runtime: Pick<ReplayRuntime, "requestModel">,
): ModelResponseSource {
  return {
    requestModel: (request) => runtime.requestModel({ requestId: request.requestId }),
  };
}

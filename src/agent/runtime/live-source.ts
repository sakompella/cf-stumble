import { isJsonObjectValue, isJsonValue, type JsonValue } from "../../json.js";
import { ModelSourceError } from "./model-errors.js";
import type {
  AgentModelRequest,
  ModelProvider,
  ModelResponseSource,
} from "./model.js";
import type { RecordedModelResponse } from "../../replay/schema.js";

/** A model source whose provider is deliberately injected by the caller. */
export class LiveModelResponseSource implements ModelResponseSource {
  private readonly provider: ModelProvider;

  constructor(provider: ModelProvider) {
    this.provider = provider;
  }

  async requestModel(request: AgentModelRequest): Promise<RecordedModelResponse> {
    let raw: JsonValue;
    try {
      const provided = await this.provider(request);
      if (!isJsonValue(provided)) {
        throw new TypeError("provider returned a non-JSON value");
      }
      raw = provided;
    } catch (error) {
      throw new ModelSourceError("error", "live model provider failed", error);
    }

    if (isString(raw)) {
      return { requestId: request.requestId, content: raw };
    }
    if (!isJsonObjectValue(raw) || !isString(raw.content)) {
      throw new ModelSourceError("error", "live model provider returned a response without string content");
    }
    let requestId = request.requestId;
    if ("requestId" in raw) {
      if (raw.requestId !== undefined && !isString(raw.requestId)) {
        throw new ModelSourceError("error", "live model provider returned an invalid request id");
      }
      if (isString(raw.requestId)) {
        requestId = raw.requestId;
      }
    }
    if (requestId !== request.requestId) {
      throw new ModelSourceError(
        "error",
        `live model provider returned response for ${JSON.stringify(requestId)}, expected ${JSON.stringify(request.requestId)}`,
      );
    }
    return { requestId, content: raw.content };
  }
}

function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

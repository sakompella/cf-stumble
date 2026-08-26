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
    let raw: unknown;
    try {
      raw = await this.provider(request);
    } catch (error: unknown) {
      throw new ModelSourceError("error", "live model provider failed", error);
    }

    if (typeof raw === "string") {
      return { requestId: request.requestId, content: raw };
    }
    if (!isRecord(raw) || typeof raw.content !== "string") {
      throw new ModelSourceError("error", "live model provider returned a response without string content");
    }
    let requestId = request.requestId;
    if ("requestId" in raw) {
      if (raw.requestId !== undefined && typeof raw.requestId !== "string") {
        throw new ModelSourceError("error", "live model provider returned an invalid request id");
      }
      if (typeof raw.requestId === "string") {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

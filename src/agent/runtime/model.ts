import type { AgentDefinition } from "./definition.js";
import type { PrimitiveResult } from "../../replay/schema.js";
import type { RecordedModelResponse } from "../../replay/schema.js";

export const DEFAULT_MODEL_REQUEST_ID = "executor";

export type AgentModelRequest = {
  readonly requestId: string;
  readonly input: string;
  readonly definition: AgentDefinition;
  /** Successful primitive results from this turn, in call order. */
  readonly toolResults: readonly PrimitiveResult[];
};

export type ModelResponseSource = {
  requestModel(request: AgentModelRequest): Promise<RecordedModelResponse>;
};

export type ModelProvider = (
  request: AgentModelRequest,
) => LiveModelResponse | Promise<LiveModelResponse>;

export type LiveModelResponse = string | { readonly content: string; readonly requestId?: string };

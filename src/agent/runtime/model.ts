import type { AgentDefinition } from "./definition.js";
import type { PrimitiveResult } from "../../replay/schema.js";
import type { RecordedModelResponse } from "../../replay/schema.js";

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

export type ModelProvider = (request: AgentModelRequest) => unknown;

export type LiveModelResponse = string | { readonly content: string; readonly requestId?: string };
